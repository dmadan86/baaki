/**
 * Reading Baaki's own export back in (M5, ADR-012).
 *
 * The M5 acceptance line is "export re-imports losslessly". Unlike a Splitwise
 * file — where each person's column is a *net* and the payer has to be
 * reconstructed (see ./splitwise.ts) — our own export carries the real (paid,
 * owed) pair for every expense and the settlements besides. So the balances
 * that come out are not merely correct in aggregate: every row is the row that
 * left.
 *
 * What *cannot* survive the trip is worth stating plainly, because an export
 * that claimed more than it delivers is the failure this file exists to avoid:
 *
 *   - **Ids change.** Every member, expense and settlement is new in the new
 *     group. Nothing else would be safe: a file could otherwise be made to
 *     overwrite rows in a group it was never part of.
 *   - **Edit history does not come.** The export holds every version (ADR-004);
 *     what returns is what each expense currently says. Those edits were made
 *     by people who are not members of the new group, and attributing them to
 *     whoever pressed Import would be a fiction. Balances are computed from
 *     current versions only, so nothing the acceptance criterion measures is
 *     lost.
 *   - **Settlement allocations do not come.** They name expense ids, and those
 *     ids are new. Allocations decide which expenses a payment is applied
 *     against, never how much anybody owes in total.
 *
 * Everything here is parsed from strings. The export writes minor units as
 * strings precisely so a JSON number — which is a double — never gets near
 * somebody's money (ADR-003).
 */

import type { CurrencyCode } from '../money/currency';
import type { ImportProblem } from './splitwise';

/** Statuses that move a balance (TDR §3.3). The rest are carried as history. */
const SETTLING = new Set(['confirmed', 'auto_confirmed']);

export interface BaakiImportExpense {
  readonly description: string;
  readonly category: string | null;
  /** ISO date, YYYY-MM-DD. */
  readonly date: string;
  readonly currency: CurrencyCode;
  readonly amount: bigint;
  /** Keyed by the display name this file uses for each person. */
  readonly payers: Readonly<Record<string, bigint>>;
  readonly shares: Readonly<Record<string, bigint>>;
}

export interface BaakiImportSettlement {
  readonly from: string;
  readonly to: string;
  readonly currency: CurrencyCode;
  readonly amount: bigint;
  readonly method: string;
  readonly status: string;
  readonly note: string | null;
  /** ISO timestamp. */
  readonly at: string;
}

export interface BaakiImportGroup {
  /** The group's name in the file, or null for a nameless group. */
  readonly name: string | null;
  readonly currency: CurrencyCode;
  /** Everybody the file names, in the order it named them. */
  readonly people: readonly string[];
  readonly expenses: readonly BaakiImportExpense[];
  readonly settlements: readonly BaakiImportSettlement[];
  /** Net per person, minor units, per currency. Sums to zero in each currency. */
  readonly balances: Readonly<Record<string, Readonly<Record<string, bigint>>>>;
  readonly problems: readonly ImportProblem[];
}

export interface BaakiImport {
  readonly exportedAt: string | null;
  readonly schemaVersion: number;
  readonly groups: readonly BaakiImportGroup[];
  readonly problems: readonly ImportProblem[];
}

/** The only schema this build knows how to read. */
export const SUPPORTED_SCHEMA_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Minor units from whatever the file holds.
 *
 * Strings are the contract, but a hand-edited file or an older export can
 * carry an integer, and refusing to read a whole ledger over that would be
 * pedantry. A fractional number is refused: it means somebody has already lost
 * precision upstream, and quietly rounding it here would bury that.
 */
function minor(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^-?\d+$/.test(text) ? BigInt(text) : null;
}

/** The name this file uses for a member — what payers and shares are keyed by. */
function memberName(member: Record<string, unknown>, index: number): string {
  const profile = asRecord(member.profile);
  const display = typeof profile?.display_name === 'string' ? profile.display_name.trim() : '';
  const ghost = typeof member.ghost_name === 'string' ? member.ghost_name.trim() : '';
  return display || ghost || `Member ${index + 1}`;
}

/**
 * Parse an export file.
 *
 * Never throws. A file this size is somebody's whole history and it can be
 * damaged in a dozen ways; each is reported as a problem against the row it
 * came from, and everything readable is still read. The caller decides whether
 * a partial import is worth offering — and the screen shows the problems
 * before anybody taps Import.
 */
export function parseBaakiExport(text: string): BaakiImport {
  const problems: ImportProblem[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      exportedAt: null,
      schemaVersion: 0,
      groups: [],
      problems: [
        { kind: 'unparseable_row', row: null, message: 'That file is not a Baaki export.' },
      ],
    };
  }

  const root = asRecord(parsed);
  const groupsRaw = asArray(root?.groups);
  const schemaVersion = typeof root?.schemaVersion === 'number' ? root.schemaVersion : 0;

  if (!root || groupsRaw.length === 0) {
    problems.push({
      kind: 'no_rows',
      row: null,
      message: 'That file has no groups in it.',
    });
  } else if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    // Forwards, not backwards: a newer file may hold fields this build would
    // silently drop, and dropping half of somebody's ledger without saying so
    // is exactly what this whole module exists to avoid.
    problems.push({
      kind: 'unparseable_row',
      row: null,
      message: `That file was written by a newer version of Baaki (format ${schemaVersion}). Update the app and try again.`,
    });
  }

  const groups = groupsRaw.map((entry) => parseGroup(entry));

  return {
    exportedAt: typeof root?.exportedAt === 'string' ? root.exportedAt : null,
    schemaVersion,
    groups: schemaVersion > SUPPORTED_SCHEMA_VERSION ? [] : groups,
    problems,
  };
}

function parseGroup(entry: unknown): BaakiImportGroup {
  const problems: ImportProblem[] = [];
  const record = asRecord(entry) ?? {};
  const group = asRecord(record.group) ?? {};
  const currency = (
    typeof group.default_currency === 'string' ? group.default_currency : 'INR'
  ).toUpperCase() as CurrencyCode;

  // Members first: everything else refers to them by id, and this is the only
  // place their names are known.
  const namesById = new Map<string, string>();
  const people: string[] = [];
  const taken = new Set<string>();
  for (const [index, member] of asArray(record.members).entries()) {
    const memberRecord = asRecord(member);
    if (!memberRecord || typeof memberRecord.id !== 'string') continue;
    let name = memberName(memberRecord, index);
    // Two people can share a name; the map that carries an expense to the
    // right person cannot. Disambiguate rather than merging two ledgers.
    if (taken.has(name)) {
      let suffix = 2;
      while (taken.has(`${name} (${suffix})`)) suffix += 1;
      name = `${name} (${suffix})`;
    }
    taken.add(name);
    namesById.set(memberRecord.id, name);
    people.push(name);
  }

  if (people.length === 0) {
    problems.push({
      kind: 'no_people',
      row: null,
      message: 'That group has nobody in it.',
    });
  }

  const expenses: BaakiImportExpense[] = [];
  for (const [index, entryValue] of asArray(record.expenses).entries()) {
    const expense = asRecord(entryValue);
    if (!expense) continue;
    // A deleted expense is history, not spending, and re-importing one would
    // put money back into the new group's balances that nobody owes.
    if (expense.deleted_at) continue;

    const versions = asArray(expense.versions).map(asRecord);
    const current =
      versions.find((version) => version?.id === expense.current_version_id) ??
      versions[versions.length - 1];
    if (!current) continue;

    const amount = minor(current.amount);
    const payers = amounts(current.payers, namesById);
    const shares = amounts(current.shares, namesById);
    const row = index + 1;

    if (amount === null || payers === null || shares === null) {
      problems.push({
        kind: 'unparseable_row',
        row,
        message: `"${String(current.description ?? 'An expense')}" holds an amount that could not be read.`,
      });
      continue;
    }

    const paid = sum(payers);
    const owed = sum(shares);
    if (paid !== amount || owed !== amount) {
      // The same invariant the database enforces on every write. A file that
      // breaks it would be rejected server-side anyway; saying so here names
      // the row instead of failing the whole import with a constraint error.
      problems.push({
        kind: 'row_does_not_balance',
        row,
        message: `"${String(current.description ?? 'An expense')}" does not add up: paid ${paid}, owed ${owed}, total ${amount}.`,
      });
      continue;
    }

    expenses.push({
      description: typeof current.description === 'string' ? current.description : 'Expense',
      category: typeof current.category === 'string' ? current.category : null,
      date: String(current.expense_date ?? '').slice(0, 10),
      currency: String(current.currency ?? currency).toUpperCase() as CurrencyCode,
      amount,
      payers,
      shares,
    });
  }

  const settlements: BaakiImportSettlement[] = [];
  for (const [index, entryValue] of asArray(record.settlements).entries()) {
    const settlement = asRecord(entryValue);
    if (!settlement) continue;
    const from = namesById.get(String(settlement.from_member_id));
    const to = namesById.get(String(settlement.to_member_id));
    const amount = minor(settlement.amount);
    if (!from || !to || amount === null) {
      problems.push({
        kind: 'unparseable_row',
        row: index + 1,
        message: 'A settlement names somebody who is not in the file.',
      });
      continue;
    }
    settlements.push({
      from,
      to,
      currency: String(settlement.currency ?? currency).toUpperCase() as CurrencyCode,
      amount,
      method: typeof settlement.method === 'string' ? settlement.method : 'other',
      status: typeof settlement.status === 'string' ? settlement.status : 'confirmed',
      note: typeof settlement.note === 'string' ? settlement.note : null,
      at:
        typeof settlement.initiated_at === 'string'
          ? settlement.initiated_at
          : new Date(0).toISOString(),
    });
  }

  return {
    name: typeof group.name === 'string' && group.name.trim() !== '' ? group.name : null,
    currency,
    people,
    expenses,
    settlements,
    balances: balancesOf(expenses, settlements),
    problems,
  };
}

function amounts(rows: unknown, namesById: Map<string, string>): Record<string, bigint> | null {
  const result: Record<string, bigint> = {};
  for (const entry of asArray(rows)) {
    const record = asRecord(entry);
    const name = namesById.get(String(record?.member_id));
    const value = minor(record?.amount);
    if (!name || value === null) return null;
    result[name] = (result[name] ?? 0n) + value;
  }
  return result;
}

function sum(values: Readonly<Record<string, bigint>>): bigint {
  return Object.values(values).reduce((total, value) => total + value, 0n);
}

/**
 * What each person's balance will be once this file has been imported.
 *
 * Computed here, from the parsed rows, so the preview can be checked against
 * the group it came from *before* anything is written — which is the whole
 * proof that the round trip is lossless.
 */
export function balancesOf(
  expenses: readonly BaakiImportExpense[],
  settlements: readonly BaakiImportSettlement[],
): Record<string, Record<string, bigint>> {
  const byCurrency: Record<string, Record<string, bigint>> = {};
  const add = (currency: string, person: string, delta: bigint): void => {
    const bucket = (byCurrency[currency] ??= {});
    bucket[person] = (bucket[person] ?? 0n) + delta;
  };

  for (const expense of expenses) {
    for (const [person, paid] of Object.entries(expense.payers)) {
      add(expense.currency, person, paid);
    }
    for (const [person, owed] of Object.entries(expense.shares)) {
      add(expense.currency, person, -owed);
    }
  }
  for (const settlement of settlements) {
    if (!SETTLING.has(settlement.status)) continue;
    add(settlement.currency, settlement.from, settlement.amount);
    add(settlement.currency, settlement.to, -settlement.amount);
  }

  for (const bucket of Object.values(byCurrency)) {
    for (const [person, value] of Object.entries(bucket)) {
      if (value === 0n) delete bucket[person];
    }
  }
  return byCurrency;
}

/** Whether this is our file at all — asked before a CSV parser is reached for. */
export function isBaakiExport(text: string): boolean {
  try {
    const root = asRecord(JSON.parse(text));
    return Array.isArray(root?.groups) && typeof root?.schemaVersion === 'number';
  } catch {
    return false;
  }
}
