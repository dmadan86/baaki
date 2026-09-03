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
  // Defaults to the current schema version so the one-time encryption migration
  // (driver.migrate) is a no-op for these tests; the migration is exercised on
  // its own below by seeding a fresh DB at version 0.
  userVersion = 1;

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
      const setVersion = source.trim().match(/^PRAGMA\s+user_version\s*=\s*(\d+)/i);
      if (setVersion) this.userVersion = Number(setVersion[1]);
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
        // The store holds back rows it could not decrypt (`clearQueueRows`), so
        // this has to honour the NOT IN clause rather than always clearing.
        if (source.includes('NOT IN')) {
          const held = new Set(params as string[]);
          for (const id of [...this.pendingMutations.keys()]) {
            if (!held.has(id)) this.pendingMutations.delete(id);
          }
          return;
        }
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
        return;
      }
      // Used only by the one-time encryption migration.
      if (statement === 'UPDATE mirror_rows SET') {
        const [json, tableName, id] = params as [string, string, string];
        const rec = this.mirrorRows.get(`${tableName}:${id}`);
        if (rec) rec.json = json;
        return;
      }
      if (statement === 'UPDATE pending_mutations SET') {
        const [json, clientMutationId] = params as [string, string];
        const rec = this.pendingMutations.get(clientMutationId);
        if (rec) rec.json = json;
        return;
      }
      if (statement === 'UPDATE drafts SET') {
        const [json, key] = params as [string, string];
        const rec = this.drafts.get(key);
        if (rec) rec.json = json;
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

  async getFirstAsync<T>(source = '', params: unknown[] = []): Promise<T | null> {
    return this.enter(async () => {
      await tick();
      if (source.includes('user_version')) return { user_version: this.userVersion } as T;
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

// The store now seals every json payload (see rowCipher.ts), which pulls in the
// keystore and the RNG. In-memory stand-ins: a Map for SecureStore, Node's own
// CSPRNG for expo-crypto. The crypto itself (@noble/ciphers) is pure JS and runs
// for real, so these tests exercise the true encrypt/decrypt round-trip.
const secure = vi.hoisted(() => ({
  keystore: new Map<string, string>(),
  deletes: [] as string[],
  gets: 0,
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: async (key: string) => {
    secure.gets += 1;
    return secure.keystore.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    secure.keystore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secure.deletes.push(key);
    secure.keystore.delete(key);
  },
}));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
}));

// The store reports a quarantined row through the app's Sentry wrapper, which
// statically imports @sentry/react-native (and through it react-native itself —
// Flow syntax vitest cannot parse). Only the call matters here, so the module is
// replaced by a spy and the reports are asserted below.
const reports = vi.hoisted(() => [] as { error: unknown; where: string }[]);

vi.mock('@/lib/observability', () => ({
  reportHandled: (error: unknown, where: string) => {
    reports.push({ error, where });
  },
}));

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
const { destroyKey } = await import('../src/sync/rowCipher');

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
  secure.keystore.clear();
  secure.deletes = [];
  secure.gets = 0;
  reports.length = 0;
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
    expect(openCalls).toBe(1);
    expect(secure.gets).toBeLessThanOrEqual(2);
    // Generous timeout: 1k fake statements each yield a macrotask, plus a real
    // encrypt/decrypt per row — slow on a loaded Windows timer, not a defect.
  }, 20000);

  it('round-trips a large encrypted offline queue with one keystore load', async () => {
    const store = createLocalStore();
    const queue = Array.from({ length: 1_000 }, (_, index) => mutation(`m${index}`));

    await store.writeQueue(queue);
    const read = await store.readQueue();

    expect(read).toHaveLength(queue.length);
    expect(read[0]?.clientMutationId).toBe('m0');
    expect(read[999]?.clientMutationId).toBe('m999');
    expect(secure.gets).toBeLessThanOrEqual(2);
  }, 20000);

  it('does not open SQLite when asked to persist no rows', async () => {
    const store = createLocalStore();

    await store.putRows([]);

    expect(openCalls).toBe(0);
    expect(database.statements).toEqual([]);
  });
});

describe('at-rest encryption', () => {
  it('stores json as ciphertext, not plaintext', async () => {
    const store = createLocalStore();
    await store.putRows([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1', amount: '100' } },
    ] as never);
    await store.writeQueue([mutation('a')]);
    await store.writeDraft('d1', { secret: 'lunch with Sam' });

    const rowJson = database.mirrorRows.get('expenses:e1')?.json ?? '';
    const queueJson = database.pendingMutations.get('a')?.json ?? '';
    const draftJson = database.drafts.get('d1')?.json ?? '';

    // Sealed (versioned) and free of the underlying plaintext.
    for (const stored of [rowJson, queueJson, draftJson]) {
      expect(stored.startsWith('v1:')).toBe(true);
    }
    expect(rowJson).not.toContain('100');
    expect(draftJson).not.toContain('lunch with Sam');

    // ...and still reads back to the original values.
    expect(await store.readRows()).toEqual([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1', amount: '100' } },
    ]);
    expect(await store.readDraft('d1')).toEqual({ secret: 'lunch with Sam' });
  });

  it('seals pre-encryption plaintext once, on open', async () => {
    // A database written before encryption existed: rows are plain JSON and the
    // schema version is behind.
    database.userVersion = 0;
    database.mirrorRows.set('expenses:e1', {
      table_name: 'expenses',
      id: 'e1',
      group_id: 'g1',
      seq: 1,
      json: JSON.stringify({ id: 'e1', amount: '100' }),
    });
    database.drafts.set('d1', {
      key: 'd1',
      json: JSON.stringify({ note: 'legacy' }),
      saved_at: '2026-01-01T00:00:00.000Z',
    });

    const store = createLocalStore();
    await store.ready();

    // Migrated in place: now sealed, version bumped, WAL flushed.
    expect(database.mirrorRows.get('expenses:e1')?.json.startsWith('v1:')).toBe(true);
    expect(database.drafts.get('d1')?.json.startsWith('v1:')).toBe(true);
    expect(database.userVersion).toBe(1);
    expect(database.statements).toContain('PRAGMA wal_checkpoint(TRUNCATE)');

    // And the seeded plaintext still reads correctly through the decrypt path.
    expect(await store.readRows()).toEqual([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1', amount: '100' } },
    ]);
    expect(await store.readDraft('d1')).toEqual({ note: 'legacy' });
  });

  /**
   * The scenario this whole section exists for.
   *
   * An Android backup/restore carries the app's SQLite file but not its Keystore
   * entry, so the new device mints a fresh DEK and every sealed row fails its
   * AEAD tag. This used to wipe the database — including `pending_mutations`,
   * where an expense entered on a plane is the only copy in the world. Nothing
   * is deleted for a read failure now.
   */
  describe('a key the database no longer has', () => {
    const DEK = 'waves.mirror.dek.v1';

    const seed = async (store: ReturnType<typeof createLocalStore>) => {
      await store.putRows([
        { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1' } },
      ] as never);
      await store.writeCursors({ g1: 1 });
      await store.writeQueue([mutation('a'), mutation('b')]);
      await store.writeDraft('d1', { secret: 'draft' });
    };

    it('reads what it can and destroys nothing', async () => {
      const store = createLocalStore();
      await seed(store);

      // The DB traveled; the device-only DEK did not.
      await destroyKey();
      const deletesBefore = secure.deletes.filter((key) => key === DEK).length;

      // Unreadable, so absent from the read...
      expect(await store.readRows()).toEqual([]);
      expect(await store.readQueue()).toEqual([]);
      expect(await store.readDraft('d1')).toBeNull();
      expect(await store.listDrafts()).toEqual([]);
      // ...but every byte is still on disk, and the key was not thrown away.
      expect(database.mirrorRows.size).toBe(1);
      expect(database.pendingMutations.size).toBe(2);
      expect(database.drafts.size).toBe(1);
      expect(secure.deletes.filter((key) => key === DEK).length).toBe(deletesBefore);
      // Cursors are not encrypted, so they were never at risk either way.
      expect(await store.readCursors()).toEqual({ g1: 1 });

      // Reported once per table, not once per row: a cold start walks the whole
      // mirror and a lost key would otherwise be thousands of identical events.
      // This is the first failing read in the file, so these are all of them.
      expect(reports.map((entry) => entry.where.replace(/\[.*$/, '')).sort()).toEqual([
        'sync.quarantine.drafts',
        'sync.quarantine.mirror_rows',
        'sync.quarantine.pending_mutations',
      ]);
      const seen = reports.length;
      await store.readRows();
      await store.readQueue();
      await store.listDrafts();
      expect(reports).toHaveLength(seen);
    });

    it('keeps the unreadable queue rows through the next queue write', async () => {
      const store = createLocalStore();
      await seed(store);
      await destroyKey();

      // Hydration reads the queue (finding nothing it can open), then the app
      // carries on and queues something new. The rewrite must not finish what
      // the old wipe started.
      expect(await store.readQueue()).toEqual([]);
      await store.writeQueue([mutation('c')]);

      expect([...database.pendingMutations.keys()].sort()).toEqual(['a', 'b', 'c']);
      expect((await store.readQueue()).map((entry) => entry.clientMutationId)).toEqual(['c']);
    });

    it('keeps them through forgetGroup too', async () => {
      const store = createLocalStore();
      await seed(store);
      await destroyKey();
      await store.readQueue();

      await store.forgetGroup('g1', []);

      expect([...database.pendingMutations.keys()].sort()).toEqual(['a', 'b']);
    });

    it('still wipes everything on sign-out', async () => {
      const store = createLocalStore();
      await seed(store);
      await destroyKey();
      await store.readQueue();
      const deletesBefore = secure.deletes.filter((key) => key === DEK).length;

      // Quarantine protects a lost key, not a departing account: an unreadable
      // row is still this person's data on a phone somebody else is about to use.
      await store.reset();

      expect(database.pendingMutations.size).toBe(0);
      expect(database.mirrorRows.size).toBe(0);
      expect(database.drafts.size).toBe(0);
      expect(secure.deletes.filter((key) => key === DEK).length).toBe(deletesBefore + 1);
    });
  });

  it('drops only the row it cannot open, not its neighbours', async () => {
    const store = createLocalStore();
    await store.putRows([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1', amount: '100' } },
      { table: 'expenses', id: 'e2', groupId: 'g1', seq: 2, row: { id: 'e2', amount: '200' } },
    ] as never);
    await store.writeQueue([mutation('a'), mutation('b')]);
    await store.writeDraft('good', { amount: 1 });
    await store.writeDraft('bad', { amount: 2 });

    // Corrupt exactly one row of each encrypted table — a truncated ciphertext
    // fails the AEAD tag the same way a wrong key does.
    const corrupt = (value: string) => `${value.slice(0, value.length - 8)}AAAAAAAA`;
    const row = database.mirrorRows.get('expenses:e2');
    if (row) row.json = corrupt(row.json);
    const queued = database.pendingMutations.get('a');
    if (queued) queued.json = corrupt(queued.json);
    const draft = database.drafts.get('bad');
    if (draft) draft.json = corrupt(draft.json);

    expect((await store.readRows()).map((entry) => entry.id)).toEqual(['e1']);
    expect((await store.readQueue()).map((entry) => entry.clientMutationId)).toEqual(['b']);
    expect((await store.listDrafts()).map((entry) => entry.key)).toEqual(['good']);
    expect(await store.readDraft('good')).toEqual({ amount: 1 });
    expect(await store.readDraft('bad')).toBeNull();
    // And the corrupt queue row is still there, not swept up by the rewrite.
    await store.writeQueue([mutation('b')]);
    expect([...database.pendingMutations.keys()].sort()).toEqual(['a', 'b']);
  });

  it('destroys the key on reset (crypto-erase)', async () => {
    const DEK = 'waves.mirror.dek.v1';
    const store = createLocalStore();
    await store.putRows([
      { table: 'expenses', id: 'e1', groupId: 'g1', seq: 1, row: { id: 'e1' } },
    ] as never);

    const deletesBefore = secure.deletes.filter((key) => key === DEK).length;
    await store.reset();

    // reset() actually removes the encryption key (not just the rows), so a
    // no-op destroyKey would fail this rather than silently pass.
    expect(secure.deletes.filter((key) => key === DEK).length).toBe(deletesBefore + 1);

    // A fresh write after reset still works — the store transparently mints a
    // new key — and the data is gone.
    await store.putRows([
      { table: 'expenses', id: 'e2', groupId: 'g1', seq: 1, row: { id: 'e2' } },
    ] as never);
    expect(await store.readRows()).toEqual([
      { table: 'expenses', id: 'e2', groupId: 'g1', seq: 1, row: { id: 'e2' } },
    ]);
  });
});
