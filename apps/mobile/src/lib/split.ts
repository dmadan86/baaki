/**
 * The numbers somebody types into a shares, percent or exact split.
 *
 * `@waves/core` takes integers — whole weights, and basis points that sum to
 * exactly 10000. A person types text, and text is where the gap is: "33.33" is
 * 3333 basis points, "" is a field they have not reached yet, and "1.5" is a
 * share count that does not exist. Keeping the parsing here means the screen
 * holds what was typed and nothing else, and that the rules can be tested
 * without a keyboard.
 *
 * Nothing here rounds silently. A percentage with three decimal places is
 * refused rather than trimmed, because trimming it would put a number in the
 * ledger that nobody chose.
 */

import { parseMinorInput, type CurrencyCode } from '@waves/core';

export enum SplitKind {
  Equal = 'equal',
  Shares = 'shares',
  Percent = 'percent',
  Exact = 'exact',
}

/** What a weighted split kind holds: one line of text per member. */
export type SplitEntries = Record<string, string>;

const TOTAL_BASIS_POINTS = 10000;

/** Up to three digits, then at most two decimal places. */
const PERCENT = /^(?:\d{1,3}|\d{0,3}\.\d{1,2})$/;

/** Whole numbers only, and not so many digits that the field stops being one. */
const WEIGHT = /^\d{1,9}$/;

/**
 * One typed entry as a number — basis points for percent, a weight for shares.
 *
 * An empty field is 0, not an error: it is somebody mid-way through filling the
 * form, and the totals below will say what is still missing. Anything actually
 * malformed comes back as `null`.
 */
export function parseEntry(kind: 'shares' | 'percent', text: string): number | null {
  const value = text.trim();
  if (value === '' || value === '.') return 0;

  if (kind === 'shares') {
    return WEIGHT.test(value) ? Number(value) : null;
  }

  if (!PERCENT.test(value)) return null;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent > 100) return null;
  // × 100 in decimal, not in floating point: 0.29 * 10000 is 2899.9999999999995.
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Basis points back into a field: 3333 reads "33.33", 2500 reads "25". */
export function formatEntry(kind: 'shares' | 'percent', value: number): string {
  if (kind === 'shares') return String(value);
  const whole = Math.trunc(value / 100);
  const fraction = value % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0')}`.replace(/0$/, '');
}

/**
 * The integers `computeShares` wants, for the people actually in the split.
 *
 * Members who were unchecked keep their text — unchecking somebody should not
 * throw away what was typed for them — but they are not passed on, because a
 * weight for a non-participant is rejected downstream.
 */
export function entryValues(
  kind: 'shares' | 'percent',
  entries: SplitEntries,
  participants: readonly string[],
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const id of participants) {
    values[id] = parseEntry(kind, entries[id] ?? '') ?? 0;
  }
  return values;
}

/**
 * What is wrong with these entries, in words somebody can act on — or `null`
 * when the split is ready to save.
 *
 * The percent case is the one that matters: `computeShares` throws unless the
 * basis points sum to exactly 10000, and a thrown preview looks to the user
 * like the screen simply stopped working. Saying "3.5% left" instead is the
 * whole point of this function.
 */
export function splitProblem(
  kind: SplitKind,
  entries: SplitEntries,
  participants: readonly string[],
): string | null {
  if (kind === 'equal') return null;
  // An exact split's complaint is money, and money needs a currency and a total
  // this function is not given. `exactRemainder` answers it instead, and the
  // screen turns the figure into a localised sentence.
  if (kind === 'exact') return null;
  if (participants.length === 0) return null;

  for (const id of participants) {
    if (parseEntry(kind, entries[id] ?? '') === null) {
      return kind === 'shares'
        ? 'Shares must be whole numbers.'
        : 'Percentages can have at most two decimal places.';
    }
  }

  const values = entryValues(kind, entries, participants);
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);

  if (kind === 'shares') {
    return total > 0 ? null : 'Give at least one person a share.';
  }

  if (total === TOTAL_BASIS_POINTS) return null;
  const off = formatEntry('percent', Math.abs(total - TOTAL_BASIS_POINTS));
  return total < TOTAL_BASIS_POINTS
    ? `That is ${formatEntry('percent', total)}% — ${off}% left to give out.`
    : `That is ${formatEntry('percent', total)}% — ${off}% too much.`;
}

/**
 * Entries for anybody who has none yet, or `null` when everyone already has
 * one. Returning `null` rather than an equal object is what lets the caller
 * set this during render without looping.
 *
 * A fresh percent split is divided evenly with the odd basis point on the first
 * person, so the form opens on something valid. Somebody added to a split that
 * is already filled in starts at 0 instead — quietly rebalancing would rewrite
 * numbers the user chose deliberately.
 */
export function fillEntries(
  kind: 'shares' | 'percent',
  entries: SplitEntries,
  participants: readonly string[],
): SplitEntries | null {
  const missing = participants.filter((id) => entries[id] === undefined);
  if (missing.length === 0 || participants.length === 0) return null;

  if (kind === 'shares') {
    return { ...entries, ...Object.fromEntries(missing.map((id) => [id, '1'])) };
  }

  const untouched = missing.length === participants.length;
  if (!untouched) {
    return { ...entries, ...Object.fromEntries(missing.map((id) => [id, '0'])) };
  }

  const each = Math.floor(TOTAL_BASIS_POINTS / participants.length);
  const filled: SplitEntries = { ...entries };
  participants.forEach((id, index) => {
    const basisPoints = index === 0 ? TOTAL_BASIS_POINTS - each * (participants.length - 1) : each;
    filled[id] = formatEntry('percent', basisPoints);
  });
  return filled;
}

/**
 * The typed exact amounts, as the minor units `computeShares` takes.
 *
 * Unlike shares and percent, an exact split is money — so the text is read with
 * the same currency-aware parser the amount fields use, and a currency with no
 * minor unit gets no decimals for free. An empty field is zero: somebody
 * part-way through, whom {@link exactRemainder} will tell what is still owed.
 *
 * Only participants are passed on. Unticking somebody keeps their text, because
 * throwing away a typed figure on a mis-tap is the kind of loss nobody forgives,
 * but an amount for a non-participant is rejected downstream.
 */
export function exactValues(
  entries: SplitEntries,
  participants: readonly string[],
  currency: string,
): Record<string, bigint> {
  const values: Record<string, bigint> = {};
  for (const id of participants) {
    values[id] = parseMinorInput(entries[id] ?? '', currency as CurrencyCode);
  }
  return values;
}

/**
 * What is left to hand out: the bill minus everything typed so far.
 *
 * Signed, like the payer side's `delta` — positive is still to assign, negative
 * is more than the bill. The screen turns it into money and a sentence; this
 * stays a number so it can be tested without a locale.
 *
 * This is the same rule `computeShares` enforces (`EXACT_SUM_MISMATCH`) and the
 * one the sync function re-checks. Doing it here as well is not a second source
 * of truth — it is the difference between a sentence under the field and a
 * rejection that arrives minutes later off the queue.
 */
export function exactRemainder(
  entries: SplitEntries,
  participants: readonly string[],
  currency: string,
  amount: bigint,
): bigint {
  const values = exactValues(entries, participants, currency);
  let assigned = 0n;
  for (const value of Object.values(values)) assigned += value;
  return amount - assigned;
}
