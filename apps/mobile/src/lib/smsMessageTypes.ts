/**
 * What a stored bank message is, kept apart from where it is stored.
 *
 * The store itself has two implementations — SQLite on a phone, nothing at all
 * on web (`smsMessageStore.ts` and `smsMessageStore.web.ts`) — and both must
 * mean the same thing by a message. Defining the shapes here rather than in the
 * native file is what lets the web stub stand in without importing it, and
 * importing it is exactly what would drag expo-sqlite's WASM build into a
 * browser bundle that has no use for it.
 *
 * Types only, plus one enum whose values are written to disk. Nothing here
 * reads, writes or reaches anything.
 */

import type { SmsKind, SmsOtherReason } from '@waves/core';

/**
 * What became of a message, once somebody answered it.
 *
 * The values are stored in the database, so they are written out rather than
 * numbered: a renumbered enum would silently reinterpret every row already on
 * a phone.
 */
export enum SmsSettlement {
  /** Placed into a group as an expense. `captureId` says which draft it became. */
  Placed = 'placed',
  /** Set aside deliberately: not an expense, or not worth splitting. */
  Dismissed = 'dismissed',
}

/** A message on its way in, before anybody has answered it. */
export interface IncomingSms {
  /** The message's own identity: the bank's reference, else amount and day. */
  readonly dedupeKey: string;
  /** The message itself. Only ever read on this device. */
  readonly body: string;
  readonly sender: string | null;
  readonly kind: SmsKind;
  /** Why it is in the third pile. Null unless `kind` is `Other`. */
  readonly reason: SmsOtherReason | null;
  readonly merchant: string | null;
  readonly accountTail: string | null;
  readonly currency: string;
  /** Minor units as a string — a bigint does not survive SQLite. */
  readonly amount: string;
  /** The day the money moved, `YYYY-MM-DD`. What the list sorts and filters on. */
  readonly occurredOn: string;
  /** The full instant, so the detail screen can show a time. */
  readonly at: string;
  readonly confidence: number;
  readonly dateInferred: boolean;
}

/** One stored message, as a screen reads it. */
export interface StoredSms extends IncomingSms {
  readonly settledAs: SmsSettlement | null;
  readonly captureId: string | null;
  /** When this phone read it — not when the bank sent it. */
  readonly readAt: string;
}
