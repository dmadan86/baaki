/**
 * One scan of the inbox, with something to watch while it happens.
 *
 * The reader used to work invisibly: a pass ran on a foreground event or an
 * hourly alarm, drafts appeared in Review some time later, and the only
 * evidence anything had happened was that a list had got longer while nobody
 * was looking. That is the right behaviour for a background job and the wrong
 * one for the moment a person taps **Scan** — a button that returns instantly
 * and changes a number somewhere else is a button nobody believes twice.
 *
 * So a scan is an *event* here, with three stages a person can see:
 *
 *   1. **Reading** — the native call, indeterminate. It is one round trip into
 *      Android's SMS provider and it has no progress to report; pretending
 *      otherwise with a fake bar would be a small lie told every time.
 *   2. **Sorting** — the parse, in batches of {@link CHUNK}, reporting how far
 *      through it is. Batching is not only for the bar: parsing nine hundred
 *      messages is several hundred milliseconds of synchronous regex work, and
 *      without a yield between batches the progress bar would be painted once,
 *      at the end, on a frozen thread.
 *   3. **Saving** — writing to the on-device store, then turning the confident
 *      expenses into drafts.
 *
 * ## What it writes, and where
 *
 * **Every message goes to the device store** (`smsMessageStore`), whichever
 * pile it fell in — expense, income, or neither. That store never syncs.
 *
 * **Only confident expenses become captures.** A capture syncs, and it appears
 * in Review, which is the list of things waiting on a person. Putting every
 * half-read message there would make Review a place to avoid, and a draft made
 * from a message the parser only half understood is a question, not an answer.
 * Those stay on the Bank messages screen, where somebody can tick them
 * deliberately. Nothing is lost either way: the message is on the device and
 * the screen shows it.
 *
 * **A capture made here still carries no message body**, exactly as before.
 * `planSmsDrafts` is handed every key as a read key and no bodies at all, so
 * `rawText` is null by construction — twice over, since it ignores bodies for
 * read keys anyway.
 *
 * ## What it never does
 *
 * It never asks for a permission, only checks one. It never reports a count, a
 * merchant or a body to Sentry, Clarity or anything else — the prohibition
 * `smsDrafts.ts` states at length. And it never throws: the callers are a
 * screen, a foreground effect and a headless WorkManager wake-up, and none of
 * them has anywhere useful to put an exception.
 */

import { randomUUID } from 'expo-crypto';

import {
  classifySms,
  materialiseCaptures,
  MutationKind,
  SmsKind,
  type ClassifiedSms,
  type MutationEnvelope,
  type SmsMessage,
} from '@waves/core';

import { serialiseCapture } from '@/data/hooks';
import { syncEngine } from '@/sync';

import { smsCaptureId } from './smsCaptureId';
import type { SmsDraft } from './smsDrafts';
import { smsReaderInBuild } from './smsFeature';
import { knownKeys, saveMessages } from './smsMessageStore';
import {
  readSmsGranted,
  smsPermissionGranted,
  type SmsReadFailure,
  type SmsWindow,
} from './smsReader';
import { draftsFor, scanMaxCount, scanWindow, toIncoming, type ScanScope } from './smsScanPlan';

// The decisions a scan makes live next door, so they can be tested without
// booting React Native, expo-crypto and the sync engine to check arithmetic.
// Re-exported here so a caller imports one module and gets the whole feature.
export * from './smsScanPlan';

/**
 * Messages parsed between yields.
 *
 * A hundred is about 20–40ms of regex work on a mid-range phone: long enough
 * that the per-batch overhead is noise, short enough that the frame after it
 * still lands inside a person's sense of "moving".
 */
const CHUNK = 100;

/** What a scan is doing right now — rendered straight onto the screen. */
export type ScanProgress =
  | { readonly stage: 'reading' }
  | { readonly stage: 'sorting'; readonly done: number; readonly total: number }
  | { readonly stage: 'saving'; readonly done: number; readonly total: number };

/** What a scan found. Shown once, on the screen that asked for it, and nowhere else. */
export interface ScanResult {
  /** False when the inbox could not be read at all; `failure` then says why. */
  readonly ok: boolean;
  readonly failure?: SmsReadFailure;
  /** How many messages the phone handed over. */
  readonly scanned: number;
  /** New rows written to the device store — not the number looked at. */
  readonly added: number;
  readonly expenses: number;
  readonly income: number;
  readonly other: number;
  /**
   * Messages that plainly described money moving and could not be read.
   * The one number that says the parser has a gap — see `classifySms`.
   */
  readonly unreadable: number;
  /** How many of the new expenses were confident enough to reach Review. */
  readonly drafted: number;
  /** When this finished, ISO-8601. Null when the scan did not complete. */
  readonly finishedAt: string | null;
}

const NOTHING: ScanResult = {
  ok: false,
  scanned: 0,
  added: 0,
  expenses: 0,
  income: 0,
  other: 0,
  unreadable: 0,
  drafted: 0,
  finishedAt: null,
};

/** Let the thread paint before it is tied up again. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * The two gates that need no network and no React tree.
 *
 * The third — the `sms_inbox_read` treatment arm — is a flag fetched against
 * the profile, evaluated by the foreground driver. Nothing here can switch the
 * reader *on*; it can only decline.
 */
export async function deviceGatesOpen(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as typeof import('react-native');
  if (Platform.OS !== 'android') return false;
  if (!smsReaderInBuild()) return false;
  return smsPermissionGranted();
}

/**
 * Sort a batch of messages at a time, yielding in between.
 *
 * Dedupe is carried across batches by hand: `classifySms` only knows about the
 * messages in front of it, so each batch is told the keys every batch before it
 * produced. Without that, a bank alert that arrived twice in one scan but
 * landed either side of a batch boundary would become two rows.
 */
async function sortInBatches(
  messages: readonly SmsMessage[],
  seen: Set<string>,
  onProgress: (progress: ScanProgress) => void,
): Promise<{ rows: ClassifiedSms[]; unreadable: number }> {
  const rows: ClassifiedSms[] = [];
  let unreadable = 0;

  for (let index = 0; index < messages.length; index += CHUNK) {
    const batch = messages.slice(index, index + CHUNK);
    const sorted = classifySms(batch, { alreadySeen: seen });
    for (const row of [...sorted.expenses, ...sorted.income, ...sorted.other]) {
      seen.add(row.dedupeKey);
      rows.push(row);
    }
    unreadable += sorted.unreadable;
    onProgress({
      stage: 'sorting',
      done: Math.min(index + CHUNK, messages.length),
      total: messages.length,
    });
    await nextFrame();
  }

  return { rows, unreadable };
}

/** Make sure the queue we are about to append to is the one on disk. */
async function ensureHydrated(): Promise<void> {
  if (syncEngine.getState().hydrated) return;
  await syncEngine.hydrate();
}

/**
 * Every dedupe key this account already has a capture for.
 *
 * Deliberately not just the open ones: a draft already filed into a group, or
 * deleted, is still a message that has been dealt with, and re-proposing it
 * would put somebody's already-entered dinner back in Review every hour.
 */
function captureKeys(ownerId: string): Set<string> {
  const { mirror, queue } = syncEngine.getState();
  const keys = new Set<string>();
  for (const capture of materialiseCaptures(mirror, queue, { ownerId })) {
    const key = (capture.parsed as { dedupeKey?: unknown } | null)?.dedupeKey;
    if (typeof key === 'string') keys.add(key);
  }
  return keys;
}

/**
 * One draft onto the queue, under the id the message itself determines.
 *
 * Not through `useCreateCapture` because a WorkManager wake-up has no React
 * tree — but through the same `serialiseCapture` the hook uses, so an automatic
 * draft and a hand-made one are the same row by construction.
 */
export async function writeDraft(ownerId: string, draft: SmsDraft): Promise<string> {
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
        // Null, always, on this path.
        rawText: draft.rawText,
        parsed: { ...draft.parsed },
      },
      captureId,
    ),
  };
  await syncEngine.enqueue(envelope);
  return captureId;
}

export interface ScanInput {
  readonly ownerId: string;
  /**
   * The dates to ask for, and the ceiling on how many messages come back.
   *
   * Handed in rather than derived from a scope, because there are two callers
   * with two different ideas of what a window is. A person pressing **Scan**
   * picks one of {@link ScanScope}'s two. The automatic reader works from its
   * own clock instead (`smsAutoReadPass.autoReadWindow`): as far back as the
   * last successful pass, plus a day of overlap, floored at the backfill
   * horizon. Making this take a window is what lets both go through one scan.
   */
  readonly window: SmsWindow;
  readonly maxCount: number;
  readonly onProgress?: (progress: ScanProgress) => void;
}

/** A scan for one of the two scopes a person can choose. */
export function scanFor(
  ownerId: string,
  scope: ScanScope,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  return runScan({
    ownerId,
    window: scanWindow(scope, Date.now()),
    maxCount: scanMaxCount(scope),
    onProgress,
  });
}

/**
 * Read the inbox once, sort it, keep it, and draft what is beyond doubt.
 *
 * Never throws. Every failure comes back described, because a screen showing a
 * stack trace about a bank-message parser is both useless and a leak.
 */
export async function runScan(input: ScanInput): Promise<ScanResult> {
  const report = input.onProgress ?? ((): void => {});
  if (!input.ownerId) return NOTHING;
  if (!(await deviceGatesOpen())) return NOTHING;

  try {
    report({ stage: 'reading' });
    const result = await readSmsGranted(input.window, input.maxCount);
    if (!result.ok) {
      return { ...NOTHING, failure: result.reason, finishedAt: null };
    }

    // Seeded with what the device store already holds, so a re-scan over ground
    // it has covered before produces no rows rather than rows that are then
    // thrown away by the database.
    const seen = new Set(await knownKeys(input.ownerId));
    const { rows, unreadable } = await sortInBatches(result.messages, seen, report);

    report({ stage: 'saving', done: 0, total: rows.length });
    const added = await saveMessages(input.ownerId, rows.map(toIncoming));

    // Drafts only for messages this account has no capture for already. The
    // device store's dedupe does not cover this: a phone restored from a backup
    // has an empty message store and a full ledger.
    await ensureHydrated();
    const already = captureKeys(input.ownerId);
    const drafts = draftsFor(rows.filter((row) => !already.has(row.dedupeKey)));

    let drafted = 0;
    for (const draft of drafts) {
      try {
        await writeDraft(input.ownerId, draft);
        drafted += 1;
      } catch {
        // One draft that will not go down does not take the rest with it. The
        // message is in the device store either way, so nothing is lost — it
        // simply waits on the Bank messages screen instead of reaching Review.
      }
      report({ stage: 'saving', done: drafted, total: drafts.length });
    }

    return {
      ok: true,
      scanned: result.messages.length,
      added,
      expenses: rows.filter((row) => row.kind === SmsKind.Expense).length,
      income: rows.filter((row) => row.kind === SmsKind.Income).length,
      other: rows.filter((row) => row.kind === SmsKind.Other).length,
      unreadable,
      drafted,
      finishedAt: new Date().toISOString(),
    };
  } catch {
    // No reporter on this path, on purpose — `smsDrafts.ts` says why.
    return NOTHING;
  }
}
