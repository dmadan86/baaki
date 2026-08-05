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

import type { LocalStore, StoredRow } from './store';

const WEB_KEYS = {
  rows: 'baaki:mirror',
  cursors: 'baaki:cursors',
  queue: 'baaki:queue',
  drafts: 'baaki:drafts',
} as const;

class AsyncStorageStore implements LocalStore {
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

  async putRows(rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    const existing = await this.readRows();
    const byKey = new Map(existing.map((row) => [`${row.table}:${row.id}`, row]));
    for (const row of rows) byKey.set(`${row.table}:${row.id}`, row);
    await AsyncStorage.setItem(WEB_KEYS.rows, JSON.stringify([...byKey.values()]));
  }

  readRows(): Promise<StoredRow[]> {
    return this.read<StoredRow[]>(WEB_KEYS.rows, []);
  }

  readCursors(): Promise<Record<string, number>> {
    return this.read<Record<string, number>>(WEB_KEYS.cursors, {});
  }

  async writeCursors(cursors: Record<string, number>): Promise<void> {
    await AsyncStorage.setItem(WEB_KEYS.cursors, JSON.stringify(cursors));
  }

  readQueue(): Promise<QueuedMutation[]> {
    return this.read<QueuedMutation[]>(WEB_KEYS.queue, []);
  }

  async writeQueue(queue: readonly QueuedMutation[]): Promise<void> {
    await AsyncStorage.setItem(WEB_KEYS.queue, JSON.stringify(queue));
  }

  private drafts(): Promise<Record<string, { value: unknown; savedAt: string }>> {
    return this.read<Record<string, { value: unknown; savedAt: string }>>(WEB_KEYS.drafts, {});
  }

  async readDraft<T>(key: string): Promise<T | null> {
    const drafts = await this.drafts();
    return (drafts[key]?.value as T | undefined) ?? null;
  }

  async writeDraft(key: string, value: unknown): Promise<void> {
    const drafts = await this.drafts();
    drafts[key] = { value, savedAt: new Date().toISOString() };
    await AsyncStorage.setItem(WEB_KEYS.drafts, JSON.stringify(drafts));
  }

  async clearDraft(key: string): Promise<void> {
    const drafts = await this.drafts();
    delete drafts[key];
    await AsyncStorage.setItem(WEB_KEYS.drafts, JSON.stringify(drafts));
  }

  async listDrafts(): Promise<{ key: string; value: unknown; savedAt: string }[]> {
    const drafts = await this.drafts();
    return Object.entries(drafts)
      .map(([key, entry]) => ({ key, value: entry.value, savedAt: entry.savedAt }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async reset(): Promise<void> {
    await AsyncStorage.multiRemove(Object.values(WEB_KEYS));
  }
}

export function createLocalStore(): LocalStore {
  return new AsyncStorageStore();
}
