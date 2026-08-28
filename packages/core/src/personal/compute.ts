/**
 * The sums the personal-finance ledger shows, and the date maths behind a
 * recurring rule. All pure and side-effect free — `today` is passed in, never
 * read from the clock here — so the whole thing is unit-testable without a
 * device, which is the point of keeping it in core.
 */

import type { CurrencyCode } from '../money/currency';
import type {
  Cadence,
  PersonalBudget,
  PersonalLoan,
  PersonalRecurring,
  PersonalTxn,
} from './types';

// ─────────────────────────────────────────────────────── date helpers ──

interface Ymd {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

function parseYmd(date: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtYmd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Days in month `m` (1-12) of year `y`, leap years handled. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * `date` advanced by `interval` cadence units. Month/year steps clamp the day to
 * the target month's length (Jan 31 + 1 month → Feb 28/29), so a rule anchored
 * on the 31st never skips a short month. Weekly steps are exact 7-day hops.
 */
export function addToDate(date: string, cadence: Cadence, interval: number): string {
  const p = parseYmd(date);
  if (!p) return date;
  const step = interval > 0 ? Math.floor(interval) : 1;

  if (cadence === 'weekly') {
    const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 7 * step));
    return fmtYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (cadence === 'yearly') {
    const y = p.y + step;
    return fmtYmd(y, p.m, Math.min(p.d, daysInMonth(y, p.m)));
  }
  // monthly
  const total = p.m - 1 + step;
  const y = p.y + Math.floor(total / 12);
  const m = (total % 12) + 1;
  return fmtYmd(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** The YYYY-MM a date falls in. */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

/**
 * Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` precedes
 * `from`. Counted on the UTC calendar so a DST change never makes a day 23 or 25
 * hours — the same reason the recurring maths uses `Date.UTC`. 0 for a malformed
 * date, so a caller can render a fallback rather than crash. (Named `dayDelta`,
 * not `daysBetween`, to avoid colliding with the trip helper of that name, which
 * returns a range of dates.)
 */
export function dayDelta(from: string, to: string): number {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (!a || !b) return 0;
  const ta = Date.UTC(a.y, a.m - 1, a.d);
  const tb = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * The `count` month keys (YYYY-MM) ending at `month`, oldest first — the window
 * a short trend reads over. `recentMonths('2026-08', 3)` → `['2026-06',
 * '2026-07', '2026-08']`. Pure integer maths on the year/month, so it rolls year
 * boundaries without a `Date`. A malformed `month` or `count < 1` yields
 * `[month]` so a caller always has at least the anchor to show.
 */
export function recentMonths(month: string, count: number): string[] {
  const p = /^(\d{4})-(\d{2})$/.exec(month);
  if (!p || count < 1) return [month];
  const base = Number(p[1]) * 12 + (Number(p[2]) - 1);
  const out: string[] = [];
  for (let k = count - 1; k >= 0; k -= 1) {
    const idx = base - k;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    out.push(`${y}-${pad(m)}`);
  }
  return out;
}

// ────────────────────────────────────────────────────────── recurring ──

/** Whether a rule is live and its next occurrence is on or before `today`. */
export function isRecurringDue(rule: PersonalRecurring, today: string): boolean {
  if (!rule.active) return false;
  if (rule.endDate !== null && rule.nextDate > rule.endDate) return false;
  return rule.nextDate <= today;
}

export interface RecurringCatchUp {
  /** Every occurrence date from `nextDate` up to and including `today`. */
  readonly dates: readonly string[];
  /** Where the rule's `nextDate` should move to after these post. */
  readonly nextDate: string;
}

/**
 * Every occurrence a rule owes between its `nextDate` and `today` — more than
 * one when the app has not been opened in a while — plus where `nextDate` lands
 * afterwards. Capped so a far-past anchor can never mint an unbounded run.
 */
export function recurringCatchUp(
  rule: PersonalRecurring,
  today: string,
  cap = 60,
): RecurringCatchUp {
  const dates: string[] = [];
  let cursor = rule.nextDate;
  let guard = 0;
  while (cursor <= today && guard < cap) {
    if (rule.endDate !== null && cursor > rule.endDate) break;
    dates.push(cursor);
    cursor = addToDate(cursor, rule.cadence, rule.interval);
    guard += 1;
  }
  return { dates, nextDate: cursor };
}

/**
 * A stable record id for one occurrence of a recurring rule, derived from the
 * rule and the occurrence date. Deterministic on purpose: whichever path posts
 * an occurrence — the auto catch-up on open, or a manual "add now", even racing
 * — writes the *same* id, so the upsert-by-id collapses them to one row instead
 * of minting two UUIDs for the same date. Two FNV-1a passes fill a uuid-shaped
 * 32 hex string; Postgres's `uuid` accepts the grouping and a per-user ledger
 * makes a collision vanishingly unlikely.
 */
export function recurringOccurrenceId(ruleId: string, date: string): string {
  const seed = `${ruleId}:${date}`;
  const pass = (offset: number): string => {
    let hash = offset >>> 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  const hex = pass(0x811c9dc5) + pass(0x7ee3a5b1) + pass(0x243f6a88) + pass(0x9e3779b9);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface UpcomingRecurring {
  readonly rule: PersonalRecurring;
  /** The rule's next occurrence date (its `nextDate`). May be on or before
   *  `today` for a manual rule that has come due but not been posted. */
  readonly date: string;
}

/**
 * The soonest recurring occurrence still ahead — the "Upcoming: rent tomorrow"
 * the Me tab previews above the plain due count. The active, not-yet-ended rule
 * with the earliest `nextDate` wins; ties break on the rule id so the pick is
 * stable. `null` when nothing is scheduled. `today` bounds nothing here (the
 * soonest is shown whether it is future or an unposted overdue) — the caller
 * turns the gap into words with `dayDelta`.
 */
export function nextRecurring(
  recurrings: readonly PersonalRecurring[],
  // `today` is part of the signature so the caller reads naturally and a future
  // "only ahead of today" rule has a home; the current pick is the soonest
  // regardless, so it is not read yet.
  _today: string,
): UpcomingRecurring | null {
  let best: UpcomingRecurring | null = null;
  for (const rule of recurrings) {
    if (!rule.active) continue;
    if (rule.endDate !== null && rule.nextDate > rule.endDate) continue;
    if (
      best === null ||
      rule.nextDate < best.date ||
      (rule.nextDate === best.date && rule.id < best.rule.id)
    ) {
      best = { rule, date: rule.nextDate };
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────── summaries ──

export interface MonthlySummary {
  readonly income: bigint;
  readonly expense: bigint;
  /** income − expense; negative means you spent more than you took in. */
  readonly net: bigint;
}

/** Income, expense and net for one month and currency. */
export function monthlySummary(
  txns: readonly PersonalTxn[],
  month: string,
  currency: CurrencyCode,
): MonthlySummary {
  let income = 0n;
  let expense = 0n;
  for (const txn of txns) {
    if (txn.currency !== currency) continue;
    if (monthKey(txn.date) !== month) continue;
    if (txn.kind === 'income') income += txn.amount;
    else expense += txn.amount;
  }
  return { income, expense, net: income - expense };
}

/**
 * The share of a month's income that was kept: (income − expense) / income, as a
 * fraction. `null` when there was no income to measure against — a rate needs a
 * denominator, and "0% saved" would wrongly imply money came in and all went
 * out. Negative when spending ran past income (you dipped into savings).
 */
export function savingsRate(income: bigint, expense: bigint): number | null {
  if (income <= 0n) return null;
  return Number(income - expense) / Number(income);
}

export interface CategorySpend {
  /** The stored category value — a built-in key, a custom-tag id, or null for an
   *  uncategorised entry. The UI resolves it to a name and a colour. */
  readonly category: string | null;
  readonly spent: bigint;
  /** This category's share of the month's total spend, 0–1 (0 when nothing was
   *  spent). Kept as a float for a bar width; the money itself stays bigint. */
  readonly share: number;
}

/**
 * "Where did my money go" — one month's expense split by category, in a single
 * currency, sorted biggest spend first. Every expense txn counts (loan
 * repayments included, an uncategorised one under `null`) so the totals add up to
 * the month's `expense` in `monthlySummary` — the figure the hero shows. Ties
 * break on the category key so the order is stable between renders.
 */
export function categoryBreakdown(
  txns: readonly PersonalTxn[],
  month: string,
  currency: CurrencyCode,
): CategorySpend[] {
  const totals = new Map<string | null, bigint>();
  let total = 0n;
  for (const txn of txns) {
    if (txn.kind !== 'expense') continue;
    if (txn.currency !== currency) continue;
    if (monthKey(txn.date) !== month) continue;
    totals.set(txn.category, (totals.get(txn.category) ?? 0n) + txn.amount);
    total += txn.amount;
  }
  return [...totals]
    .sort((a, b) => (b[1] === a[1] ? keyOrder(a[0], b[0]) : b[1] > a[1] ? 1 : -1))
    .map(([category, spent]) => ({
      category,
      spent,
      // Integer maths first, then one divide — no float ever touches the money.
      share: total > 0n ? Number((spent * 10_000n) / total) / 10_000 : 0,
    }));
}

// Stable order for two category keys, nulls last.
function keyOrder(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export interface MonthCashflow extends MonthlySummary {
  readonly month: string;
}

/**
 * Income, expense and net for each of `months` (in the order given) in one
 * currency — the shape a short saved-vs-spent trend reads over. Each month is
 * just a `monthlySummary`, so the figures match the hero exactly. Pair it with
 * `recentMonths` to get the last N months ending at the browsed month.
 */
export function cashflowTrend(
  txns: readonly PersonalTxn[],
  months: readonly string[],
  currency: CurrencyCode,
): MonthCashflow[] {
  return months.map((month) => ({ month, ...monthlySummary(txns, month, currency) }));
}

// ─────────────────────────────────────────────────────────────── loans ──

/**
 * What is still outstanding on a loan: the principal less every repayment linked
 * to it (a txn carrying its `loanId`), floored at zero. A `borrowed` loan is
 * repaid with expense txns, a `lent` one with income txns; either way the linked
 * amounts reduce what remains, so the sum is over both.
 */
export function loanOutstanding(loan: PersonalLoan, txns: readonly PersonalTxn[]): bigint {
  let paid = 0n;
  for (const txn of txns) {
    if (txn.loanId === loan.id) paid += txn.amount;
  }
  const remaining = loan.principal - paid;
  return remaining > 0n ? remaining : 0n;
}

// ───────────────────────────────────────────────────────────── budgets ──

export interface PersonalBudgetProgress {
  readonly spent: bigint;
  readonly limit: bigint;
  /** limit − spent; negative means over budget. */
  readonly remaining: bigint;
  /** 0–1+ share of the cap used (0 when the cap is 0). */
  readonly ratio: number;
}

/**
 * Spend against one budget for a month: everyday expense txns in the budget's
 * currency, in that month, matching its category (or all categories for an
 * overall budget). Loan repayments are excluded — a budget is about spending,
 * not paying down a debt.
 */
export function personalBudgetProgress(
  budget: PersonalBudget,
  txns: readonly PersonalTxn[],
  month: string,
): PersonalBudgetProgress {
  let spent = 0n;
  for (const txn of txns) {
    if (txn.kind !== 'expense') continue;
    if (txn.loanId !== null) continue;
    if (txn.currency !== budget.currency) continue;
    if (monthKey(txn.date) !== month) continue;
    if (budget.category !== null && txn.category !== budget.category) continue;
    spent += txn.amount;
  }
  const remaining = budget.limit - spent;
  const ratio = budget.limit > 0n ? Number(spent) / Number(budget.limit) : 0;
  return { spent, limit: budget.limit, remaining, ratio };
}

export interface OverBudget {
  readonly budget: PersonalBudget;
  /** How far past the cap this month's spend ran, in minor units (always > 0). */
  readonly over: bigint;
}

/**
 * The single worst over-budget category this month — the one whose spend runs
 * furthest past its cap — so the Me tab can name it, not just count how many are
 * over. `null` when nothing is over budget. Ties break on the budget id so the
 * pick is stable.
 */
export function worstOverBudget(
  budgets: readonly PersonalBudget[],
  txns: readonly PersonalTxn[],
  month: string,
): OverBudget | null {
  let worst: OverBudget | null = null;
  for (const budget of budgets) {
    const { remaining } = personalBudgetProgress(budget, txns, month);
    if (remaining >= 0n) continue;
    const over = -remaining;
    if (
      worst === null ||
      over > worst.over ||
      (over === worst.over && budget.id < worst.budget.id)
    ) {
      worst = { budget, over };
    }
  }
  return worst;
}
