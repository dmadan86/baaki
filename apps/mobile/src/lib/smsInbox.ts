/**
 * The Bank messages screen, as arithmetic: which rows a tab, a search and a
 * date filter leave standing, and what the ones that are ticked come to.
 *
 * This screen is deliberately not Review. Review is the pile of questions a
 * person answers one at a time; bank messages are a stream this phone reads for
 * itself, and the useful verbs over a stream are different — narrow it, search
 * it, tick several, place them together. Running both through one list put a
 * hundred rows nobody had looked at in front of the three that needed a
 * decision, which is the complaint that produced this file.
 *
 * Everything here is pure, and that is what lets the rules people actually
 * notice — "last 7 days means the last 7 days", "select all means the ones I
 * can see", "the total is the ticked rows and nothing else" — be pinned by
 * tests with no device and no clock of their own (mobile's vitest renders
 * nothing; see vitest.config.ts).
 *
 * ONE THING IT NEVER DOES. It never puts a message body in front of a filter.
 * Search matches the *facts* a row carries — the shop, the bank, the card tail,
 * the amount — and not the text, even though the text is right there on the row
 * now (`lib/smsMessageStore.ts` keeps it, on this device only). Searching the
 * body would be a real feature and a defensible one; it is left out because the
 * first version of it would quietly turn "what did I spend at Blue Tokai" into
 * a substring match over every one-time password the bank ever sent, and that
 * is a mistake worth not making by accident.
 */

import { SmsKind, SMS_LOW_CONFIDENCE, type SmsOtherReason } from '@waves/core';

import { SmsSettlement, type StoredSms } from './smsMessageTypes';

// ──────────────────────────────────────────────────── date filters ──

/**
 * How the list is narrowed by date.
 *
 * Three shapes, because the question has three shapes. A chip answers "what has
 * come in lately" in one tap and is what the screen opens on. A month is how
 * people think about a statement — "September" — and is what the stepper behind
 * the filter icon moves through. A range is for the trip that ran from the 14th
 * to the 22nd and does not respect a calendar.
 */
export type SmsDateFilter =
  | { readonly kind: 'window'; readonly days: SmsWindowDays }
  | { readonly kind: 'month'; readonly month: string }
  | { readonly kind: 'range'; readonly from: string; readonly to: string };

/** Quick windows, in days. `0` is everything there is. */
export const SMS_WINDOWS = [7, 30, 90, 0] as const;
export type SmsWindowDays = (typeof SMS_WINDOWS)[number];

export const ALL_TIME: SmsDateFilter = { kind: 'window', days: 0 };
export const DEFAULT_DATE_FILTER: SmsDateFilter = { kind: 'window', days: 30 };

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The inclusive `YYYY-MM-DD` bounds a filter admits. Null on either side means
 * unbounded that way.
 *
 * Compared against `occurredOn`, which is a plain date rather than an instant,
 * so the cut is made in dates too: "last 7 days" includes all of the day six
 * days ago, not the part of it later than this moment. A window that silently
 * dropped this morning's coffee at lunchtime would be a bug nobody could see.
 */
export function filterBounds(
  filter: SmsDateFilter,
  now: number,
): { from: string | null; to: string | null } {
  switch (filter.kind) {
    case 'window':
      return filter.days === 0
        ? { from: null, to: null }
        : { from: isoDay(now - (filter.days - 1) * DAY_MS), to: null };
    case 'month':
      // Lexical comparison does the work: every day in 2026-09 begins with it,
      // so the month needs no end date and no arithmetic about how long it is.
      return { from: `${filter.month}-01`, to: `${filter.month}-31` };
    case 'range':
      // Handed over either way round is still a range. A person dragging a
      // start date past the end should get the days between them, not nothing.
      return filter.from <= filter.to
        ? { from: filter.from, to: filter.to }
        : { from: filter.to, to: filter.from };
  }
}

/** `YYYY-MM` for the month a day falls in. */
export const monthOf = (day: string): string => day.slice(0, 7);

/**
 * The months this account has messages in, newest first.
 *
 * What the stepper walks: only months with something in them, so `<` and `>`
 * never land on an empty screen. A stepper that can reach a month with nothing
 * in it is a stepper people press twice and then stop trusting.
 */
export function monthsPresent(rows: readonly StoredSms[]): string[] {
  const months = new Set<string>();
  for (const row of rows) months.add(monthOf(row.occurredOn));
  return [...months].sort((a, b) => b.localeCompare(a));
}

/** The month before or after `month` that actually holds rows, or null at the end. */
export function stepMonth(
  months: readonly string[],
  month: string,
  direction: 'older' | 'newer',
): string | null {
  const index = months.indexOf(month);
  if (index === -1) return months[0] ?? null;
  const next = direction === 'older' ? index + 1 : index - 1;
  return months[next] ?? null;
}

// ──────────────────────────────────────────────────────────── search ──

/**
 * What a search is matched against: the shop, the bank, the card tail, the
 * currency and the amount as it is stored.
 *
 * Not the message — see the note at the top of this file.
 */
export function searchHaystack(row: StoredSms): string {
  return [row.merchant, row.sender, row.accountTail, row.currency, row.amount]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ')
    .toLowerCase();
}

/**
 * Does this row answer the query?
 *
 * Every whitespace-separated word must appear somewhere, in any order — so
 * "swiggy 250" finds the ₹250 Swiggy and not the ₹900 one, and typing more
 * always narrows. Substrings rather than word starts, because a bank writes
 * `SWIGGYLIMITED` and `AMZN*MKTP` and people type the middle of those as often
 * as the beginning.
 */
export function matchesQuery(row: StoredSms, query: string): boolean {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = searchHaystack(row);
  return words.every((word) => haystack.includes(word));
}

// ───────────────────────────────────────────────────────── the list ──

export interface SmsInboxInput {
  readonly rows: readonly StoredSms[];
  /** Which tab. */
  readonly kind: SmsKind;
  readonly query: string;
  readonly date: SmsDateFilter;
  /** Epoch ms for "now" — handed in, never `Date.now()` read while rendering. */
  readonly now: number;
  /** Include rows already placed or set aside. False by default. */
  readonly includeSettled?: boolean;
}

/**
 * The rows one tab shows, newest spend first.
 *
 * Sorted by the day the money moved rather than by when the message was read.
 * The two differ by up to ninety days after a backfill, and a list ordered by
 * the second is a list where a whole quarter arrives as one undifferentiated
 * lump under "today".
 *
 * Rows already dealt with are left out unless asked for. A message placed in a
 * group is not gone — it is in the ledger, and the toggle brings it back — but
 * a screen whose whole purpose is "what still needs looking at" should empty as
 * it is worked through, or nobody will ever reach the bottom of it.
 */
export function smsInboxRows(input: SmsInboxInput): StoredSms[] {
  const { from, to } = filterBounds(input.date, input.now);
  return input.rows
    .filter((row) => row.kind === input.kind)
    .filter((row) => (input.includeSettled ?? false) || row.settledAs === null)
    .filter((row) => (from === null ? true : row.occurredOn >= from))
    .filter((row) => (to === null ? true : row.occurredOn <= to))
    .filter((row) => matchesQuery(row, input.query))
    .sort((a, b) =>
      a.occurredOn === b.occurredOn
        ? b.at.localeCompare(a.at)
        : b.occurredOn.localeCompare(a.occurredOn),
    );
}

/** How many rows in each tab are still waiting — what the tab badges show. */
export function waitingCounts(rows: readonly StoredSms[]): Readonly<Record<SmsKind, number>> {
  const counts = { [SmsKind.Expense]: 0, [SmsKind.Income]: 0, [SmsKind.Other]: 0 };
  for (const row of rows) if (row.settledAs === null) counts[row.kind] += 1;
  return counts;
}

/** Everything still waiting, across all three tabs — the entry row's "82 new". */
export function totalWaiting(rows: readonly StoredSms[]): number {
  return rows.reduce((count, row) => (row.settledAs === null ? count + 1 : count), 0);
}

/**
 * Was the parser unsure about this row?
 *
 * The same two doubts Review marks, and for the same reason: the message named
 * no day, or only half of it was understood. A row carrying either is one to
 * look at before it becomes an expense, and the screen says which.
 */
export type SmsDoubt = 'date-inferred' | 'hard-to-read';

export function doubtsAbout(row: StoredSms): SmsDoubt[] {
  const doubts: SmsDoubt[] = [];
  if (row.dateInferred) doubts.push('date-inferred');
  if (row.confidence < SMS_LOW_CONFIDENCE) doubts.push('hard-to-read');
  return doubts;
}

/** True when this row was confident enough that Review already has it. */
export function reachedReview(row: StoredSms): boolean {
  return row.kind === SmsKind.Expense && doubtsAbout(row).length === 0;
}

/** The `other` reasons present in a set of rows, for the filter sheet's chips. */
export function reasonsPresent(rows: readonly StoredSms[]): SmsOtherReason[] {
  const reasons = new Set<SmsOtherReason>();
  for (const row of rows) if (row.reason) reasons.add(row.reason);
  return [...reasons].sort();
}

// ──────────────────────────────────────────────────────────── totals ──

export interface SmsTotal {
  /** How many rows are in the set, counted however they add up. */
  readonly count: number;
  /** What the countable ones come to, or null when none of them were. */
  readonly total: bigint | null;
  readonly currency: string;
  /**
   * Rows the total leaves out: a different currency, or an amount the ledger
   * could not read. Never hidden — a total that quietly skipped rows would be a
   * number the reader has no reason to doubt and no way to check.
   */
  readonly uncounted: number;
}

/**
 * What a set of rows comes to — the band under the tabs, and the selection bar.
 *
 * This used to answer "null" the moment anything in the set was awkward: one
 * row in another currency, or one amount the parser had mangled, and fifteen
 * perfectly good rupee rows showed no total at all. The band went blank, which
 * reads as a bug rather than as caution, and the reader is left adding a column
 * of numbers up by hand.
 *
 * So it counts what it can and says what it left out. The majority currency is
 * the first row's — these sets are one country's bank messages in practice, and
 * a foreign row or two is the exception the count names rather than the reason
 * to give up. Adding ₹400 to $12 still never happens: the dollar row is
 * excluded and reported, not converted.
 */
export function sumOf(rows: readonly StoredSms[]): SmsTotal {
  if (rows.length === 0) return { count: 0, total: null, currency: '', uncounted: 0 };
  const currency = rows[0]!.currency;

  let total = 0n;
  let counted = 0;
  let uncounted = 0;
  for (const row of rows) {
    if (row.currency !== currency) {
      uncounted += 1;
      continue;
    }
    // A row whose amount the ledger could not take is counted in `count` and
    // named in `uncounted`; `planCaptureAssign` reports it as unusable when it
    // is placed, so it is never silently lost either way.
    if (!/^-?\d+$/.test(row.amount.trim())) {
      uncounted += 1;
      continue;
    }
    total += BigInt(row.amount.trim());
    counted += 1;
  }

  return {
    count: rows.length,
    total: counted > 0 ? total : null,
    currency,
    uncounted,
  };
}

/** The ticked rows, in the order the list shows them. */
export function selectedRows(
  visible: readonly StoredSms[],
  selected: ReadonlySet<string>,
): StoredSms[] {
  return visible.filter((row) => selected.has(row.dedupeKey));
}

// ────────────────────────────────────────────────────────── ticking ──

/**
 * Tick or untick one row.
 *
 * A new set every time: the screen holds this in state, and a mutated set is a
 * set React cannot see has changed.
 */
export function toggleSelected(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Is everything currently on screen ticked? Drives the one control's label. */
export function allSelected(visible: readonly StoredSms[], selected: ReadonlySet<string>): boolean {
  return visible.length > 0 && visible.every((row) => selected.has(row.dedupeKey));
}

/**
 * The one control that both selects all and clears — never two buttons.
 *
 * "All" means all of what is *on screen*. A search narrowed to one shop and
 * then "select all" must not quietly tick the eighty rows the search hid: what
 * a person can see is what they are agreeing to, and a bulk action over rows
 * they never looked at is the one mistake this screen could make that costs
 * real money.
 */
export function toggleAll(
  visible: readonly StoredSms[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (allSelected(visible, selected)) {
    for (const row of visible) next.delete(row.dedupeKey);
    return next;
  }
  for (const row of visible) next.add(row.dedupeKey);
  return next;
}

/** True when a row has been dealt with, whichever way. */
export const isSettled = (row: StoredSms): boolean => row.settledAs !== null;

export { SmsSettlement };
