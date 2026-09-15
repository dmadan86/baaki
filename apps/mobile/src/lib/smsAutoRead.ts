/**
 * Waves reading bank messages by itself, on Android.
 *
 * The permission was already there and already granted; until now nothing used
 * it unless somebody opened a screen and asked. This is what uses it — and it
 * is the only file the rest of the app needs to know about, which is why the
 * state it publishes is an interface rather than a handful of exported
 * booleans. The Review screen renders `lastCheckedAt` as a sentence, offers
 * `refresh` as a manual check, and hides the lot when `enabled` is false.
 *
 * ## Three triggers, one pass
 *
 *   1. **The backfill.** The first time the gates all pass — which, for
 *      somebody who granted the permission before this shipped, is the first
 *      launch after it — the last ninety days are read at once. This is the
 *      moment the feature has to prove itself: Review should already be full of
 *      real spending the first time it is looked at, not empty with a promise
 *      about next month. It also runs the instant the permission is granted on
 *      the disclosure screen (`smsReader` says so through
 *      `onSmsPermissionGranted`), because that dialog does not move `AppState`
 *      and nothing else would notice.
 *
 *   2. **Coming forward.** `AppState` going `active` reads whatever is new. It
 *      is debounced by {@link QUIET_MS}: coming back from a share sheet, a
 *      camera or a permission dialog is a foreground event too, and re-reading
 *      the inbox every time somebody dismisses something would be a waste
 *      nobody asked for.
 *
 *   3. **The hourly check.** A WorkManager job, so the drafts are there before
 *      the app is opened rather than a second after. `smsAutoReadTask.ts` owns
 *      it, including — the part that matters — tearing it down.
 *
 * None of the three can overlap: they all go through one module-level promise,
 * and a second caller while a pass is in flight gets that same promise back
 * rather than a second read. The hourly job, when it wakes a process that is
 * already running, shares this module and therefore that promise; when it wakes
 * a dead one it has a JavaScript context to itself and there is nothing to
 * overlap with.
 *
 * ## What it never does
 *
 * It never asks for a permission — only checks one. It never reads on iOS, and
 * never because the flag alone is on. It never stores or syncs a message body
 * (`smsDrafts.bodyForDisplay` is the single decision and this path goes through
 * it, `smsAutoReadPass.ts` shows how). It never reports a body, a merchant or a
 * count to Sentry, Clarity or anything else. And it never says anything: no
 * notification, no toast, no badge raised from a background wake-up. The only
 * evidence it ran is that Review is up to date, which is the whole idea.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/lib/auth';

import { deviceGatesOpen, runAutoReadFor } from './smsAutoReadRun';
import {
  armAutoRead,
  backgroundCheckWanted,
  loadArmedOwner,
  loadLastCheckedAt,
  onSmsPermissionGranted,
} from './smsAutoReadStore';
// Imported for its side effect as much as its exports: defining the background
// task has to happen in the global scope of the bundle, and this is the import
// that puts it there in both the foreground process and a headless wake-up.
import { syncAutoReadSchedule, syncAutoReadTask } from './smsAutoReadTask';
import { useSmsInboxReaderVerdict, type SmsInboxReaderVerdict } from './smsFeature';

/**
 * How long after a read the next foreground event is ignored.
 *
 * Two minutes. Long enough that the several `active` events a single errand
 * produces — pick a photo, answer a dialog, come back from the messages app —
 * cost one read between them; short enough that putting the phone down for a
 * coffee and picking it up again reads what arrived meanwhile. A manual
 * `refresh` ignores it, because somebody asking is not somebody wandering back.
 */
export const QUIET_MS = 2 * 60 * 1000;

export interface SmsAutoReadState {
  /** Android, both gates, permission granted — the reader is live. */
  readonly enabled: boolean;
  /** When the inbox was last looked at. Null if never. ISO-8601. */
  readonly lastCheckedAt: string | null;
  /** A read is in flight right now. */
  readonly checking: boolean;
  /** Read now. Safe to call when disabled — resolves without doing anything. */
  readonly refresh: () => Promise<void>;
}

// ────────────────────────────────────────── the one live instance ──

/**
 * Module state, not React state.
 *
 * The hook can be mounted in several places at once — the driver at the root of
 * the app, and whatever the Review screen renders the sentence with — and every
 * one of them must see the same `checking` and the same `lastCheckedAt`. Two
 * copies of this in two components would read the inbox twice and disagree
 * about when.
 */
interface Snapshot {
  readonly enabled: boolean;
  readonly lastCheckedAt: string | null;
  readonly checking: boolean;
}

let snapshot: Snapshot = { enabled: false, lastCheckedAt: null, checking: false };
const listeners = new Set<() => void>();

function publish(patch: Partial<Snapshot>): void {
  const next = { ...snapshot, ...patch };
  if (
    next.enabled === snapshot.enabled &&
    next.lastCheckedAt === snapshot.lastCheckedAt &&
    next.checking === snapshot.checking
  ) {
    return;
  }
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** The pass in flight, if any. Every trigger waits on this one rather than starting a second. */
let inFlight: Promise<void> | null = null;
/** When the last pass started, for the foreground quiet window. */
let lastStartedAt = 0;

/**
 * Read, once, and publish what came of it.
 *
 * `force` is for the two moments that must not wait on the quiet window: the
 * ninety-day backfill, and somebody asking in as many words.
 */
function pass(ownerId: string, force: boolean): Promise<void> {
  if (inFlight) return inFlight;
  const startedAt = Date.now();
  if (!force && startedAt - lastStartedAt < QUIET_MS) return Promise.resolve();
  lastStartedAt = startedAt;

  publish({ checking: true });
  inFlight = (async () => {
    const outcome = await runAutoReadFor(ownerId);
    // A pass that could not finish leaves the clock where it was, and the
    // sentence on screen with it — saying "checked just now" about a read that
    // failed would be the one lie this feature cannot afford.
    publish({ lastCheckedAt: outcome.checkedAt ?? (await loadLastCheckedAt(ownerId)) });
  })()
    .catch(() => {
      // `runAutoReadFor` does not throw. This is the belt on the braces.
    })
    .finally(() => {
      inFlight = null;
      publish({ checking: false });
    });
  return inFlight;
}

/**
 * Work out where things stand, put the schedule there, and read if we may.
 *
 * The three verdicts are handled differently on purpose — see
 * `useSmsInboxReaderVerdict`. `'off'` tears the background job down, `'on'`
 * arms and schedules it, and `'unknown'` changes nothing at all: it means the
 * flag table has not come back, and a network that is having a bad minute is
 * not a decision about a feature.
 */
async function runEvaluate(ownerId: string, verdict: SmsInboxReaderVerdict): Promise<void> {
  if (!ownerId || verdict === 'off') {
    publish({ enabled: false, lastCheckedAt: null });
    await syncAutoReadTask(false);
    return;
  }

  // The permission is *checked*, never requested. A revoked one reads exactly
  // as a never-granted one, which is what revoking it is supposed to mean.
  const granted = await deviceGatesOpen();
  const lastCheckedAt = await loadLastCheckedAt(ownerId);

  if (!granted) {
    publish({ enabled: false, lastCheckedAt });
    // A permission taken away in Settings is a decision, whatever the flag
    // table is doing, so this tears down even while the verdict is unknown.
    await syncAutoReadTask(false);
    return;
  }

  if (verdict === 'unknown') {
    // Act on the last verdict that was actually reached, which is what the
    // armed record is. Nothing is scheduled or cancelled from here.
    const armed = await loadArmedOwner();
    publish({ enabled: armed === ownerId, lastCheckedAt });
    if (armed === ownerId) await pass(ownerId, lastCheckedAt === null);
    return;
  }

  publish({ enabled: true, lastCheckedAt });
  await armAutoRead(ownerId);
  // The hourly wake-up is a preference, not a gate. Off, the reader still does
  // everything it does here — the backfill and the read on the way in — and
  // simply stops waking the phone in between. On the phones whose manufacturer
  // stops background work anyway, that is what was happening in practice.
  await syncAutoReadSchedule(await backgroundCheckWanted());
  // The backfill is forced past the quiet window; an ordinary launch is not.
  await pass(ownerId, lastCheckedAt === null);
}

/** Evaluations already asked for, so two of them cannot interleave. */
let queued: Promise<void> = Promise.resolve();

/**
 * {@link runEvaluate}, one at a time.
 *
 * The hook can be mounted twice and each mount answers the same foreground
 * event, so two evaluations can be asked for in the same tick. Run together
 * they would race over the armed record and the registration; run in order they
 * are simply the same conclusion reached twice, and the second finds the read
 * already done. Serialising is a queue rather than a lock because dropping the
 * later call would be wrong — it is the one carrying the newer verdict.
 */
function evaluate(ownerId: string, verdict: SmsInboxReaderVerdict): Promise<void> {
  queued = queued.then(() => runEvaluate(ownerId, verdict)).catch(() => {});
  return queued;
}

// ──────────────────────────────────────────────────── the contract ──

/**
 * The automatic reader, as the rest of the app sees it.
 *
 * Safe to mount more than once: everything it drives is module-level and
 * guarded, so extra mounts add a subscription and nothing else.
 */
export function useSmsAutoRead(): SmsAutoReadState {
  const { session, loading } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const verdict = useSmsInboxReaderVerdict();

  const [local, setLocal] = useState<Snapshot>(snapshot);

  useEffect(() => {
    const listener = (): void => setLocal(snapshot);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Whenever the answer could have changed: a different account, a flag that
  // finally arrived, a permission that just got granted.
  //
  // Nothing happens while the session is still being restored. For the first
  // second of every launch there is no owner, and acting on that would cancel
  // the scheduled job on the way in and reschedule it a moment later — which
  // would restart WorkManager's clock on every launch, for a reason that is not
  // a decision about anything.
  useEffect(() => {
    if (loading) return;
    void evaluate(ownerId, verdict);
    return onSmsPermissionGranted(() => void evaluate(ownerId, verdict));
  }, [loading, ownerId, verdict]);

  // Coming back to the app, debounced. Not re-subscribed on every render: the
  // handler reads the current owner out of the closure, and the closure is
  // rebuilt only when the owner or the verdict moves.
  useEffect(() => {
    if (loading || !ownerId || verdict === 'off') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void evaluate(ownerId, verdict);
    });
    return () => subscription.remove();
  }, [loading, ownerId, verdict]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!snapshot.enabled || !ownerId) return;
    await pass(ownerId, true);
  }, [ownerId]);

  return {
    enabled: local.enabled,
    lastCheckedAt: local.lastCheckedAt,
    checking: local.checking,
    refresh,
  };
}

/**
 * Where the reader actually lives, mounted once at the root of the app.
 *
 * It renders nothing; it exists because the triggers above are effects and an
 * effect needs a component. Without it the reader would only run while the
 * screen that shows its state happened to be open, which is precisely backwards
 * — the point of the feature is that Review is already full when it is opened.
 *
 * Returns `null` rather than JSX so this file stays plain TypeScript, which is
 * what lets `@/lib/smsAutoRead` be the single import for the contract.
 */
export function SmsAutoRead(): null {
  useSmsAutoRead();
  return null;
}
