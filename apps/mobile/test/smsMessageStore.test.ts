/**
 * Bank messages are local, but local does not mean global to the phone.
 *
 * A shared device can hold a user, rider, traveller and financer one after
 * another. Clearing retained work for one account must not wipe another
 * account's inbox: the table key is `(owner_id, dedupe_key)` and cleanup has to
 * respect the same boundary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SmsKind } from '@waves/core';

const state = vi.hoisted(() => {
  class FakeSmsDatabase {
    readonly execs: string[] = [];
    readonly deletedOwners: string[] = [];
    dropped = false;

    reset(): void {
      this.execs.length = 0;
      this.deletedOwners.length = 0;
      this.dropped = false;
    }

    async execAsync(source: string): Promise<void> {
      this.execs.push(source.trim());
      if (source.includes('DROP TABLE IF EXISTS sms_messages')) this.dropped = true;
    }

    async runAsync(source: string, ...params: unknown[]): Promise<{ changes: number }> {
      if (/DELETE FROM sms_messages WHERE owner_id = \?/i.test(source)) {
        this.deletedOwners.push(params[0] as string);
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
      await task();
    }

    async getAllAsync(): Promise<unknown[]> {
      return [];
    }
  }

  return {
    database: new FakeSmsDatabase(),
    opens: 0,
    keys: 0,
  };
});

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    state.opens += 1;
    return state.database;
  },
}));

vi.mock('@/sync/rowCipher', () => ({
  decryptWith: () => '',
  encryptWith: () => '',
  loadKey: async () => {
    state.keys += 1;
    return { bytes: new Uint8Array(32) };
  },
}));

const store = await import('@/lib/smsMessageStore');

beforeEach(() => {
  state.database.reset();
  state.opens = 0;
  state.keys = 0;
});

describe('forgetMessagesForOwner', () => {
  it('deletes only the user, rider, traveller or financer being cleared', async () => {
    await store.forgetMessagesForOwner('traveller');

    expect(state.database.deletedOwners).toEqual(['traveller']);
    expect(state.database.dropped).toBe(false);
    expect(state.database.execs).toContain('PRAGMA wal_checkpoint(TRUNCATE)');
  });

  it('does nothing when there is no owner to clear', async () => {
    await store.forgetMessagesForOwner('');

    expect(state.opens).toBe(0);
    expect(state.database.deletedOwners).toEqual([]);
  });
});

describe('forgetEverything', () => {
  it('keeps the deliberate whole-store sign-out cleanup and checkpoints the WAL', async () => {
    await store.forgetEverything();

    expect(state.database.dropped).toBe(true);
    expect(state.database.deletedOwners).toEqual([]);
    expect(state.database.execs).toContain('PRAGMA wal_checkpoint(TRUNCATE)');
  });
});

// Proves the test still imports the same enum shape as the native store contract.
expect(SmsKind.Expense).toBe('expense');
