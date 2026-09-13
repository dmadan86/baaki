/**
 * The device wiring for one automatic pass — the half `smsAutoReadPass.ts`
 * deliberately does not contain.
 *
 * Both the foreground driver (`smsAutoRead.ts`) and the hourly background task
 * (`smsAutoReadTask.ts`) come through here, so there is exactly one answer to
 * "may this phone read?" and exactly one way a draft gets written, whichever
 * woke the app up.
 *
 * ## Why the write does not go through `useCreateCapture`
 *
 * Because a WorkManager wake-up has no React tree. The hook is a thin wrapper
 * over `syncEngine.enqueue` and a session lookup, and both of those are
 * reachable without one: the engine is a module singleton, and the owner is the
 * account the foreground armed this for. The payload is built by the hook's own
 * `serialiseCapture`, imported rather than re-typed, so an automatic draft and
 * a hand-made one are the same row by construction.
 *
 * The engine has to be hydrated first, and that is not a formality: `enqueue`
 * appends to the queue it holds in memory and writes the whole thing back, so
 * enqueuing onto an unhydrated engine would persist a queue of one and drop
 * every unsent mutation on the phone. In the common case — the app is alive and
 * the worker is running in its process — it is already hydrated and this costs
 * a property read.
 *
 * ## What the background pass does not need
 *
 * A session. `enqueue` is durable on disk before it resolves and the flush it
 * kicks off is opportunistic; a pass that runs with an expired token has still
 * done its job, and the drafts go up at the next foreground (ADR-005). That is
 * also why nothing here awaits a flush or reports one failing.
 */

import { randomUUID } from 'expo-crypto';

import { materialiseCaptures, MutationKind, type MutationEnvelope } from '@waves/core';

import { serialiseCapture } from '@/data/hooks';
import { syncEngine } from '@/sync';

import { smsCaptureId } from './smsCaptureId';
import type { SmsDraft } from './smsDrafts';
import { smsReaderInBuild } from './smsFeature';
import { runAutoRead, type AutoReadOutcome } from './smsAutoReadPass';
import { loadLastCheckedAt, saveLastCheckedAt } from './smsAutoReadStore';
import { readSmsGranted, smsPermissionGranted } from './smsReader';

/**
 * The two gates that can be answered without a network or a React tree.
 *
 * The third — the `sms_inbox_read` treatment arm — cannot: it is computed from
 * a flag table fetched over the wire against the profile id. The foreground
 * driver evaluates it and records the verdict by arming the background task
 * (`smsAutoReadStore.armAutoRead`), which is what a headless pass reads in its
 * place. Never the reverse: nothing here can switch the reader *on*.
 */
export async function deviceGatesOpen(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as typeof import('react-native');
  if (Platform.OS !== 'android') return false;
  if (!smsReaderInBuild()) return false;
  return smsPermissionGranted();
}

/** Make sure the queue we are about to append to is the one on disk. */
async function ensureHydrated(): Promise<void> {
  if (syncEngine.getState().hydrated) return;
  await syncEngine.hydrate();
}

/**
 * Every dedupe key this account already has a capture for.
 *
 * Deliberately *not* `openCaptures`: a draft already filed into a group, or
 * deleted, is still a message that has been dealt with, and re-proposing it
 * would put somebody's already-entered dinner back in Review every hour until
 * they deleted it twice.
 */
function knownDedupeKeys(ownerId: string): ReadonlySet<string> {
  const { mirror, queue } = syncEngine.getState();
  const keys = new Set<string>();
  for (const capture of materialiseCaptures(mirror, queue, { ownerId })) {
    const key = (capture.parsed as { dedupeKey?: unknown } | null)?.dedupeKey;
    if (typeof key === 'string') keys.add(key);
  }
  return keys;
}

/** One draft onto the queue, under the id the message itself determines. */
async function writeDraft(ownerId: string, draft: SmsDraft): Promise<void> {
  const captureId = await smsCaptureId(ownerId, draft.dedupeKey);
  const envelope: MutationEnvelope = {
    clientMutationId: randomUUID(),
    kind: MutationKind.CaptureCreate,
    // The personal sync scope: a capture belongs to an account, not a group.
    groupId: ownerId,
    clientCreatedAt: new Date().toISOString(),
    payload: serialiseCapture(
      {
        description: draft.description,
        category: draft.category,
        expenseDate: draft.expenseDate,
        currency: draft.currency,
        amount: draft.amount,
        // Null, always, on this path. `planSmsDrafts` is what decides it and
        // `smsAutoReadPass` is what calls it; this only carries the answer.
        rawText: draft.rawText,
        parsed: { ...draft.parsed },
      },
      captureId,
    ),
  };
  await syncEngine.enqueue(envelope);
}

/** Nothing happened, and nothing was wrong with that. */
const IDLE: AutoReadOutcome = {
  read: false,
  backfill: false,
  written: 0,
  checkedAt: null,
};

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
    await ensureHydrated();
    return await runAutoRead({
      now: () => new Date().toISOString(),
      loadLastCheckedAt: () => loadLastCheckedAt(ownerId),
      saveLastCheckedAt: (at) => saveLastCheckedAt(ownerId, at),
      knownKeys: async () => knownDedupeKeys(ownerId),
      read: (window, maxCount) => readSmsGranted(window, maxCount),
      write: (draft) => writeDraft(ownerId, draft),
    });
  } catch {
    // No reporter on this path, on purpose: `smsDrafts.ts` states why, and a
    // stack trace from a bank-message parser is exactly the kind of thing that
    // carries a merchant name into somebody else's dashboard.
    return IDLE;
  }
}
