/**
 * The native store: real SQLite, as ADR-005 asks for.
 *
 * Metro resolves this file everywhere except web, where `driver.web.ts` wins.
 *
 * Every public method goes through `Serial`. See that file for why: expo-sqlite
 * runs `withTransactionAsync` as a plain `BEGIN`/`COMMIT` pair on the shared
 * connection, so overlapping callers nest transactions, and the loser's
 * rollback discards the winner's work.
 */

import * as SQLite from 'expo-sqlite';

import type { MirrorRow, QueuedMutation, SyncTable } from '@waves/core';

import { mapYielding } from './hydrateChunk';
import { decryptWith, destroyKey, encryptWith, isSealed, loadKey } from './rowCipher';
import { Serial } from './serial';
import type { LocalStore, StoredRow } from './store';

// The mirror stores the whole ledger; every `json` payload is sealed at rest
// (see rowCipher.ts). Bump when the migration below needs to run again.
const SCHEMA_VERSION = 1;

const SCHEMA = `
-- Wait for a held lock instead of throwing SQLITE_BUSY the instant the file is
-- busy. In a production build there is one JS instance, one connection to this
-- file, and every write goes through Serial, so nothing in-process can contend.
-- The contention this guards against is a second connection left open by the
-- dev runtime: Fast Refresh / Reload builds a fresh SyncEngine and opens the
-- file again without closing the previous instance's handle, and a write racing
-- that orphan surfaced as "NativeStatement.finalizeAsync ... database is locked"
-- on screen. Five seconds is far longer than any real write here takes and lets
-- the loser wait out the lock rather than reject; it also hardens prod against a
-- rare WAL checkpoint overlap. Set FIRST, before the journal-mode change below,
-- so the busy handler is already active if that statement itself meets a lock.
PRAGMA busy_timeout = 5000;
-- Zero freed pages instead of leaving their bytes on disk. Sealed values are
-- still ciphertext, but this stops any legacy plaintext (or a shorter new
-- value's tail) from lingering in the file's free list after a delete/update.
PRAGMA secure_delete = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS mirror_rows (
  table_name TEXT NOT NULL,
  id         TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  json       TEXT NOT NULL,
  PRIMARY KEY (table_name, id)
);
CREATE INDEX IF NOT EXISTS mirror_rows_group_idx ON mirror_rows (group_id, table_name);

CREATE TABLE IF NOT EXISTS pending_mutations (
  client_mutation_id TEXT PRIMARY KEY,
  seq                INTEGER NOT NULL,
  json               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  group_id TEXT PRIMARY KEY,
  seq      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  key      TEXT PRIMARY KEY,
  json     TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
`;

class SqliteStore implements LocalStore {
  private database: SQLite.SQLiteDatabase | null = null;
  private opening: Promise<SQLite.SQLiteDatabase> | null = null;
  private readonly serial = new Serial();

  async ready(): Promise<void> {
    await this.db();
  }

  /**
   * The open connection, opening it once if need be.
   *
   * The failure is remembered only for as long as it is in flight. A rejected
   * promise left in `opening` would be handed to every later caller for the
   * life of the process, so one unlucky moment at launch — the previous
   * process still holding the file, a phone busy enough to time out — would
   * turn into an app that has permanently stopped saving anything.
   */
  private async db(): Promise<SQLite.SQLiteDatabase> {
    if (this.database) return this.database;
    this.opening ??= (async () => {
      const database = await SQLite.openDatabaseAsync('baaki.db');
      await database.execAsync(SCHEMA);
      await this.migrate(database);
      this.database = database;
      return database;
    })();
    try {
      return await this.opening;
    } catch (error) {
      this.opening = null;
      throw error;
    }
  }

  /**
   * Seal any pre-encryption plaintext left by an install that predates
   * at-rest encryption, once. Guarded by `PRAGMA user_version`: on a fresh
   * install (or after this has run) the version is already current and this is
   * a single cheap read. Reads pass legacy plaintext through transparently
   * (see `decryptWith`), so this is about not *leaving* plaintext on disk, not
   * about correctness of reads.
   */
  private async migrate(database: SQLite.SQLiteDatabase): Promise<void> {
    const current = await database.getFirstAsync<{ user_version: number }>(`PRAGMA user_version`);
    if ((current?.user_version ?? 0) >= SCHEMA_VERSION) return;

    const key = await loadKey();
    const tables: { name: string; pk: readonly string[] }[] = [
      { name: 'mirror_rows', pk: ['table_name', 'id'] },
      { name: 'pending_mutations', pk: ['client_mutation_id'] },
      { name: 'drafts', pk: ['key'] },
    ];
    await database.withTransactionAsync(async () => {
      for (const table of tables) {
        const rows = await database.getAllAsync<Record<string, string>>(
          `SELECT ${[...table.pk, 'json'].join(', ')} FROM ${table.name}`,
        );
        for (const row of rows) {
          if (isSealed(row.json)) continue;
          const where = table.pk.map((col) => `${col} = ?`).join(' AND ');
          await database.runAsync(`UPDATE ${table.name} SET json = ? WHERE ${where}`, [
            encryptWith(key, row.json),
            ...table.pk.map((col) => row[col] as string),
          ]);
        }
      }
    });
    // `user_version` takes a literal, not a bound parameter.
    await database.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    // Flush the WAL so any plaintext that lived there is truncated away rather
    // than kept alongside the now-sealed main file.
    await database.execAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
  }

  async putRows(rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.serial.run(async () => {
      const database = await this.db();
      const key = await loadKey();
      // One transaction: a pull is one fact, and half of it landing after a kill
      // would leave the mirror ahead of its own cursor.
      await database.withTransactionAsync(async () => {
        for (const row of rows) {
          await database.runAsync(
            `INSERT INTO mirror_rows (table_name, id, group_id, seq, json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (table_name, id) DO UPDATE SET
               group_id = excluded.group_id, seq = excluded.seq, json = excluded.json`,
            [row.table, row.id, row.groupId, row.seq, encryptWith(key, JSON.stringify(row.row))],
          );
        }
      });
    });
  }

  readRows(): Promise<StoredRow[]> {
    return this.serial.run(async () => {
      const database = await this.db();
      const key = await loadKey();
      const rows = await database.getAllAsync<{
        table_name: string;
        id: string;
        group_id: string;
        seq: number;
        json: string;
      }>(`SELECT table_name, id, group_id, seq, json FROM mirror_rows`);
      // Parse in chunks that yield to the event loop between them. This read is
      // the cold-start hydration path (see `hydrateChunk`): a heavy account's
      // whole mirror is decrypted and `JSON.parse`d here before `hydrated` flips,
      // and doing it in one synchronous burst froze the loading skeleton and the
      // first frame. The key is loaded once above; the per-row open is sync.
      return mapYielding(rows, (row) => ({
        table: row.table_name as SyncTable,
        id: row.id,
        groupId: row.group_id,
        seq: row.seq,
        row: JSON.parse(decryptWith(key, row.json)) as MirrorRow,
      }));
    });
  }

  readCursors(): Promise<Record<string, number>> {
    return this.serial.run(async () => {
      const database = await this.db();
      const rows = await database.getAllAsync<{ group_id: string; seq: number }>(
        `SELECT group_id, seq FROM sync_cursors`,
      );
      return Object.fromEntries(rows.map((row) => [row.group_id, row.seq]));
    });
  }

  writeCursors(cursors: Record<string, number>): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      await database.withTransactionAsync(async () => {
        // The map is the whole truth, as it is on web; a group absent from it
        // has no cursor.
        await database.runAsync(`DELETE FROM sync_cursors WHERE 1 = 1`);
        for (const [groupId, seq] of Object.entries(cursors)) {
          await database.runAsync(
            `INSERT INTO sync_cursors (group_id, seq) VALUES (?, ?)
             ON CONFLICT (group_id) DO UPDATE SET seq = excluded.seq`,
            [groupId, seq],
          );
        }
      });
    });
  }

  readQueue(): Promise<QueuedMutation[]> {
    return this.serial.run(async () => {
      const database = await this.db();
      const key = await loadKey();
      const rows = await database.getAllAsync<{ json: string }>(
        `SELECT json FROM pending_mutations ORDER BY seq ASC`,
      );
      return rows.map((row) => JSON.parse(decryptWith(key, row.json)) as QueuedMutation);
    });
  }

  writeQueue(queue: readonly QueuedMutation[]): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      const key = await loadKey();
      await database.withTransactionAsync(async () => {
        // `WHERE 1 = 1` for the same reason the server needs it: a bare DELETE
        // is the kind of statement that is one typo away from deleting
        // everything.
        await database.runAsync(`DELETE FROM pending_mutations WHERE 1 = 1`);
        for (const mutation of queue) {
          await database.runAsync(
            `INSERT INTO pending_mutations (client_mutation_id, seq, json) VALUES (?, ?, ?)`,
            [mutation.clientMutationId, mutation.seq, encryptWith(key, JSON.stringify(mutation))],
          );
        }
      });
    });
  }

  readDraft<T>(key: string): Promise<T | null> {
    return this.serial.run(async () => {
      const database = await this.db();
      const dek = await loadKey();
      const row = await database.getFirstAsync<{ json: string }>(
        `SELECT json FROM drafts WHERE key = ?`,
        [key],
      );
      return row ? (JSON.parse(decryptWith(dek, row.json)) as T) : null;
    });
  }

  writeDraft(key: string, value: unknown): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      const dek = await loadKey();
      await database.runAsync(
        `INSERT INTO drafts (key, json, saved_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at`,
        [key, encryptWith(dek, JSON.stringify(value)), new Date().toISOString()],
      );
    });
  }

  clearDraft(key: string): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      await database.runAsync(`DELETE FROM drafts WHERE key = ?`, [key]);
    });
  }

  listDrafts(): Promise<{ key: string; value: unknown; savedAt: string }[]> {
    return this.serial.run(async () => {
      const database = await this.db();
      const dek = await loadKey();
      const rows = await database.getAllAsync<{ key: string; json: string; saved_at: string }>(
        `SELECT key, json, saved_at FROM drafts ORDER BY saved_at DESC`,
      );
      return rows.map((row) => ({
        key: row.key,
        value: JSON.parse(decryptWith(dek, row.json)) as unknown,
        savedAt: row.saved_at,
      }));
    });
  }

  forgetGroup(groupId: string, queue: readonly QueuedMutation[]): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      const key = await loadKey();
      // All three in one transaction: the mirror rows, the cursor and the queue
      // are one fact — "this group is gone" — so a kill between them must not
      // leave the queue replaying against rows that no longer exist.
      await database.withTransactionAsync(async () => {
        await database.runAsync(`DELETE FROM mirror_rows WHERE group_id = ?`, [groupId]);
        await database.runAsync(`DELETE FROM sync_cursors WHERE group_id = ?`, [groupId]);
        await database.runAsync(`DELETE FROM pending_mutations WHERE 1 = 1`);
        for (const mutation of queue) {
          await database.runAsync(
            `INSERT INTO pending_mutations (client_mutation_id, seq, json) VALUES (?, ?, ?)`,
            [mutation.clientMutationId, mutation.seq, encryptWith(key, JSON.stringify(mutation))],
          );
        }
      });
    });
  }

  reset(): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      // The sign-out wipe is one fact — "this account's local data is gone" —
      // and it is a privacy promise, so it runs in a transaction like
      // `forgetGroup`. As a multi-statement `execAsync` (its previous form) a
      // process kill between the four DELETEs left a partial wipe, and the next
      // account on a shared phone could inherit the previous user's rows or
      // drafts. All four now commit together or not at all.
      await database.withTransactionAsync(async () => {
        await database.runAsync(`DELETE FROM mirror_rows WHERE 1 = 1`);
        await database.runAsync(`DELETE FROM pending_mutations WHERE 1 = 1`);
        await database.runAsync(`DELETE FROM sync_cursors WHERE 1 = 1`);
        await database.runAsync(`DELETE FROM drafts WHERE 1 = 1`);
      });
      // Crypto-erase: with the rows gone, drop the key too. Any ciphertext still
      // physically present in the WAL or free pages is now unrecoverable, and the
      // next account on this device mints a fresh key rather than inheriting this
      // one. `secure_delete` handled the bytes; this handles the key.
      await destroyKey();
    });
  }
}

export function createLocalStore(): LocalStore {
  return new SqliteStore();
}
