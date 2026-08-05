/**
 * Bringing a Splitwise group across (TDR §10, M3).
 *
 * The acceptance bar is "CSV round-trips into correct balances", and the word
 * doing the work is *balances*. A Splitwise export does not contain enough to
 * reconstruct an expense exactly: each person's column is their **net** for
 * that row — what they paid minus what they owed — and many different
 * (paid, owed) pairs produce the same net.
 *
 * So this module is honest about what it can and cannot recover:
 *
 *   - balances are exact, to the paisa, and that is provable;
 *   - who paid is a *reconstruction* chosen deterministically, not the truth
 *     from the original group. Anyone whose net was positive is treated as
 *     having paid, in proportion to that net.
 *
 * Pretending otherwise would be the worse failure: an import that silently
 * invents a single payer would show a history that never happened, and the
 * person reading it has no way to tell.
 *
 * Amounts are parsed digit by digit. A CSV of somebody's entire financial
 * history is precisely where a float would quietly lose a paisa per row and
 * only show up as a balance that will not settle (ADR-003).
 */

import { minorUnitExponent, type CurrencyCode } from '../money/currency';
import type { ExactParams } from '../split/types';

export type ImportProblemKind =
  'unparseable_row' | 'row_does_not_balance' | 'unknown_currency' | 'no_people' | 'no_rows';

export interface ImportProblem {
  readonly kind: ImportProblemKind;
  /** 1-based row in the file, as a spreadsheet would number it. Null for file-level problems. */
  readonly row: number | null;
  readonly message: string;
}

export interface ImportedExpense {
  readonly description: string;
  readonly category: string | null;
  /** ISO date, YYYY-MM-DD. */
  readonly date: string;
  readonly currency: CurrencyCode;
  /** Total, in minor units. */
  readonly amount: bigint;
  /** Reconstructed: who is treated as having paid, and how much. Sums to `amount`. */
  readonly payers: Readonly<Record<string, bigint>>;
  /** Exactly what each person owed. Sums to `amount`. */
  readonly shares: Readonly<Record<string, bigint>>;
  /** Ready to hand to the write path unchanged. */
  readonly splitParams: ExactParams;
}

export interface SplitwiseImport {
  /** Everybody named in the file, in column order. */
  readonly people: readonly string[];
  readonly expenses: readonly ImportedExpense[];
  /** Net position per person, in minor units. Sums to zero. */
  readonly balances: Readonly<Record<string, bigint>>;
  readonly currency: CurrencyCode;
  /** Rows that could not be imported. Everything else still is. */
  readonly problems: readonly ImportProblem[];
}

/** Columns Splitwise writes before the per-person ones. */
const FIXED_COLUMNS = ['date', 'description', 'category', 'cost', 'currency'];

/**
 * The trailing summary row Splitwise appends. It is not an expense, and
 * importing it would double every balance in the file.
 */
const TOTAL_ROW = /^total\s+balance$/i;

/**
 * A CSV parser that handles the only two things that actually appear in these
 * files: quoted fields, and commas inside them. A description of
 * `Dinner, drinks and a taxi` is common enough that splitting on commas would
 * corrupt real files.
 */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is an escaped quote.
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields.map((value) => value.trim());
}

/**
 * "-1,234.56" → -123456 minor units, by digits. Returns null for anything that
 * is not a number, which is how a blank person-column is told apart from zero.
 */
export function parseCsvAmount(text: string, currency: CurrencyCode): bigint | null {
  const cleaned = text.trim().replace(/,/g, '').replace(/^\+/, '');
  if (cleaned === '') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return null;

  const exponent = minorUnitExponent(currency);
  const fraction = (match[3] ?? '') + '0'.repeat(exponent);
  const minor = BigInt((match[2] ?? '0') + fraction.slice(0, exponent));
  return match[1] === '-' ? -minor : minor;
}

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
 * the total by construction. The remainder from the proportional division is
 * handed out one minor unit at a time, largest-net first, so the reconstruction
 * is deterministic and the same file always imports identically.
 *
 * This is a choice, not a recovery. The original group knew who paid; the CSV
 * does not carry it.
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
    // Nobody is owed anything — a fully settled or zero row. Attribute the
    // whole cost to the first person so the totals still hold.
    const first = [...nets.keys()].sort()[0];
    if (first !== undefined) payers[first] = amount;
  } else {
    let handed = 0n;
    for (const [person, net] of creditors) {
      const paid = (amount * net) / positive;
      payers[person] = paid;
      handed += paid;
    }
    // Integer division loses at most one unit per creditor; give them back in a
    // fixed order rather than letting the total drift.
    let remainder = amount - handed;
    for (let index = 0; remainder > 0n && creditors.length > 0; index += 1) {
      const person = creditors[index % creditors.length]?.[0];
      if (person === undefined) break;
      payers[person] = (payers[person] ?? 0n) + 1n;
      remainder -= 1n;
    }
  }

  const shares: Record<string, bigint> = {};
  for (const [person, net] of nets) {
    shares[person] = (payers[person] ?? 0n) - net;
  }
  return { payers, shares };
}

/**
 * Read a Splitwise CSV export.
 *
 * Never throws. A file with three bad rows and forty good ones imports the
 * forty and names the three — refusing the lot because one row is malformed
 * would be the wrong trade for somebody moving years of history.
 */
export function importSplitwiseCsv(csv: string): SplitwiseImport {
  const problems: ImportProblem[] = [];
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');

  const header = lines[0] ? parseCsvRow(lines[0]) : [];
  const fixedCount = FIXED_COLUMNS.filter((name) =>
    header.some((column) => column.toLowerCase() === name),
  ).length;
  const people = header.slice(FIXED_COLUMNS.length).filter((name) => name !== '');

  if (fixedCount < FIXED_COLUMNS.length || people.length === 0) {
    problems.push({
      kind: 'no_people',
      row: 1,
      message:
        'This does not look like a Splitwise export — expected Date, Description, Category, Cost, Currency and then one column per person.',
    });
    return { people: [], expenses: [], balances: {}, currency: 'INR', problems };
  }

  const expenses: ImportedExpense[] = [];
  const balances = new Map<string, bigint>(people.map((person) => [person, 0n]));
  let currency: CurrencyCode = 'INR';

  for (let index = 1; index < lines.length; index += 1) {
    const rowNumber = index + 1;
    const fields = parseCsvRow(lines[index] ?? '');
    const description = fields[1] ?? '';

    // The summary row is not an expense; importing it would double everything.
    if (TOTAL_ROW.test((fields[0] ?? '').trim()) || TOTAL_ROW.test(description.trim())) continue;

    const date = parseDate(fields[0] ?? '');
    const rowCurrency = (fields[4] ?? '').trim().toUpperCase() || currency;
    if (!/^[A-Z]{3}$/.test(rowCurrency)) {
      problems.push({
        kind: 'unknown_currency',
        row: rowNumber,
        message: `Row ${rowNumber}: "${fields[4]}" is not a currency code.`,
      });
      continue;
    }
    currency = rowCurrency;

    const amount = parseCsvAmount(fields[3] ?? '', rowCurrency);
    if (!date || amount === null) {
      problems.push({
        kind: 'unparseable_row',
        row: rowNumber,
        message: `Row ${rowNumber}: could not read ${!date ? 'the date' : 'the cost'}.`,
      });
      continue;
    }

    const nets = new Map<string, bigint>();
    let net = 0n;
    for (let column = 0; column < people.length; column += 1) {
      const person = people[column] as string;
      const value = parseCsvAmount(fields[FIXED_COLUMNS.length + column] ?? '', rowCurrency) ?? 0n;
      nets.set(person, value);
      net += value;
    }

    // Every row in a correct export sums to zero across people. A row that does
    // not is the one case where importing it would silently corrupt balances,
    // so it is named and skipped rather than adjusted into shape.
    if (net !== 0n) {
      problems.push({
        kind: 'row_does_not_balance',
        row: rowNumber,
        message: `Row ${rowNumber} ("${description}"): the people's columns add up to ${net}, not 0.`,
      });
      continue;
    }

    const { payers, shares } = reconstruct(nets, amount);
    expenses.push({
      description: description || 'Imported expense',
      category: (fields[2] ?? '').trim() || null,
      date,
      currency: rowCurrency,
      amount,
      payers,
      shares,
      splitParams: { kind: 'exact', amounts: shares },
    });

    for (const [person, value] of nets) {
      balances.set(person, (balances.get(person) ?? 0n) + value);
    }
  }

  if (expenses.length === 0 && problems.length === 0) {
    problems.push({ kind: 'no_rows', row: null, message: 'There were no expenses in this file.' });
  }

  return {
    people,
    expenses,
    balances: Object.fromEntries(balances),
    currency,
    problems,
  };
}
