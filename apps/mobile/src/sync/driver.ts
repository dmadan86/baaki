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

import type { MirrorRow, QueuedMutation, SyncTable } from '@baaki/core';

import { Serial } from './serial';
import type { LocalStore, StoredRow } from './store';

const SCHEMA = `
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

  async putRows(rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.serial.run(async () => {
      const database = await this.db();
      // One transaction: a pull is one fact, and half of it landing after a kill
      // would leave the mirror ahead of its own cursor.
      await database.withTransactionAsync(async () => {
        for (const row of rows) {
          await database.runAsync(
            `INSERT INTO mirror_rows (table_name, id, group_id, seq, json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (table_name, id) DO UPDATE SET
               group_id = excluded.group_id, seq = excluded.seq, json = excluded.json`,
            [row.table, row.id, row.groupId, row.seq, JSON.stringify(row.row)],
          );
        }
      });
    });
  }

  readRows(): Promise<StoredRow[]> {
    return this.serial.run(async () => {
      const database = await this.db();
      const rows = await database.getAllAsync<{
        table_name: string;
        id: string;
        group_id: string;
        seq: number;
        json: string;
      }>(`SELECT table_name, id, group_id, seq, json FROM mirror_rows`);
      return rows.map((row) => ({
        table: row.table_name as SyncTable,
        id: row.id,
        groupId: row.group_id,
        seq: row.seq,
        row: JSON.parse(row.json) as MirrorRow,
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
      const rows = await database.getAllAsync<{ json: string }>(
        `SELECT json FROM pending_mutations ORDER BY seq ASC`,
      );
      return rows.map((row) => JSON.parse(row.json) as QueuedMutation);
    });
  }

  writeQueue(queue: readonly QueuedMutation[]): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      await database.withTransactionAsync(async () => {
        // `WHERE 1 = 1` for the same reason the server needs it: a bare DELETE
        // is the kind of statement that is one typo away from deleting
        // everything.
        await database.runAsync(`DELETE FROM pending_mutations WHERE 1 = 1`);
        for (const mutation of queue) {
          await database.runAsync(
            `INSERT INTO pending_mutations (client_mutation_id, seq, json) VALUES (?, ?, ?)`,
            [mutation.clientMutationId, mutation.seq, JSON.stringify(mutation)],
          );
        }
      });
    });
  }

  readDraft<T>(key: string): Promise<T | null> {
    return this.serial.run(async () => {
      const database = await this.db();
      const row = await database.getFirstAsync<{ json: string }>(
        `SELECT json FROM drafts WHERE key = ?`,
        [key],
      );
      return row ? (JSON.parse(row.json) as T) : null;
    });
  }

  writeDraft(key: string, value: unknown): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      await database.runAsync(
        `INSERT INTO drafts (key, json, saved_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at`,
        [key, JSON.stringify(value), new Date().toISOString()],
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
      const rows = await database.getAllAsync<{ key: string; json: string; saved_at: string }>(
        `SELECT key, json, saved_at FROM drafts ORDER BY saved_at DESC`,
      );
      return rows.map((row) => ({
        key: row.key,
        value: JSON.parse(row.json) as unknown,
        savedAt: row.saved_at,
      }));
    });
  }

  reset(): Promise<void> {
    return this.serial.run(async () => {
      const database = await this.db();
      await database.execAsync(`
        DELETE FROM mirror_rows WHERE 1 = 1;
        DELETE FROM pending_mutations WHERE 1 = 1;
        DELETE FROM sync_cursors WHERE 1 = 1;
        DELETE FROM drafts WHERE 1 = 1;
      `);
    });
  }
}

export function createLocalStore(): LocalStore {
  return new SqliteStore();
}
