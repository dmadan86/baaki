/**
 * The web store.
 *
 * expo-sqlite's web build is WASM loaded in a worker over OPFS, which needs
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers that
 * neither the dev server nor a plain static export sends. A guest opening an
 * invite link (ADR-006) should not meet a blank screen over that, so web gets
 * AsyncStorage instead. Same interface, same engine, same tests.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { QueuedMutation } from '@baaki/core';

import { Serial } from './serial';
import type { LocalStore, StoredRow } from './store';

const WEB_KEYS = {
  rows: 'baaki:mirror',
  cursors: 'baaki:cursors',
  queue: 'baaki:queue',
  drafts: 'baaki:drafts',
} as const;

class AsyncStorageStore implements LocalStore {
  // Every entry point below is read-modify-write, so two overlapping callers
  // lose one of the two writes. Same lock as native, for a plainer reason.
  private readonly serial = new Serial();

  async ready(): Promise<void> {}

  private async read<T>(key: string, fallback: T): Promise<T> {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt blob is not worth crashing over; the next pull rebuilds it.
      return fallback;
    }
  }

  putRows(rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    return this.serial.run(async () => {
      const existing = await this.read<StoredRow[]>(WEB_KEYS.rows, []);
      const byKey = new Map(existing.map((row) => [`${row.table}:${row.id}`, row]));
      for (const row of rows) byKey.set(`${row.table}:${row.id}`, row);
      await AsyncStorage.setItem(WEB_KEYS.rows, JSON.stringify([...byKey.values()]));
    });
  }

  readRows(): Promise<StoredRow[]> {
    return this.serial.run(() => this.read<StoredRow[]>(WEB_KEYS.rows, []));
  }

  readCursors(): Promise<Record<string, number>> {
    return this.serial.run(() => this.read<Record<string, number>>(WEB_KEYS.cursors, {}));
  }

  writeCursors(cursors: Record<string, number>): Promise<void> {
    return this.serial.run(() => AsyncStorage.setItem(WEB_KEYS.cursors, JSON.stringify(cursors)));
  }

  readQueue(): Promise<QueuedMutation[]> {
    return this.serial.run(() => this.read<QueuedMutation[]>(WEB_KEYS.queue, []));
  }

  writeQueue(queue: readonly QueuedMutation[]): Promise<void> {
    return this.serial.run(() => AsyncStorage.setItem(WEB_KEYS.queue, JSON.stringify(queue)));
  }

  /** Unlocked on purpose: every caller already holds the lock. */
  private drafts(): Promise<Record<string, { value: unknown; savedAt: string }>> {
    return this.read<Record<string, { value: unknown; savedAt: string }>>(WEB_KEYS.drafts, {});
  }

  readDraft<T>(key: string): Promise<T | null> {
    return this.serial.run(async () => {
      const drafts = await this.drafts();
      return (drafts[key]?.value as T | undefined) ?? null;
    });
  }

  writeDraft(key: string, value: unknown): Promise<void> {
    return this.serial.run(async () => {
      const drafts = await this.drafts();
      drafts[key] = { value, savedAt: new Date().toISOString() };
      await AsyncStorage.setItem(WEB_KEYS.drafts, JSON.stringify(drafts));
    });
  }

  clearDraft(key: string): Promise<void> {
    return this.serial.run(async () => {
      const drafts = await this.drafts();
      delete drafts[key];
      await AsyncStorage.setItem(WEB_KEYS.drafts, JSON.stringify(drafts));
    });
  }

  listDrafts(): Promise<{ key: string; value: unknown; savedAt: string }[]> {
    return this.serial.run(async () => {
      const drafts = await this.drafts();
      return Object.entries(drafts)
        .map(([key, entry]) => ({ key, value: entry.value, savedAt: entry.savedAt }))
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    });
  }

  forgetGroup(groupId: string, queue: readonly QueuedMutation[]): Promise<void> {
    return this.serial.run(async () => {
      // AsyncStorage has no cross-key transaction, so web cannot make these three
      // writes atomic the way SQLite does — but the web store is best-effort by
      // design (a torn write is rebuilt by the next pull), so consolidating the
      // three writes here is as far as it goes; a journal would be a new
      // mechanism for a loss the next sync already heals.
      const rows = await this.read<StoredRow[]>(WEB_KEYS.rows, []);
      await AsyncStorage.setItem(
        WEB_KEYS.rows,
        JSON.stringify(rows.filter((row) => row.groupId !== groupId)),
      );
      const cursors = await this.read<Record<string, number>>(WEB_KEYS.cursors, {});
      delete cursors[groupId];
      await AsyncStorage.setItem(WEB_KEYS.cursors, JSON.stringify(cursors));
      await AsyncStorage.setItem(WEB_KEYS.queue, JSON.stringify(queue));
    });
  }

  reset(): Promise<void> {
    return this.serial.run(() => AsyncStorage.removeMany(Object.values(WEB_KEYS)));
  }
}

export function createLocalStore(): LocalStore {
  return new AsyncStorageStore();
}
