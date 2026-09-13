/**
 * One automatic pass over the inbox, as a pure function with its side effects
 * handed in.
 *
 * The three triggers — the backfill when permission is granted, the read when
 * the app comes forward, the hourly background check — are the same pass with
 * different reasons for running. Splitting the logic from the wiring here is
 * the same choice `smsReader.ts` makes, and for the same payoff: the rules that
 * matter (what window, what is skipped, when the clock advances) are unit
 * tested without a device, a permission or a WorkManager.
 *
 * ## The rules
 *
 * **Nothing read is ever written down.** `planAutoReadDrafts` calls
 * `planSmsDrafts` with every key in `readKeys` and no `bodies` at all, so every
 * draft this path makes has `rawText: null` — twice over, since `planSmsDrafts`
 * ignores bodies for read keys anyway. There is no way to spell "an automatic
 * draft that keeps its message" from here, which is the point.
 *
 * **A second read writes nothing a second time.** Two independent guarantees,
 * belt and braces:
 *
 *   1. `knownKeys` — every dedupe key this account already has a capture for,
 *      open or filed or deleted — is handed to `proposeFromSms` as
 *      `alreadyImported`, so a message already turned into a draft never
 *      becomes a candidate again. This is the cheap one, and it is what stops
 *      the hourly pass enqueuing work every hour for the overlap it deliberately
 *      re-reads.
 *   2. And when that misses — a device that has not yet synced the capture it
 *      made, two phones reading one inbox — the id is derived from the message
 *      (`smsCaptureId`), and `capture.create` answers a second arrival of an id
 *      it already owns with the success it already achieved. The database is
 *      what actually decides, as it is for a re-paste.
 *
 * **The clock only moves over ground actually covered.** `lastCheckedAt`
 * advances when the read succeeded *and* every draft it produced was written.
 * A read that failed, or a write that did, leaves it alone, so the next pass
 * covers the same ground rather than stepping over it. The window is floored at
 * the backfill horizon, so a phone that fails for a month does not eventually
 * ask for a decade of messages.
 *
 * **Nothing is reported anywhere.** No count, no merchant, no body reaches
 * Sentry, Clarity or any analytics — the prohibition `smsDrafts.ts` states at
 * length. The outcome is returned to the caller, which shows it on the screen
 * and nowhere else.
 */

import { proposeFromSms, type SmsMessage } from '@waves/core';

import { planSmsDrafts, type SmsDraft } from './smsDrafts';
import type { SmsReadFailure, SmsReadResult, SmsWindow } from './smsReader';

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

export interface AutoReadPlanInput {
  readonly messages: readonly SmsMessage[];
  /** Every dedupe key this account already has a capture for. */
  readonly knownKeys: ReadonlySet<string>;
}

/**
 * The messages this pass read, as drafts to write — bodies discarded.
 *
 * Every candidate is taken. Nobody is ticking boxes on this path, and the
 * alternative — writing only the confident ones — would silently drop the rest
 * forever, because the window moves past them and never comes back. A draft in
 * Review is already the lowest-stakes place in the app for a maybe: it costs a
 * swipe to be rid of, it is not on anybody's ledger, and its confidence rides
 * along in `parsed` so the screen can mark it. Losing a real expense without
 * ever mentioning it is the worse failure, and it is the invisible one.
 */
export function planAutoReadDrafts(input: AutoReadPlanInput): SmsDraft[] {
  // No window bounds: the read's own date filter is the fence, and a second one
  // here could only ever drop a message the first one deliberately let through.
  const candidates = proposeFromSms(input.messages, { alreadyImported: input.knownKeys });
  const keys = new Set(candidates.map((candidate) => candidate.dedupeKey));
  // `readKeys` is every key, and `bodies` is not passed at all. Both halves of
  // "a read message keeps no text" said in one call.
  return planSmsDrafts({ candidates, chosen: keys, readKeys: keys });
}

export interface AutoReadDeps {
  /** ISO instant for "now". */
  readonly now: () => string;
  readonly loadLastCheckedAt: () => Promise<string | null>;
  readonly saveLastCheckedAt: (at: string) => Promise<void>;
  /** Dedupe keys this account already has captures for. */
  readonly knownKeys: () => Promise<ReadonlySet<string>>;
  readonly read: (window: SmsWindow, maxCount: number) => Promise<SmsReadResult>;
  /** Queue one draft as a capture. Rejects if it could not be written down. */
  readonly write: (draft: SmsDraft) => Promise<void>;
  readonly backfillDays?: number;
  readonly overlapDays?: number;
  /** Cap for the ninety-day sweep; the incremental passes use `maxCount`. */
  readonly backfillMaxCount?: number;
  readonly maxCount?: number;
}

export interface AutoReadOutcome {
  /** True when the inbox was actually read. False means it refused. */
  readonly read: boolean;
  /** The first sweep, rather than an incremental one. */
  readonly backfill: boolean;
  /** How many drafts were written. Never reported anywhere but the screen. */
  readonly written: number;
  /** Set when `read` is false. */
  readonly failure?: SmsReadFailure;
  /** The new `lastCheckedAt`, or null when the clock did not move. */
  readonly checkedAt: string | null;
}

/** A sweep of ninety days may see more messages than an hour of them. */
const BACKFILL_MAX_COUNT = 1000;
const INCREMENTAL_MAX_COUNT = 200;

/**
 * Read what is new, write what it found, move the clock.
 *
 * Every failure is described rather than thrown: this runs from a background
 * worker and from a screen, and neither has anywhere useful to put an
 * exception.
 */
export async function runAutoRead(deps: AutoReadDeps): Promise<AutoReadOutcome> {
  const lastCheckedAt = await deps.loadLastCheckedAt();
  const backfill = isBackfill(lastCheckedAt);
  const now = deps.now();
  const window = autoReadWindow({
    now,
    lastCheckedAt,
    backfillDays: deps.backfillDays,
    overlapDays: deps.overlapDays,
  });
  const maxCount = backfill
    ? (deps.backfillMaxCount ?? BACKFILL_MAX_COUNT)
    : (deps.maxCount ?? INCREMENTAL_MAX_COUNT);

  const result = await deps.read(window, maxCount);
  if (!result.ok) {
    return { read: false, backfill, written: 0, failure: result.reason, checkedAt: null };
  }

  const drafts = planAutoReadDrafts({
    messages: result.messages,
    knownKeys: await deps.knownKeys(),
  });

  let written = 0;
  let refused = false;
  for (const draft of drafts) {
    try {
      await deps.write(draft);
      written += 1;
    } catch {
      // One draft that would not go down does not take the rest with it, and
      // it does hold the clock back so the next pass tries it again.
      refused = true;
    }
  }

  // The clock is the promise "everything up to here is in Review". A pass that
  // could not write part of what it read has not earned it.
  if (refused) return { read: true, backfill, written, checkedAt: null };

  await deps.saveLastCheckedAt(now);
  return { read: true, backfill, written, checkedAt: now };
}
