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
