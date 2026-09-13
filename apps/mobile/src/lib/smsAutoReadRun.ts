/**
 * The device wiring for one automatic pass — the half `smsAutoReadPass.ts`
 * deliberately does not contain.
 *
 * Both the foreground driver (`smsAutoRead.ts`) and the hourly background task
 * (`smsAutoReadTask.ts`) come through here, so there is exactly one answer to
 * "may this phone read?" and exactly one thing a pass does, whichever woke the
 * app up.
 *
 * ## It is the same scan the button runs
 *
 * Everything that actually reads, sorts and writes lives in `smsScan.ts`, and
 * this hands it a window rather than a scope. That is the whole difference
 * between the two callers: a person pressing **Scan** picks one of two windows
 * off a sheet, and the automatic reader works out its own from the clock —
 * since the last successful pass, plus a day of overlap, floored at the
 * backfill horizon (`smsAutoReadPass.autoReadWindow`).
 *
 * Running one scan for both is not tidiness. It is the only way the promise
 * "the hourly job puts the same things in the same places" can be true without
 * being tested twice, and the reason the automatic path cannot drift into
 * writing a message body that the manual one would not.
 *
 * ## The clock, and what earns it
 *
 * `lastCheckedAt` is the claim "everything up to here is on the Bank messages
 * screen". A pass that could not read at all does not move it, so the next pass
 * covers the same ground rather than stepping over it. A pass that read and
 * saved does, even if some of what it found could not be turned into a draft —
 * the message is on the device either way, which is where that promise is about.
 *
 * ## What it does not need
 *
 * A session. `enqueue` is durable on disk before it resolves and the flush it
 * kicks off is opportunistic; a pass that runs with an expired token has still
 * done its job, and the drafts go up at the next foreground (ADR-005). That is
 * also why nothing here awaits a flush or reports one failing.
 */

import { autoReadWindow, isBackfill } from './smsAutoReadPass';
import { loadLastCheckedAt, saveLastCheckedAt } from './smsAutoReadStore';
import { deviceGatesOpen, runScan, type ScanResult } from './smsScan';

export { deviceGatesOpen } from './smsScan';

/**
 * How many messages an automatic pass will pull across the bridge.
 *
 * The ninety-day backfill may see far more than an hour of them, and the point
 * of the backfill is that the screen is full of real spending the first time it
 * is opened — a cap that truncated it would defeat that.
 */
const BACKFILL_MAX_COUNT = 1000;
const INCREMENTAL_MAX_COUNT = 200;

export interface AutoReadOutcome {
  /** True when the inbox was actually read. False means it refused, or could not. */
  readonly read: boolean;
  /** The first sweep, rather than an incremental one. */
  readonly backfill: boolean;
  /** How many messages were new to this phone. Never reported anywhere but a screen. */
  readonly written: number;
  /** The new `lastCheckedAt`, or null when the clock did not move. */
  readonly checkedAt: string | null;
}

/** Nothing happened, and nothing was wrong with that. */
const IDLE: AutoReadOutcome = { read: false, backfill: false, written: 0, checkedAt: null };

/**
 * Read this account's inbox once, if it may.
 *
 * Never throws. The callers are a background worker and a screen effect, and
 * neither has anywhere useful to put an exception — the worker would be
 * rescheduled having learned nothing, and the screen would show a person a
 * crash about something they never asked for.
 */
export async function runAutoReadFor(ownerId: string): Promise<AutoReadOutcome> {
  if (!ownerId) return IDLE;
  if (!(await deviceGatesOpen())) return IDLE;

  try {
    const lastCheckedAt = await loadLastCheckedAt(ownerId);
    const backfill = isBackfill(lastCheckedAt);
    const now = new Date().toISOString();

    const result: ScanResult = await runScan({
      ownerId,
      window: autoReadWindow({ now, lastCheckedAt }),
      maxCount: backfill ? BACKFILL_MAX_COUNT : INCREMENTAL_MAX_COUNT,
    });

    if (!result.ok) return { read: false, backfill, written: 0, checkedAt: null };

    await saveLastCheckedAt(ownerId, now);
    return { read: true, backfill, written: result.added, checkedAt: now };
  } catch {
    // No reporter on this path, on purpose: `smsDrafts.ts` states why, and a
    // stack trace from a bank-message parser is exactly the kind of thing that
    // carries a merchant name into somebody else's dashboard.
    return IDLE;
  }
}
