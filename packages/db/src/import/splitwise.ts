/**
 * Loading a Splitwise CSV export into a Waves group (server side).
 *
 * This is the write-path companion to the pure parser in
 * `@waves/core` (`importSplitwiseCsv`): that one answers "what does this file
 * mean", this one answers "put it in the database". They share the same honest
 * premise (TDR §10, ADR-012) — a Splitwise export carries only each person's
 * **net** for a row (what they paid minus what they owed), so:
 *
 *   - balances are recovered exactly, to the paisa, and that is provable;
 *   - who paid is a deterministic *reconstruction*, not the truth from the
 *     original group. Anyone whose net was positive is treated as having paid,
 *     in proportion to that net (see {@link reconstruct}).
 *
 * What this module adds over the core parser is the two things the database
 * cares about that the core parser does not model:
 *
 *   1. **Settlements vs expenses.** A `Category == "Payment"` row is a payment
 *      from one member to another ("Hethu paid Madan D."), not a shared cost.
 *      It becomes a `settlements` row, never an `expenses` one — otherwise the
 *      history would show a dinner that never happened.
 *   2. **A real category.** `guessCategory(description)` maps the free-text
 *      description onto the app's ten-category system (TDR §8), falling back to
 *      null when nothing matches — the same "machine proposes" bargain the app
 *      makes everywhere else.
 *
 * The actual insert reuses the canonical `baaki_import_ledger` RPC — the exact
 * function the app's own import path calls — so ghosts, idempotency, the
 * append-only version rows, the Σpayers = Σshares = amount constraint and the
 * derived-balance triggers are all exercised the way production exercises them,
 * rather than reproduced (and allowed to drift) here.
 *
 * Money is parsed digit by digit via `parseCsvAmount` (ADR-003). A CSV of
 * somebody's entire trip is precisely where a float quietly loses a paisa per
 * row and only shows up as a balance that will not settle.
 */

import { type CurrencyCode, guessCategory, parseCsvAmount, parseCsvRow } from '@waves/core';

// ── parse result ────────────────────────────────────────────────────────────

export enum SplitwiseRowKind {
  Expense = 'expense',
  Settlement = 'settlement',
}

export enum SplitwiseProblemKind {
  UnparseableRow = 'unparseable_row',
  RowDoesNotBalance = 'row_does_not_balance',
  UnexpectedSettlement = 'unexpected_settlement',
  DuplicatePerson = 'duplicate_person',
  NonPositiveCost = 'non_positive_cost',
  NoPeople = 'no_people',
  NoRows = 'no_rows',
}

export interface SplitwiseProblem {
  readonly kind: SplitwiseProblemKind;
  /** 1-based line in the file, as a spreadsheet numbers it. Null for file-level problems. */
  readonly row: number | null;
  readonly message: string;
}

export interface ParsedExpense {
  readonly kind: SplitwiseRowKind.Expense;
  readonly row: number;
  readonly description: string;
  /** The app category guessed from the description (TDR §8), or null. */
  readonly category: string | null;
  /** The category string exactly as Splitwise wrote it (e.g. "Plane"), or null. */
  readonly rawCategory: string | null;
  /** ISO date, YYYY-MM-DD. */
  readonly date: string;
  readonly currency: CurrencyCode;
  /** Total, in minor units. */
  readonly amount: bigint;
  /** Reconstructed: who is treated as having paid, keyed by name. Sums to `amount`. */
  readonly payers: Readonly<Record<string, bigint>>;
  /** Exactly what each person owed, keyed by name. Sums to `amount`. */
  readonly shares: Readonly<Record<string, bigint>>;
}

export interface ParsedSettlement {
  readonly kind: SplitwiseRowKind.Settlement;
  readonly row: number;
  readonly description: string;
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly amount: bigint;
  /** The member who made the payment (their net for the row is positive). */
  readonly from: string;
  /** The member who received it (their net is negative). */
  readonly to: string;
}

export interface SplitwiseParse {
  /** Everybody named in the file, in column order. */
  readonly people: readonly string[];
  readonly expenses: readonly ParsedExpense[];
  readonly settlements: readonly ParsedSettlement[];
  /** Rows that could not be imported. Everything else still is. */
  readonly errors: readonly SplitwiseProblem[];
  readonly currency: CurrencyCode;
  /**
   * Net position per person across every imported row (expenses and
   * settlements), in minor units. Positive means owed money. Sums to zero when
   * `errors` is empty, and equals what the derived balances will be.
   */
  readonly netByPerson: Readonly<Record<string, bigint>>;
}

/** Columns Splitwise writes before the per-person ones. */
const FIXED_COLUMNS = ['date', 'description', 'category', 'cost', 'currency'];

function normaliseHeaderName(name: string): string {
  return name
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase();
}

function normalisePersonName(name: string): string {
  return name.replace(/^\uFEFF/, '').trim();
}

/** The trailing summary row Splitwise appends — not an expense. */
const TOTAL_ROW = /^total\s+balance$/i;

/** Splitwise marks a member-to-member payment with this category. */
const PAYMENT_CATEGORY = 'payment';

/** Splitwise writes YYYY-MM-DD; be forgiving about DD/MM/YYYY too. */
function parseDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (slashed) {
    return `${slashed[3]}-${String(slashed[2]).padStart(2, '0')}-${String(slashed[1]).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Turn each person's net for a row into a (paid, owed) pair that reproduces it
 * exactly.
 *
 * Anyone with a positive net is treated as having paid, in proportion to that
 * net; everyone's share is then `paid - net`, which is non-negative and sums to
 * the total by construction (Σshares = Σpaid − Σnet = amount − 0). The remainder
 * from the proportional division is handed out one minor unit at a time, in a
 * fixed order, so the reconstruction is deterministic and the same file always
 * imports identically. A row where nobody is owed anything (every net zero) has
 * its whole cost attributed to the first person by name, which leaves every
 * balance at zero — the row moved no money and the reconstruction does not
 * either.
 *
 * This mirrors the reconstruction in `@waves/core`'s `importSplitwiseCsv`; it is
 * a choice, not a recovery. The original group knew who paid; the CSV does not.
 */
function reconstruct(
  nets: ReadonlyMap<string, bigint>,
  amount: bigint,
): { payers: Record<string, bigint>; shares: Record<string, bigint> } {
  const creditors = [...nets.entries()]
    .filter(([, net]) => net > 0n)
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] > a[1] ? 1 : -1));
  const positive = creditors.reduce((sum, [, net]) => sum + net, 0n);

  const payers: Record<string, bigint> = {};
  if (positive === 0n) {
    const first = [...nets.keys()].sort((a, b) => a.localeCompare(b))[0];
    if (first !== undefined) payers[first] = amount;
  } else {
    let handed = 0n;
    for (const [person, net] of creditors) {
      const paid = (amount * net) / positive;
      payers[person] = paid;
      handed += paid;
    }
    let remainder = amount - handed;
    const step = remainder < 0n ? -1n : 1n;
    for (let index = 0; remainder !== 0n && creditors.length > 0; index += 1) {
      const person = creditors[index % creditors.length]?.[0];
      if (person === undefined) break;
      payers[person] = (payers[person] ?? 0n) + step;
      remainder -= step;
    }
  }

  const shares: Record<string, bigint> = {};
  for (const [person, net] of nets) {
    shares[person] = (payers[person] ?? 0n) - net;
  }
  return { payers, shares };
}

function sumValues(record: Readonly<Record<string, bigint>>): bigint {
  return Object.values(record).reduce((total, value) => total + value, 0n);
}

/**
 * Read a Splitwise CSV export into structured expenses, settlements and the
 * errors for anything that would not reconcile.
 *
 * Never throws. A file with three bad rows and forty good ones yields the forty
 * and names the three — refusing the lot because one row is malformed would be
 * the wrong trade for somebody moving years of history.
 */
export function parseSplitwiseCsv(csv: string): SplitwiseParse {
  const errors: SplitwiseProblem[] = [];
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');

  const header = lines[0] ? parseCsvRow(lines[0]) : [];
  const fixedCount = FIXED_COLUMNS.filter((name) =>
    header.some((column) => normaliseHeaderName(column) === name),
  ).length;
  // Keep the field index beside each name: a blank person column in the header
  // shifts the people list without shifting the field positions, so reading by
  // list index would attribute every net after the gap to the wrong person.
  const personColumns = header
    .slice(FIXED_COLUMNS.length)
    .map((name, offset) => ({
      name: normalisePersonName(name),
      column: FIXED_COLUMNS.length + offset,
    }))
    .filter((entry) => entry.name !== '');
  const people = personColumns.map((entry) => entry.name);
  const duplicatePeople = people.filter((person, index) => people.indexOf(person) !== index);

  if (fixedCount < FIXED_COLUMNS.length || people.length === 0) {
    errors.push({
      kind: SplitwiseProblemKind.NoPeople,
      row: 1,
      message:
        'This does not look like a Splitwise export — expected Date, Description, Category, Cost, Currency and then one column per person.',
    });
    return {
      people: [],
      expenses: [],
      settlements: [],
      errors,
      currency: 'INR',
      netByPerson: {},
    };
  }

  if (duplicatePeople.length > 0) {
    errors.push({
      kind: SplitwiseProblemKind.DuplicatePerson,
      row: 1,
      message: `Splitwise export has duplicate person columns: ${[...new Set(duplicatePeople)].join(', ')}.`,
    });
    return {
      people: [],
      expenses: [],
      settlements: [],
      errors,
      currency: 'INR',
      netByPerson: {},
    };
  }

  const expenses: ParsedExpense[] = [];
  const settlements: ParsedSettlement[] = [];
  const netByPerson = new Map<string, bigint>(people.map((person) => [person, 0n]));
  let currency: CurrencyCode = 'INR';

  const commitNets = (nets: ReadonlyMap<string, bigint>): void => {
    for (const [person, value] of nets) {
      netByPerson.set(person, (netByPerson.get(person) ?? 0n) + value);
    }
  };

  for (let index = 1; index < lines.length; index += 1) {
    const rowNumber = index + 1;
    const fields = parseCsvRow(lines[index] ?? '');
    const description = fields[1] ?? '';

    if (TOTAL_ROW.test((fields[0] ?? '').trim()) || TOTAL_ROW.test(description.trim())) continue;

    const date = parseDate(fields[0] ?? '');
    const rowCurrency = (fields[4] ?? '').trim().toUpperCase() || currency;
    const amount = parseCsvAmount(fields[3] ?? '', rowCurrency);
    if (!date || amount === null || !/^[A-Z]{3}$/.test(rowCurrency)) {
      errors.push({
        kind: SplitwiseProblemKind.UnparseableRow,
        row: rowNumber,
        message: `Row ${rowNumber}: could not read ${
          !date ? 'the date' : amount === null ? 'the cost' : 'the currency'
        }.`,
      });
      continue;
    }
    currency = rowCurrency;

    if (amount <= 0n) {
      errors.push({
        kind: SplitwiseProblemKind.NonPositiveCost,
        row: rowNumber,
        message: `Row ${rowNumber} ("${description}"): Splitwise cost must be greater than zero.`,
      });
      continue;
    }

    const nets = new Map<string, bigint>();
    let netTotal = 0n;
    let malformedNet: string | null = null;
    for (const entry of personColumns) {
      const raw = fields[entry.column] ?? '';
      const parsed = parseCsvAmount(raw, rowCurrency);
      if (parsed === null && raw.trim() !== '') {
        malformedNet = entry.name;
        break;
      }
      const value = parsed ?? 0n;
      nets.set(entry.name, value);
      netTotal += value;
    }

    if (malformedNet) {
      errors.push({
        kind: SplitwiseProblemKind.UnparseableRow,
        row: rowNumber,
        message: `Row ${rowNumber} ("${description}"): could not read ${malformedNet}'s amount.`,
      });
      continue;
    }

    // Every row in a correct export sums to zero across people. A row that does
    // not is the one case where importing it would silently corrupt balances.
    if (netTotal !== 0n) {
      errors.push({
        kind: SplitwiseProblemKind.RowDoesNotBalance,
        row: rowNumber,
        message: `Row ${rowNumber} ("${description}"): the people's columns add up to ${netTotal}, not 0.`,
      });
      continue;
    }

    const rawCategory = (fields[2] ?? '').trim() || null;

    if ((rawCategory ?? '').toLowerCase() === PAYMENT_CATEGORY) {
      // A settlement: exactly one person paid (positive net) and exactly one
      // received (negative net), each for the whole cost. Positive net is the
      // payer — "Hethu paid Madan" has Hethu +X, Madan −X.
      const creditors = [...nets.entries()].filter(([, net]) => net > 0n);
      const debtors = [...nets.entries()].filter(([, net]) => net < 0n);
      const from = creditors[0];
      const to = debtors[0];
      if (creditors.length !== 1 || debtors.length !== 1 || !from || !to || from[1] !== amount) {
        errors.push({
          kind: SplitwiseProblemKind.UnexpectedSettlement,
          row: rowNumber,
          message: `Row ${rowNumber} ("${description}"): a payment should be one person paying one other the full amount; this one is not.`,
        });
        continue;
      }
      settlements.push({
        kind: SplitwiseRowKind.Settlement,
        row: rowNumber,
        description: description || 'Payment',
        date,
        currency: rowCurrency,
        amount,
        from: from[0],
        to: to[0],
      });
      commitNets(nets);
      continue;
    }

    const { payers, shares } = reconstruct(nets, amount);
    // Belt and braces: the reconstruction sums to the total by construction, but
    // a row that somehow does not must be named, not written — the database's
    // Σpayers = Σshares = amount constraint would reject it anyway (ADR-003).
    if (sumValues(payers) !== amount || sumValues(shares) !== amount) {
      errors.push({
        kind: SplitwiseProblemKind.RowDoesNotBalance,
        row: rowNumber,
        message: `Row ${rowNumber} ("${description}"): reconstructed payers/shares do not sum to the cost.`,
      });
      continue;
    }

    expenses.push({
      kind: SplitwiseRowKind.Expense,
      row: rowNumber,
      description: description || 'Imported expense',
      category: guessCategory(description),
      rawCategory,
      date,
      currency: rowCurrency,
      amount,
      payers,
      shares,
    });
    commitNets(nets);
  }

  if (expenses.length === 0 && settlements.length === 0 && errors.length === 0) {
    errors.push({
      kind: SplitwiseProblemKind.NoRows,
      row: null,
      message: 'There were no expenses in this file.',
    });
  }

  return {
    people,
    expenses,
    settlements,
    errors,
    currency,
    netByPerson: Object.fromEntries(netByPerson),
  };
}

// ── write path ──────────────────────────────────────────────────────────────

/**
 * The slice of a `pg`-style client this module needs. Declared here so the
 * package's runtime code does not depend on `pg` (a dev/test dependency): any
 * client with a `query(text, params)` returning `{ rows }` will do.
 */
export interface Queryable {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ImportPlanMember {
  readonly name: string;
  /** `real` is the account doing the import; `ghost` is a name-only placeholder. */
  readonly kind: 'real' | 'ghost';
}

export interface ImportPlan {
  readonly groupName: string;
  readonly currency: CurrencyCode;
  readonly members: readonly ImportPlanMember[];
  readonly expenseCount: number;
  readonly settlementCount: number;
  /** Total expense spend per app category (null category shown as "uncategorised"), minor units. */
  readonly categoryTotals: Readonly<Record<string, bigint>>;
  /** Each person's final net after the whole import, minor units. */
  readonly netByPerson: Readonly<Record<string, bigint>>;
  readonly errors: readonly SplitwiseProblem[];
}

export interface ImportOptions {
  readonly parse: SplitwiseParse;
  /** The profile id of the Waves account the import lands in. Must already exist. */
  readonly userId: string;
  /** That account's Splitwise column name (must be one of `parse.people`). */
  readonly userName: string;
  /** Defaults to "<userName>'s Splitwise". */
  readonly groupName?: string;
  /** Recorded on the activity-log entry. Defaults to "splitwise". */
  readonly origin?: string;
  /**
   * When true (the DEFAULT), nothing is written — the returned plan is what
   * *would* happen. Pass false to actually insert.
   */
  readonly dryRun?: boolean;
}

export interface ImportResult {
  readonly dryRun: boolean;
  readonly plan: ImportPlan;
  /** Set only when `dryRun` was false. */
  readonly groupId?: string;
  /** name → group_member id, set only when `dryRun` was false. */
  readonly memberIdByName?: Readonly<Record<string, string>>;
  /** The raw jsonb `baaki_import_ledger` returned, when `dryRun` was false. */
  readonly ledgerResult?: Record<string, unknown>;
}

const UNCATEGORISED = 'uncategorised';

function buildPlan(options: ImportOptions): ImportPlan {
  const { parse, userName } = options;
  const groupName = options.groupName ?? `${userName}'s Splitwise`;

  const categoryTotals = new Map<string, bigint>();
  for (const expense of parse.expenses) {
    const key = expense.category ?? UNCATEGORISED;
    categoryTotals.set(key, (categoryTotals.get(key) ?? 0n) + expense.amount);
  }

  return {
    groupName,
    currency: parse.currency,
    members: parse.people.map((name) => ({
      name,
      kind: name === userName ? 'real' : 'ghost',
    })),
    expenseCount: parse.expenses.length,
    settlementCount: parse.settlements.length,
    categoryTotals: Object.fromEntries(categoryTotals),
    netByPerson: parse.netByPerson,
    errors: parse.errors,
  };
}

/** minor-unit bigints → the string-valued JSON `baaki_import_ledger` reads. */
function amountMap(record: Readonly<Record<string, bigint>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => [name, value.toString()]),
  );
}

/**
 * Load a parsed Splitwise export into a fresh Waves group.
 *
 * Creates the group and the importing account's membership, then hands the
 * expenses, settlements and the other people to `baaki_import_ledger` — the
 * canonical RPC — which mints a ghost member for each of the others, applies
 * every expense through the same `baaki_apply_expense` the app uses, inserts the
 * settlements, and lets the derived-balance triggers do the rest. Everything
 * runs in one transaction: if any single row is rejected, nothing is written.
 *
 * With `dryRun` (the default) it touches nothing and returns the plan alone.
 */
export async function importSplitwiseLedger(
  client: Queryable,
  options: ImportOptions,
): Promise<ImportResult> {
  const { parse, userId, userName, origin = 'splitwise' } = options;
  const dryRun = options.dryRun ?? true;
  const plan = buildPlan(options);

  if (!parse.people.includes(userName)) {
    throw new Error(
      `The importing account's name "${userName}" is not one of the people in the file (${parse.people.join(', ')}).`,
    );
  }

  if (dryRun) {
    return { dryRun: true, plan };
  }

  const expensesJson = parse.expenses.map((expense) => ({
    description: expense.description,
    category: expense.category,
    date: expense.date,
    currency: expense.currency,
    amount: expense.amount.toString(),
    payers: amountMap(expense.payers),
    shares: amountMap(expense.shares),
  }));

  const settlementsJson = parse.settlements.map((settlement) => ({
    from: settlement.from,
    to: settlement.to,
    amount: settlement.amount.toString(),
    currency: settlement.currency,
    at: settlement.date,
    status: 'confirmed',
    method: 'other',
    note: settlement.description,
  }));

  await client.query('BEGIN');
  try {
    const groupRows = (
      await client.query(
        `INSERT INTO groups (name, type, default_currency, created_by)
         VALUES ($1, 'other', $2, $3) RETURNING id`,
        [plan.groupName, parse.currency, userId],
      )
    ).rows;
    const groupId = String(groupRows[0]?.id);

    const memberRows = (
      await client.query(
        `INSERT INTO group_members (group_id, profile_id, role, joined_via)
         VALUES ($1, $2, 'admin', 'creator') RETURNING id`,
        [groupId, userId],
      )
    ).rows;
    const realMemberId = String(memberRows[0]?.id);

    const peopleJson = parse.people.map((name) =>
      name === userName ? { name, memberId: realMemberId } : { name },
    );

    // Act as the importing user so the RPC's membership and authorship checks
    // pass; local to this transaction, undone on commit/rollback.
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId }),
    ]);

    const ledgerRows = (
      await client.query(
        `SELECT public.baaki_import_ledger($1, $2::jsonb, $3::jsonb, $4::jsonb, $5) AS result`,
        [
          groupId,
          JSON.stringify(peopleJson),
          JSON.stringify(expensesJson),
          JSON.stringify(settlementsJson),
          origin,
        ],
      )
    ).rows;
    const ledgerResult = (ledgerRows[0]?.result ?? {}) as Record<string, unknown>;

    await client.query('COMMIT');

    const members = (ledgerResult.members ?? {}) as Record<string, string>;
    const memberIdByName: Record<string, string> = { ...members };
    memberIdByName[userName] = realMemberId;

    return { dryRun: false, plan, groupId, memberIdByName, ledgerResult };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * A human-readable summary of what an import would do — the thing to eyeball
 * before running the real one. Pure; safe to print from a dry run.
 */
export function formatImportReport(result: ImportResult): string {
  const { plan } = result;
  const lines: string[] = [];
  const money = (minor: bigint): string => {
    const negative = minor < 0n;
    const abs = negative ? -minor : minor;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
  };

  lines.push(`Splitwise import — ${plan.groupName} (${plan.currency})`);
  lines.push(
    `  ${result.dryRun ? 'DRY RUN — nothing written' : `written as group ${result.groupId}`}`,
  );
  lines.push('');
  lines.push(`Members (${plan.members.length}):`);
  for (const member of plan.members) {
    lines.push(`  - ${member.name}${member.kind === 'real' ? ' (you)' : ' (ghost)'}`);
  }
  lines.push('');
  lines.push(`Expenses:    ${plan.expenseCount}`);
  lines.push(`Settlements: ${plan.settlementCount}`);
  lines.push(`Errors:      ${plan.errors.length}`);
  lines.push('');
  lines.push('Spend by category:');
  for (const [category, total] of Object.entries(plan.categoryTotals).sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
  )) {
    lines.push(`  ${category.padEnd(16)} ${money(total)}`);
  }
  lines.push('');
  lines.push('Final net per member (positive = owed money):');
  for (const [name, net] of Object.entries(plan.netByPerson)) {
    lines.push(`  ${name.padEnd(20)} ${money(net)}`);
  }
  if (plan.errors.length > 0) {
    lines.push('');
    lines.push('Rows that did NOT reconcile:');
    for (const problem of plan.errors) {
      lines.push(`  [row ${problem.row ?? '-'}] ${problem.kind}: ${problem.message}`);
    }
  }
  return lines.join('\n');
}
