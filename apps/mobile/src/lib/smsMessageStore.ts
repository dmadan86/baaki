/**
 * Bank messages, kept on this phone and nowhere else.
 *
 * This is the file that makes the promise on the Bank messages screen true, so
 * it is worth being exact about what the promise is. It is **not** "the app
 * keeps no copy" — the screen shows the original message when a row is opened,
 * and a search that matches the shop has to have something to match against.
 * It is "no copy leaves the device", and that is a structural claim, not a
 * careful one:
 *
 *   * This is a **separate database file** from `waves.db`. The sync engine
 *     reads exactly two tables — `mirror_rows` and `pending_mutations` — and
 *     neither is in this file. There is no code path, correct or buggy, that
 *     walks a table it never opens. A row here cannot be enqueued by accident
 *     because `enqueue` has no idea it exists.
 *   * Every body is **sealed at rest** with the same key the ledger mirror uses
 *     (`sync/rowCipher`), bound to its own row identity. A phone backup that
 *     carries the file without the Keystore entry carries ciphertext.
 *   * Signing out **destroys the file**, not merely its rows. The mirror's
 *     crypto-erase drops the key; this drops the data that key protected, so
 *     the two cannot end up in different states.
 *
 * WHAT SYNCS INSTEAD. When somebody ticks rows here and places them in a group,
 * the *facts* become captures and expenses the ordinary way — amount, shop,
 * day, card tail. The body stays here. `lib/smsDrafts.ts` states that rule at
 * length and enforces it; this is where the other half of it lives, which is
 * that a body has somewhere to be other than nowhere.
 *
 * AND NOTHING IS REPORTED. No count, no merchant, no sender reaches Sentry,
 * Clarity or any analytics from this file. A stack trace from a bank-message
 * store is exactly the kind of thing that carries somebody's shop into a
 * dashboard, so the catches here are silent on purpose.
 */

import * as SQLite from 'expo-sqlite';

import type { SmsKind, SmsOtherReason } from '@waves/core';

import { decryptWith, encryptWith, loadKey, type MirrorKey } from '@/sync/rowCipher';
import { Serial } from '@/sync/serial';

import { SmsSettlement, type IncomingSms, type StoredSms } from './smsMessageTypes';

// Re-exported so a screen imports the store and gets the shapes with it; the
// definitions live next door precisely so the web stub can share them without
// pulling SQLite into a browser bundle.
export { SmsSettlement } from './smsMessageTypes';
export type { IncomingSms, StoredSms } from './smsMessageTypes';

/**
 * Its own file, not a table in `waves.db`.
 *
 * Two connections to one file is the thing `sync/driver.ts` had to add a busy
 * timeout for, and the separation is the point besides: the sync engine's
 * database and the one holding message bodies have no reason to share a lock,
 * a transaction or a backup story.
 */
const DATABASE_NAME = 'waves-messages.db';

const AAD_SEP = '\x1f';
const bodyAad = (ownerId: string, key: string): string =>
  ['sms_messages', ownerId, key].join(AAD_SEP);

const SCHEMA = `
PRAGMA busy_timeout = 5000;
-- Zero freed pages rather than leaving their bytes in the free list. A deleted
-- message must actually be gone, and "gone" on a phone that may be handed to
-- somebody means the bytes too.
PRAGMA secure_delete = ON;
PRAGMA journal_mode = WAL;

-- One row per bank message this phone has read.
--
-- "dedupe_key" is the message's own identity (the bank's reference where there
-- is one, else amount and day), so reading the same inbox twice writes the same
-- row twice rather than making two. It is the primary key with the owner so two
-- accounts on one phone never see each other's messages.
--
-- "body" is the only sealed column, and the only one that is the message rather
-- than a fact about it. Everything beside it is what the parser concluded, kept
-- in the clear so the list can be filtered and searched without opening a
-- hundred ciphertexts to draw one screen.
CREATE TABLE IF NOT EXISTS sms_messages (
  owner_id     TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  body         TEXT NOT NULL,
  sender       TEXT,
  kind         TEXT NOT NULL,
  reason       TEXT,
  merchant     TEXT,
  account_tail TEXT,
  currency     TEXT NOT NULL,
  amount       TEXT NOT NULL,
  occurred_on  TEXT NOT NULL,
  at           TEXT NOT NULL,
  confidence   REAL NOT NULL,
  date_inferred INTEGER NOT NULL,
  -- Has a person dealt with this one? A row placed in a group, or set aside.
  -- Null while it is still waiting, which is what the "new" count counts.
  settled_as   TEXT,
  capture_id   TEXT,
  read_at      TEXT NOT NULL,
  PRIMARY KEY (owner_id, dedupe_key)
);

-- The list is always drawn for one account, one kind, newest first.
CREATE INDEX IF NOT EXISTS sms_messages_list_idx
  ON sms_messages (owner_id, kind, occurred_on DESC);
`;

interface MessageRow {
  dedupe_key: string;
  body: string;
  sender: string | null;
  kind: string;
  reason: string | null;
  merchant: string | null;
  account_tail: string | null;
  currency: string;
  amount: string;
  occurred_on: string;
  at: string;
  confidence: number;
  date_inferred: number;
  settled_as: string | null;
  capture_id: string | null;
  read_at: string;
}

const serial = new Serial();
let database: SQLite.SQLiteDatabase | null = null;
let opening: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * The open connection, opened once.
 *
 * A rejection is not remembered: a failure held in `opening` would be handed to
 * every later caller for the life of the process, so one unlucky moment at
 * launch would mean a screen that never works again until the app is killed.
 * `sync/driver.ts` learned this the same way.
 */
async function db(): Promise<SQLite.SQLiteDatabase> {
  if (database) return database;
  opening ??= (async () => {
    const opened = await SQLite.openDatabaseAsync(DATABASE_NAME);
    await opened.execAsync(SCHEMA);
    database = opened;
    return opened;
  })();
  try {
    return await opening;
  } catch (error) {
    opening = null;
    throw error;
  }
}

/** The sealing key, cached for the life of the process as the mirror's is. */
let key: MirrorKey | null = null;
async function cipherKey(): Promise<MirrorKey> {
  key ??= await loadKey();
  return key;
}

function toStored(row: MessageRow, body: string): StoredSms {
  return {
    dedupeKey: row.dedupe_key,
    body,
    sender: row.sender,
    kind: row.kind as SmsKind,
    reason: (row.reason as SmsOtherReason | null) ?? null,
    merchant: row.merchant,
    accountTail: row.account_tail,
    currency: row.currency,
    amount: row.amount,
    occurredOn: row.occurred_on,
    at: row.at,
    confidence: row.confidence,
    dateInferred: row.date_inferred === 1,
    settledAs: (row.settled_as as SmsSettlement | null) ?? null,
    captureId: row.capture_id,
    readAt: row.read_at,
  };
}

/**
 * Write what a scan found.
 *
 * `INSERT … ON CONFLICT DO NOTHING`, deliberately: a re-scan covers ground it
 * has already covered (the window overlaps by a day on purpose), and a row a
 * person has already placed or dismissed must not be reset to waiting by the
 * app reading the same message again. The first reading wins, and every one
 * after it is a no-op.
 *
 * Returns how many rows were actually new, which is what the screen reports as
 * "14 added" — the honest number, not the number of messages looked at.
 */
export async function saveMessages(
  ownerId: string,
  messages: readonly IncomingSms[],
): Promise<number> {
  if (!ownerId || messages.length === 0) return 0;
  const sealingKey = await cipherKey();
  const now = new Date().toISOString();

  return serial.run(async () => {
    const connection = await db();
    let added = 0;
    await connection.withTransactionAsync(async () => {
      for (const message of messages) {
        const sealed = encryptWith(sealingKey, message.body, bodyAad(ownerId, message.dedupeKey));
        const result = await connection.runAsync(
          `INSERT INTO sms_messages (
             owner_id, dedupe_key, body, sender, kind, reason, merchant, account_tail,
             currency, amount, occurred_on, at, confidence, date_inferred, read_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, dedupe_key) DO NOTHING`,
          ownerId,
          message.dedupeKey,
          sealed,
          message.sender,
          message.kind,
          message.reason,
          message.merchant,
          message.accountTail,
          message.currency,
          message.amount,
          message.occurredOn,
          message.at,
          message.confidence,
          message.dateInferred ? 1 : 0,
          now,
        );
        if (result.changes > 0) added += 1;
      }
    });
    return added;
  });
}

/**
 * Every message this account has, newest spend first.
 *
 * The whole set rather than a page: ninety days of one person's bank messages
 * is hundreds of rows, not thousands, and the screen filters, searches and
 * counts across all of them at once. Paging would mean a search that only
 * searched what had been scrolled to, which is worse than a list that is a
 * little slower to build.
 *
 * A body that will not open is skipped rather than fatal, and the row comes
 * back with an empty one — the facts beside it are still true and still useful,
 * and losing the whole screen because one ciphertext is bad (an Android
 * restore, a truncated write) would be the larger failure. `sync/driver.ts`
 * quarantines for the same reason.
 */
export async function loadMessages(ownerId: string): Promise<StoredSms[]> {
  if (!ownerId) return [];
  const sealingKey = await cipherKey();
  return serial.run(async () => {
    const connection = await db();
    const rows = await connection.getAllAsync<MessageRow>(
      `SELECT dedupe_key, body, sender, kind, reason, merchant, account_tail, currency,
              amount, occurred_on, at, confidence, date_inferred, settled_as, capture_id, read_at
         FROM sms_messages
        WHERE owner_id = ?
        ORDER BY occurred_on DESC, at DESC`,
      ownerId,
    );
    return rows.map((row) => {
      let body = '';
      try {
        body = decryptWith(sealingKey, row.body, bodyAad(ownerId, row.dedupe_key));
      } catch {
        // Nothing reported: see the file header. The row stays, bodyless.
      }
      return toStored(row, body);
    });
  });
}

/** Dedupe keys this account already holds — what a scan hands the classifier. */
export async function knownKeys(ownerId: string): Promise<Set<string>> {
  if (!ownerId) return new Set();
  return serial.run(async () => {
    const connection = await db();
    const rows = await connection.getAllAsync<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM sms_messages WHERE owner_id = ?`,
      ownerId,
    );
    return new Set(rows.map((row) => row.dedupe_key));
  });
}

/**
 * Mark messages as answered.
 *
 * Placing several rows in a group is one call: the screen ticks a dozen and
 * presses one button, and a dozen round trips through `Serial` would make that
 * button feel like it was thinking.
 */
export async function settleMessages(
  ownerId: string,
  keys: readonly string[],
  settlement: SmsSettlement,
  captureIdFor?: (key: string) => string | null,
): Promise<void> {
  if (!ownerId || keys.length === 0) return;
  await serial.run(async () => {
    const connection = await db();
    await connection.withTransactionAsync(async () => {
      for (const dedupeKey of keys) {
        await connection.runAsync(
          `UPDATE sms_messages SET settled_as = ?, capture_id = ?
            WHERE owner_id = ? AND dedupe_key = ?`,
          settlement,
          captureIdFor?.(dedupeKey) ?? null,
          ownerId,
          dedupeKey,
        );
      }
    });
  });
}

/** Put a message back in the waiting pile — the undo for a dismissal. */
export async function unsettleMessage(ownerId: string, dedupeKey: string): Promise<void> {
  if (!ownerId) return;
  await serial.run(async () => {
    const connection = await db();
    await connection.runAsync(
      `UPDATE sms_messages SET settled_as = NULL, capture_id = NULL
        WHERE owner_id = ? AND dedupe_key = ?`,
      ownerId,
      dedupeKey,
    );
  });
}

/** Take a message off this phone for good. */
export async function forgetMessage(ownerId: string, dedupeKey: string): Promise<void> {
  if (!ownerId) return;
  await serial.run(async () => {
    const connection = await db();
    await connection.runAsync(
      `DELETE FROM sms_messages WHERE owner_id = ? AND dedupe_key = ?`,
      ownerId,
      dedupeKey,
    );
  });
}

/**
 * Everything, gone — the sign-out path.
 *
 * The table is dropped and rebuilt rather than swept with a `DELETE`, so the
 * pages go back to the file empty instead of as a free list full of somebody's
 * bank messages. `PRAGMA secure_delete` already zeroes freed pages; this is the
 * belt on those braces, and it is cheap because the file is small.
 *
 * Called alongside the mirror's crypto-erase. The key is destroyed there, which
 * would already make every body here unopenable — but ciphertext nobody can
 * read is still somebody's inbox sitting on a disk, and the point of signing
 * out is that it is not there any more.
 */
export async function forgetEverything(): Promise<void> {
  await serial.run(async () => {
    const connection = await db();
    await connection.execAsync(`DROP TABLE IF EXISTS sms_messages;`);
    await connection.execAsync(SCHEMA);
  });
  key = null;
}
