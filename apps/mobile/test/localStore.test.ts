/**
 * The local store under two callers at once.
 *
 * This is the shape of the bug that produced `Call to function
 * 'NativeDatabase.prepareAsync' has been rejected.` on cold start. Nothing in
 * the app calls the store from one place: a flush persisting a server answer,
 * a keystroke saving a draft and a tap queueing a mutation are all in flight
 * within the same second of launch.
 *
 * expo-sqlite's `withTransactionAsync` is — in its own source — `BEGIN`,
 * the task, `COMMIT`, run on the *shared* connection. So a second caller's
 * `BEGIN` arrives inside the first one's transaction, SQLite refuses it, and
 * the rollback that follows throws away work that belonged to somebody else.
 * The fake below is faithful about exactly that and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuedMutation } from '@waves/core';

/** A pause long enough for another caller to interleave, if it can. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeDatabase {
  inTransaction = false;
  /** Statements that actually ran, in order. */
  readonly statements: string[] = [];
  /** How deep the nesting got. More than one means the lock is not working. */
  concurrent = 0;
  private live = 0;

  private async enter<T>(run: () => Promise<T>): Promise<T> {
    this.live += 1;
    this.concurrent = Math.max(this.concurrent, this.live);
    try {
      return await run();
    } finally {
      this.live -= 1;
    }
  }

  async execAsync(source: string): Promise<void> {
    await this.enter(async () => {
      await tick();
      const command = source.trim().split(/\s+/)[0]?.toUpperCase();
      if (command === 'BEGIN') {
        if (this.inTransaction) {
          throw new Error('cannot start a transaction within a transaction');
        }
        this.inTransaction = true;
      } else if (command === 'COMMIT' || command === 'ROLLBACK') {
        if (!this.inTransaction) {
          throw new Error(`cannot ${command.toLowerCase()} - no transaction is active`);
        }
        this.inTransaction = false;
      }
      this.statements.push(source.trim());
    });
  }

  async runAsync(source: string): Promise<void> {
    await this.enter(async () => {
      await tick();
      // Three tokens, so `INSERT INTO drafts` and `INSERT INTO
      // pending_mutations` stay tellable apart — the whole point of one test.
      this.statements.push(source.trim().split(/\s+/).slice(0, 3).join(' '));
    });
  }

  async getAllAsync<T>(): Promise<T[]> {
    return this.enter(async () => {
      await tick();
      return [];
    });
  }

  async getFirstAsync<T>(): Promise<T | null> {
    return this.enter(async () => {
      await tick();
      return null;
    });
  }

  // Copied in shape from expo-sqlite's own implementation, which is the whole
  // point: it is not atomic against anything else using this connection.
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    try {
      await this.execAsync('BEGIN');
      await task();
      await this.execAsync('COMMIT');
    } catch (error) {
      await this.execAsync('ROLLBACK');
      throw error;
    }
  }
}

let database: FakeDatabase;
let openCalls = 0;
let failNextOpen = false;

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    openCalls += 1;
    await tick();
    if (failNextOpen) {
      failNextOpen = false;
      throw new Error('unable to open database file');
    }
    return database;
  },
}));

const { createLocalStore } = await import('../src/sync/driver');

const mutation = (id: string): QueuedMutation =>
  ({
    clientMutationId: id,
    seq: 1,
    kind: 'expense.create',
    groupId: 'g1',
    clientCreatedAt: '2026-01-01T00:00:00.000Z',
    payload: {},
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }) as unknown as QueuedMutation;

beforeEach(() => {
  database = new FakeDatabase();
  openCalls = 0;
  failNextOpen = false;
});

describe('two callers, one connection', () => {
  it('does not nest one transaction inside another', async () => {
    const store = createLocalStore();

    // The cold-start shape: the queue being written while a pull is persisting
    // rows, which is what a tap during the first flush actually looks like.
    await Promise.all([
      store.writeQueue([mutation('a')]),
      store.putRows([
        { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1' } },
      ] as never),
      store.writeCursors({ g1: 1 }),
    ]);

    expect(database.concurrent).toBe(1);
    expect(database.inTransaction).toBe(false);
    expect(database.statements.filter((s) => s === 'ROLLBACK')).toEqual([]);
  });

  it('keeps a bare write out of somebody else’s transaction', async () => {
    const store = createLocalStore();

    // A draft save is a single statement with no transaction of its own, so
    // without the lock it lands between another caller's BEGIN and COMMIT.
    await Promise.all([
      store.writeQueue([mutation('a')]),
      store.writeDraft('expense:new', { a: 1 }),
    ]);

    const begin = database.statements.indexOf('BEGIN');
    const commit = database.statements.indexOf('COMMIT');
    const draft = database.statements.indexOf('INSERT INTO drafts');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    // Either wholly before the transaction or wholly after it, never inside.
    expect(draft < begin || draft > commit).toBe(true);
  });

  it('runs the work in the order it was asked for', async () => {
    const store = createLocalStore();
    const order: string[] = [];

    await Promise.all([
      store.writeQueue([mutation('a')]).then(() => order.push('queue')),
      store.writeDraft('k', 1).then(() => order.push('draft')),
      store.clearDraft('k').then(() => order.push('clear')),
    ]);

    expect(order).toEqual(['queue', 'draft', 'clear']);
  });
});

describe('an open that fails', () => {
  it('lets the next call try again instead of failing forever', async () => {
    const store = createLocalStore();
    failNextOpen = true;

    await expect(store.readQueue()).rejects.toThrow('unable to open database file');

    // The whole point: one bad moment at launch must not leave an app that has
    // permanently stopped saving anything until it is killed and reopened.
    await expect(store.readQueue()).resolves.toEqual([]);
    expect(openCalls).toBe(2);
  });

  it('opens once and once only when it works', async () => {
    const store = createLocalStore();
    await Promise.all([store.readQueue(), store.readRows(), store.readCursors()]);
    expect(openCalls).toBe(1);
  });
});
