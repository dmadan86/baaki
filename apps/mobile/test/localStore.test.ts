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
  readonly mirrorRows = new Map<
    string,
    { table_name: string; id: string; group_id: string; seq: number; json: string }
  >();
  readonly pendingMutations = new Map<
    string,
    { client_mutation_id: string; seq: number; json: string }
  >();
  readonly cursors = new Map<string, number>();
  readonly drafts = new Map<string, { key: string; json: string; saved_at: string }>();

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

  async runAsync(source: string, params: unknown[] = []): Promise<void> {
    await this.enter(async () => {
      await tick();
      // Three tokens, so `INSERT INTO drafts` and `INSERT INTO
      // pending_mutations` stay tellable apart — the whole point of one test.
      const statement = source.trim().split(/\s+/).slice(0, 3).join(' ');
      this.statements.push(statement);

      if (statement === 'INSERT INTO mirror_rows') {
        const [tableName, id, groupId, seq, json] = params as [
          string,
          string,
          string,
          number,
          string,
        ];
        this.mirrorRows.set(`${tableName}:${id}`, {
          table_name: tableName,
          id,
          group_id: groupId,
          seq,
          json,
        });
        return;
      }
      if (statement === 'DELETE FROM mirror_rows') {
        if (source.includes('group_id = ?')) {
          const [groupId] = params as [string];
          for (const [key, row] of [...this.mirrorRows]) {
            if (row.group_id === groupId) this.mirrorRows.delete(key);
          }
        } else {
          this.mirrorRows.clear();
        }
        return;
      }
      if (statement === 'INSERT INTO pending_mutations') {
        const [clientMutationId, seq, json] = params as [string, number, string];
        this.pendingMutations.set(clientMutationId, {
          client_mutation_id: clientMutationId,
          seq,
          json,
        });
        return;
      }
      if (statement === 'DELETE FROM pending_mutations') {
        this.pendingMutations.clear();
        return;
      }
      if (statement === 'INSERT INTO sync_cursors') {
        const [groupId, seq] = params as [string, number];
        this.cursors.set(groupId, seq);
        return;
      }
      if (statement === 'DELETE FROM sync_cursors') {
        if (source.includes('group_id = ?')) {
          const [groupId] = params as [string];
          this.cursors.delete(groupId);
        } else {
          this.cursors.clear();
        }
        return;
      }
      if (statement === 'INSERT INTO drafts') {
        const [key, json, savedAt] = params as [string, string, string];
        this.drafts.set(key, { key, json, saved_at: savedAt });
        return;
      }
      if (statement === 'DELETE FROM drafts') {
        if (source.includes('key = ?')) {
          const [key] = params as [string];
          this.drafts.delete(key);
        } else {
          this.drafts.clear();
        }
      }
    });
  }

  async getAllAsync<T>(source = ''): Promise<T[]> {
    return this.enter(async () => {
      await tick();
      if (source.includes('FROM mirror_rows')) return [...this.mirrorRows.values()] as T[];
      if (source.includes('FROM sync_cursors')) {
        return [...this.cursors].map(([group_id, seq]) => ({ group_id, seq })) as T[];
      }
      if (source.includes('FROM pending_mutations')) {
        return [...this.pendingMutations.values()].sort((a, b) => a.seq - b.seq) as T[];
      }
      if (source.includes('FROM drafts')) {
        return [...this.drafts.values()].sort((a, b) =>
          b.saved_at.localeCompare(a.saved_at),
        ) as T[];
      }
      return [];
    });
  }

  async getFirstAsync<T>(_source = '', params: unknown[] = []): Promise<T | null> {
    return this.enter(async () => {
      await tick();
      const [key] = params as [string];
      return (this.drafts.get(key) as T | undefined) ?? null;
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

describe('native local store lifecycle', () => {
  it('round-trips rows, cursors, queue and drafts through SQLite', async () => {
    const store = createLocalStore();

    await store.ready();
    await store.putRows([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1', amount: '100' } },
      { table: 'expenses', id: 'e2', groupId: 'g2', seq: 2, row: { id: 'e2', amount: '200' } },
    ] as never);
    await store.putRows([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 3, row: { id: 'e1', amount: '300' } },
    ] as never);
    await store.writeCursors({ g1: 3, g2: 2 });
    await store.writeQueue([mutation('b'), mutation('a')]);
    await store.writeDraft('later', { amount: 200 });
    await store.writeDraft('earlier', { amount: 100 });

    expect(await store.readRows()).toEqual([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 3, row: { id: 'e1', amount: '300' } },
      { table: 'expenses', id: 'e2', groupId: 'g2', seq: 2, row: { id: 'e2', amount: '200' } },
    ]);
    expect(await store.readCursors()).toEqual({ g1: 3, g2: 2 });
    expect((await store.readQueue()).map((entry) => entry.clientMutationId)).toEqual(['b', 'a']);
    expect(await store.readDraft('later')).toEqual({ amount: 200 });
    expect((await store.listDrafts()).map((draft) => draft.key).sort()).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('forgets one group, its cursor, and replaces the queue in one transaction', async () => {
    const store = createLocalStore();
    await store.putRows([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1' } },
      { table: 'expenses', id: 'e2', groupId: 'g2', seq: 2, row: { id: 'e2' } },
    ] as never);
    await store.writeCursors({ g1: 1, g2: 2 });
    await store.writeQueue([mutation('a'), mutation('b')]);

    await store.forgetGroup('g1', [mutation('b')]);

    expect(await store.readRows()).toEqual([
      { table: 'expenses', id: 'e2', groupId: 'g2', seq: 2, row: { id: 'e2' } },
    ]);
    expect(await store.readCursors()).toEqual({ g2: 2 });
    expect((await store.readQueue()).map((entry) => entry.clientMutationId)).toEqual(['b']);
  });

  it('clears drafts and resets all persisted tables', async () => {
    const store = createLocalStore();
    await store.putRows([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1' } },
    ] as never);
    await store.writeCursors({ g1: 1 });
    await store.writeQueue([mutation('a')]);
    await store.writeDraft('expense:new', { amount: 100 });

    await store.clearDraft('expense:new');
    expect(await store.readDraft('expense:new')).toBeNull();

    await store.writeDraft('expense:new', { amount: 100 });
    await store.reset();

    expect(await store.readRows()).toEqual([]);
    expect(await store.readCursors()).toEqual({});
    expect(await store.readQueue()).toEqual([]);
    expect(await store.listDrafts()).toEqual([]);
  });

  it('hydrates a large mirror without dropping rows on the chunked parse path', async () => {
    const store = createLocalStore();
    const rows = Array.from({ length: 1_025 }, (_, index) => ({
      table: 'expenses',
      id: `e${index}`,
      groupId: `g${index % 3}`,
      seq: index + 1,
      row: { id: `e${index}`, amount: String(index) },
    }));

    await store.putRows(rows as never);

    const hydrated = await store.readRows();
    expect(hydrated).toHaveLength(rows.length);
    expect(hydrated[0]).toEqual(rows[0]);
    expect(hydrated[512]).toEqual(rows[512]);
    expect(hydrated[1024]).toEqual(rows[1024]);
  });

  it('does not open SQLite when asked to persist no rows', async () => {
    const store = createLocalStore();

    await store.putRows([]);

    expect(openCalls).toBe(0);
    expect(database.statements).toEqual([]);
  });
});
