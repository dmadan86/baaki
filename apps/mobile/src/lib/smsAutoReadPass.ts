/**
 * How far back an automatic pass reaches — the clock, and nothing else.
 *
 * This file used to hold the whole automatic pass: the parse, the writes, the
 * rule about bodies, the lot. All of that now lives in `smsScan.ts`, which the
 * **Scan** button runs too — one scan, so the automatic path cannot drift into
 * doing something the manual one would not, and neither has to be tested twice.
 *
 * What is left is the one thing an automatic pass has that a manual one does
 * not: a memory of when it last succeeded, and therefore an opinion about which
 * dates to ask for. That opinion is worth keeping pure and worth keeping here,
 * because it is where the two failure modes live — a window that creeps forward
 * over ground it never covered, and a window that grows without bound after a
 * run of failures. Both are silent, and both are caught by tests that need no
 * device, no permission and no WorkManager.
 */

import type { SmsWindow } from './smsReader';

/**
 * How far back the first read reaches.
 *
 * Ninety days is the backfill, and it is chosen to be the moment the feature
 * proves itself rather than to be complete: a quarter is long enough that the
 * Review screen is full of real, recognisable spending the first time it is
 * opened, and short enough that the read is one sweep of a few hundred messages
 * rather than a walk through a decade of an inbox.
 */
export const BACKFILL_DAYS = 90;

/**
 * How much already-read ground each incremental pass covers again.
 *
 * A day, because the native filter works in dates rather than instants and
 * because the two clocks involved disagree: `date` on an SMS row is when the
 * handset *received* it, which a delayed delivery, a timezone or a phone that
 * was off can push either side of when the payment happened. Re-reading a day
 * costs a few hundred parses of pure JavaScript and writes nothing (see
 * `knownKeys`); missing a day loses an expense with no trace.
 */
export const OVERLAP_DAYS = 1;

const DAY_MS = 86_400_000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface AutoReadWindowInput {
  /** ISO instant for "now". Injected so a test can stand anywhere in time. */
  readonly now: string;
  readonly lastCheckedAt: string | null;
  readonly backfillDays?: number;
  readonly overlapDays?: number;
}

/**
 * The dates this pass should ask the inbox for.
 *
 * Never earlier than the backfill horizon, so the window cannot grow without
 * bound after a long run of failures, and never later than today.
 */
export function autoReadWindow(input: AutoReadWindowInput): SmsWindow {
  const now = Date.parse(input.now);
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const backfillDays = input.backfillDays ?? BACKFILL_DAYS;
  const overlapDays = input.overlapDays ?? OVERLAP_DAYS;

  const horizon = nowMs - backfillDays * DAY_MS;
  const last = input.lastCheckedAt === null ? NaN : Date.parse(input.lastCheckedAt);
  // A `lastCheckedAt` in the future — a clock that was wrong and got fixed —
  // must not produce a window that ends before it starts.
  const since = Number.isFinite(last) ? Math.min(last - overlapDays * DAY_MS, nowMs) : horizon;

  return { from: day(Math.max(since, horizon)), to: day(nowMs) };
}

/** True when this pass is the first one for this account: the ninety-day sweep. */
export const isBackfill = (lastCheckedAt: string | null): boolean => lastCheckedAt === null;
