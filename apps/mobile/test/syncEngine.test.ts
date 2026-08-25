/**
 * The flush that has to ask.
 *
 * A signed-in phone showed a full Friends tab and an empty Home at the same
 * moment: Friends reads the server over the wire, Home reads the SQLite mirror,
 * and the mirror was empty because `runFlush` decided a fresh install had
 * "nothing to do". Its guard was `batch.length === 0 && cursors are empty` —
 * true for exactly the case that most needs the network: the first launch, or a
 * sign-in on a new device into groups created elsewhere. The only place those
 * group ids live is the server, which discovers them from the caller's own
 * `group_members`; skipping the call left the mirror empty forever, since the
 * cursors it was waiting for only ever arrive through the call it skipped.
 *
 * The fix (removing that early return) shipped with no test, so this is the
 * guard. It exercises the engine against a fake network, a fake `sync` function
 * and an in-memory stand-in for SQLite that two engines share the way two app
 * launches share a disk — which is what lets the last case prove the pull is
 * durable and not just held in memory until the process dies.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { materialiseGroups, type MirrorState, type QueuedMutation } from '@waves/core';

// Hoisted so the module mocks below can close over the same handles the tests
// poke at: the network verdict, the `sync` invocation, and the one shared
// "disk" every `createLocalStore()` reads and writes.
const h = vi.hoisted(() => ({
  net: vi.fn(),
  syncPreference: vi.fn(),
  invoke: vi.fn(),
  disk: {
    rows: new Map<
      string,
      { table: string; id: string; groupId: string; seq: number; row: unknown }
    >(),
    cursors: {} as Record<string, number>,
    queue: [] as QueuedMutation[],
  },
}));

vi.mock('expo-network', () => ({
  getNetworkStateAsync: h.net,
  NetworkStateType: { WIFI: 'wifi', CELLULAR: 'cellular' },
}));

vi.mock('@/lib/backend', () => ({
  backend: { functions: { invoke: h.invoke } },
  backendConfigured: true,
}));

vi.mock('@/lib/syncNetwork', () => ({
  SyncNetworkPreference: { Wifi: 'wifi', Cellular: 'cellular', Both: 'both' },
  loadSyncNetworkPreference: h.syncPreference,
}));

// Keep Sentry out of a unit test; the engine only ever calls `reportHandled`.
vi.mock('@/lib/observability', () => ({ reportHandled: () => {} }));

// A faithful-enough LocalStore: durable across instances (shared `h.disk`),
// honest about nothing else. Two `new SyncEngine()`s reading it is two launches
// reading the same phone.
vi.mock('../src/sync/store', () => ({
  createLocalStore: () => ({
    ready: async () => {},
    putRows: async (rows: { table: string; id: string }[]) => {
      for (const row of rows) h.disk.rows.set(`${row.table}:${row.id}`, row as never);
    },
    readRows: async () => [...h.disk.rows.values()],
    readCursors: async () => ({ ...h.disk.cursors }),
    writeCursors: async (cursors: Record<string, number>) => {
      h.disk.cursors = { ...cursors };
    },
    readQueue: async () => [...h.disk.queue],
    writeQueue: async (queue: QueuedMutation[]) => {
      h.disk.queue = [...queue];
    },
    readDraft: async () => null,
    writeDraft: async () => {},
    clearDraft: async () => {},
    listDrafts: async () => [],
    forgetGroup: async (groupId: string, queue: QueuedMutation[]) => {
      for (const [key, row] of [...h.disk.rows]) {
        if (row.groupId === groupId) h.disk.rows.delete(key);
      }
      delete h.disk.cursors[groupId];
      h.disk.queue = [...queue];
    },
    reset: async () => {
      h.disk.rows.clear();
      h.disk.cursors = {};
      h.disk.queue = [];
    },
  }),
}));

const { SyncEngine } = await import('../src/sync/engine');

const online = () => h.net.mockResolvedValue({ isInternetReachable: true });
const offline = () => h.net.mockResolvedValue({ isInternetReachable: false });

/** What the `sync` function hands back on that first, group-discovering call. */
function discoveryResponse() {
  return {
    outcomes: [],
    changes: [
      {
        table: 'groups',
        groupId: 'g-goa',
        seq: 1,
        row: {
          id: 'g-goa',
          name: 'Goa Trip',
          default_currency: 'INR',
          created_at: '2026-08-01T00:00:00.000Z',
          archived_at: null,
        },
      },
      {
        table: 'group_members',
        groupId: 'g-goa',
        seq: 2,
        row: { id: 'm-me', group_id: 'g-goa', profile_id: 'p-me' },
      },
    ],
    cursors: { 'g-goa': 2 },
    serverTime: '2026-08-09T09:27:00.000Z',
  };
}

const groupIds = (mirror: MirrorState, queue: QueuedMutation[] = []) =>
  materialiseGroups(mirror, queue).map((group) => group.id);

beforeEach(() => {
  vi.clearAllMocks();
  h.syncPreference.mockResolvedValue('both');
  h.disk.rows.clear();
  h.disk.cursors = {};
  h.disk.queue = [];
});

describe('runFlush on a fresh install', () => {
  it('asks the server even though the mirror is empty and nothing is queued', async () => {
    online();
    h.invoke.mockResolvedValue({ data: discoveryResponse(), error: null });

    await new SyncEngine().flush();

    // The regression: the old guard returned here without a round trip, so the
    // groups the server would have named never arrived.
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const [fn, options] = h.invoke.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(fn).toBe('sync');
    // Empty cursors is precisely the state the old code read as "nothing to do".
    expect(options.body.cursors).toEqual({});
    expect(options.body.mutations).toEqual([]);
  });

  it('lands the discovered group where Home reads it', async () => {
    online();
    h.invoke.mockResolvedValue({ data: discoveryResponse(), error: null });

    const engine = new SyncEngine();
    await engine.flush();
    const state = engine.getState();

    // `useHomeSummary` iterates exactly this — an empty result is the empty Home.
    expect(groupIds(state.mirror)).toEqual(['g-goa']);
    expect(state.mirror.tables.group_members['m-me']).toBeDefined();
    expect(state.status).toBe('idle');
    expect(state.lastSyncedAt).toBe('2026-08-09T09:27:00.000Z');
  });

  it('persists the pull so the next launch shows the group without a network', async () => {
    online();
    h.invoke.mockResolvedValue({ data: discoveryResponse(), error: null });

    await new SyncEngine().flush(); // first launch: pulls and writes to disk

    // Second launch: hydrate from the shared disk, no flush, no network.
    const relaunched = new SyncEngine();
    await relaunched.hydrate();

    expect(h.invoke).toHaveBeenCalledTimes(1); // hydrate must not hit the wire
    expect(groupIds(relaunched.getState().mirror)).toEqual(['g-goa']);
    expect(relaunched.getState().mirror.cursors['g-goa']).toBe(2);
  });

  it('does not call out while offline, and says it is offline', async () => {
    offline();

    const engine = new SyncEngine();
    await engine.flush();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(engine.getState().status).toBe('offline');
    expect(groupIds(engine.getState().mirror)).toEqual([]);
  });
});

describe('runFlush once groups are already known', () => {
  it('still pulls, carrying the cursors it has, so it is not a first-run special case', async () => {
    online();
    // A phone that already synced Goa once: the group and its cursor are on disk.
    h.disk.rows.set('groups:g-goa', {
      table: 'groups',
      id: 'g-goa',
      groupId: 'g-goa',
      seq: 1,
      row: {
        id: 'g-goa',
        name: 'Goa Trip',
        default_currency: 'INR',
        created_at: '2026-08-01T00:00:00.000Z',
        archived_at: null,
      },
    });
    h.disk.cursors = { 'g-goa': 2 };
    h.invoke.mockResolvedValue({
      data: { outcomes: [], changes: [], cursors: { 'g-goa': 2 }, serverTime: 't' },
      error: null,
    });

    const engine = new SyncEngine();
    await engine.flush();

    expect(h.invoke).toHaveBeenCalledTimes(1);
    const [, options] = h.invoke.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(options.body.cursors).toEqual({ 'g-goa': 2 });
  });
});

describe('leaving a group forgets it locally', () => {
  it('drops the group from the mirror and disk so it never comes back', async () => {
    online();
    h.invoke.mockResolvedValue({ data: discoveryResponse(), error: null });

    const engine = new SyncEngine();
    await engine.flush();
    expect(groupIds(engine.getState().mirror)).toEqual(['g-goa']);

    await engine.forgetGroup('g-goa');

    // Gone from memory: the group row, its members, and its cursor.
    expect(groupIds(engine.getState().mirror)).toEqual([]);
    expect(engine.getState().mirror.tables.group_members['m-me']).toBeUndefined();
    expect(engine.getState().mirror.cursors['g-goa']).toBeUndefined();

    // And gone from disk, which is the whole point: leaving hides the group
    // server-side (RLS), so a pull can never again report it — only forgetting
    // it locally stops a relaunch from hydrating the stale group back onto Home.
    const relaunched = new SyncEngine();
    await relaunched.hydrate();
    expect(groupIds(relaunched.getState().mirror)).toEqual([]);
  });

  it('discards that group’s still-unsent edits but keeps other groups', async () => {
    online();
    h.invoke.mockResolvedValue({ data: discoveryResponse(), error: null });
    const engine = new SyncEngine();
    await engine.flush();

    // A second group on disk, and a queued edit for each — leaving g-goa must
    // take only its own unsent work with it.
    h.disk.rows.set('groups:g-two', {
      table: 'groups',
      id: 'g-two',
      groupId: 'g-two',
      seq: 1,
      row: {
        id: 'g-two',
        name: 'Flat',
        default_currency: 'INR',
        created_at: '2026-08-02T00:00:00.000Z',
        archived_at: null,
      },
    });
    h.disk.cursors['g-two'] = 1;
    const relaunched = new SyncEngine();
    await relaunched.hydrate();
    await relaunched.enqueue({
      clientMutationId: 'x-goa',
      kind: 'group.update' as never,
      groupId: 'g-goa',
      clientCreatedAt: '2026-08-09T00:00:00.000Z',
      payload: { name: 'renamed' },
    });
    await relaunched.enqueue({
      clientMutationId: 'x-two',
      kind: 'group.update' as never,
      groupId: 'g-two',
      clientCreatedAt: '2026-08-09T00:00:00.000Z',
      payload: { name: 'renamed too' },
    });

    await relaunched.forgetGroup('g-goa');

    expect(groupIds(relaunched.getState().mirror)).toEqual(['g-two']);
    expect(relaunched.getState().queue.map((m) => m.clientMutationId)).toEqual(['x-two']);

    // Persisted, not just in memory: a third launch hydrates only x-two, so the
    // departed group's unsent edit is gone from disk and never replays.
    const thirdLaunch = new SyncEngine();
    await thirdLaunch.hydrate();
    expect(thirdLaunch.getState().queue.map((m) => m.clientMutationId)).toEqual(['x-two']);
  });

  it('is not undone by a flush that was already in flight when it ran', async () => {
    online();
    // The group is on disk and known before the leave.
    h.disk.rows.set('groups:g-goa', {
      table: 'groups',
      id: 'g-goa',
      groupId: 'g-goa',
      seq: 1,
      row: {
        id: 'g-goa',
        name: 'Goa Trip',
        default_currency: 'INR',
        created_at: '2026-08-01T00:00:00.000Z',
        archived_at: null,
      },
    });
    h.disk.cursors = { 'g-goa': 2 };
    const engine = new SyncEngine();
    await engine.hydrate();
    expect(groupIds(engine.getState().mirror)).toEqual(['g-goa']);

    // A flush is in flight, its response held open — it still carries the
    // group's rows, the way a pull that raced the leave would.
    let land: (value: unknown) => void = () => {};
    h.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    const flushing = engine.flush();

    // Leaving now: forgetGroup must wait for that flush rather than purge into
    // its teeth. Kick it off, then let the flush land carrying g-goa.
    const forgetting = engine.forgetGroup('g-goa');
    land({ data: discoveryResponse(), error: null });
    await Promise.all([flushing, forgetting]);

    // The late response did not resurrect it — in memory or on disk.
    expect(groupIds(engine.getState().mirror)).toEqual([]);
    const relaunched = new SyncEngine();
    await relaunched.hydrate();
    expect(groupIds(relaunched.getState().mirror)).toEqual([]);
  });
});

describe('network gates and failure handling', () => {
  it('holds the queue on a metered connection the user has not allowed', async () => {
    h.syncPreference.mockResolvedValue('wifi');
    h.net.mockResolvedValue({ isInternetReachable: true, type: 'cellular' });
    const engine = new SyncEngine();

    await engine.enqueue({
      clientMutationId: 'metered-edit',
      kind: 'group.update' as never,
      groupId: 'g-goa',
      clientCreatedAt: '2026-08-09T00:00:00.000Z',
      payload: { name: 'No mobile data' },
    });
    await engine.flush();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(engine.getState().status).toBe('metered');
    expect(engine.getState().queue.map((m) => m.clientMutationId)).toEqual(['metered-edit']);
    expect(h.disk.queue.map((m) => m.clientMutationId)).toEqual(['metered-edit']);
  });

  it('marks the queued batch failed and keeps that reason durable when sync errors', async () => {
    online();
    h.invoke.mockResolvedValue({
      data: null,
      error: { context: { json: async () => ({ code: 'BAD_GATEWAY', message: 'Try later' }) } },
    });
    const engine = new SyncEngine();

    await engine.enqueue({
      clientMutationId: 'will-fail',
      kind: 'group.update' as never,
      groupId: 'g-goa',
      clientCreatedAt: '2026-08-09T00:00:00.000Z',
      payload: { name: 'fail' },
    });
    await engine.flush();

    expect(engine.getState().status).toBe('error');
    expect(engine.getState().lastError).toBe('BAD_GATEWAY: Try later');
    expect(engine.getState().queue[0]?.attempts).toBeGreaterThan(0);
    expect(engine.getState().queue[0]?.lastError).toBe('BAD_GATEWAY: Try later');
    expect(h.disk.queue[0]?.lastError).toBe('BAD_GATEWAY: Try later');
  });
});

describe('background poll performance', () => {
  it('keeps mirror and queue references stable when a poll applies no changes', async () => {
    online();
    h.disk.rows.set('groups:g-goa', {
      table: 'groups',
      id: 'g-goa',
      groupId: 'g-goa',
      seq: 1,
      row: {
        id: 'g-goa',
        name: 'Goa Trip',
        default_currency: 'INR',
        created_at: '2026-08-01T00:00:00.000Z',
        archived_at: null,
      },
    });
    h.disk.cursors = { 'g-goa': 2 };
    h.invoke.mockResolvedValue({
      data: { outcomes: [], changes: [], cursors: { 'g-goa': 2 }, serverTime: 'poll' },
      error: null,
    });
    const engine = new SyncEngine();
    await engine.hydrate();
    const before = engine.getState();

    await engine.flush();

    expect(engine.getState().mirror).toBe(before.mirror);
    expect(engine.getState().queue).toBe(before.queue);
    expect(engine.getState().lastSyncedAt).toBe('poll');
  });

  it('schedules an immediate follow-up pull when the server says more rows are waiting', async () => {
    vi.useFakeTimers();
    try {
      online();
      h.invoke
        .mockResolvedValueOnce({ data: { ...discoveryResponse(), hasMore: true }, error: null })
        .mockResolvedValue({
          data: { outcomes: [], changes: [], cursors: { 'g-goa': 2 }, serverTime: 'drained' },
          error: null,
        });
      const engine = new SyncEngine();

      await engine.flush();
      expect(h.invoke).toHaveBeenCalledTimes(1);

      await vi.runOnlyPendingTimersAsync();
      expect(h.invoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spin forever when hasMore arrives without cursor or row progress', async () => {
    vi.useFakeTimers();
    try {
      online();
      h.disk.cursors = { 'g-goa': 2 };
      h.invoke.mockResolvedValue({
        data: {
          outcomes: [],
          changes: [],
          cursors: { 'g-goa': 2 },
          serverTime: 'stalled-page',
          hasMore: true,
        },
        error: null,
      });
      const engine = new SyncEngine();
      await engine.hydrate();

      await engine.flush();
      await vi.runOnlyPendingTimersAsync();

      expect(h.invoke).toHaveBeenCalledTimes(1);
      expect(engine.getState().lastSyncedAt).toBe('stalled-page');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('queue and draft controls', () => {
  it('retry clears a rejected banner after the server removed that mutation from the queue', async () => {
    online();
    h.invoke.mockResolvedValue({
      data: {
        outcomes: [
          {
            clientMutationId: 'bad-edit',
            status: 'rejected',
            code: 'VALIDATION_FAILED',
            message: 'Nope',
          },
        ],
        changes: [],
        cursors: {},
        serverTime: 'reject',
      },
      error: null,
    });
    const engine = new SyncEngine();
    await engine.enqueue({
      clientMutationId: 'bad-edit',
      kind: 'group.update' as never,
      groupId: 'g-goa',
      clientCreatedAt: '2026-08-09T00:00:00.000Z',
      payload: { name: '' },
    });
    await engine.flush();
    expect(engine.getState().queue).toEqual([]);
    expect(engine.getState().rejected.map((item) => item.clientMutationId)).toEqual(['bad-edit']);

    await engine.retry('bad-edit');
    expect(engine.getState().rejected).toEqual([]);
    expect(h.disk.queue).toEqual([]);
  });

  it('discard removes a still-queued failed mutation from memory and disk', async () => {
    online();
    h.invoke.mockResolvedValue({ data: null, error: new Error('network down') });
    const engine = new SyncEngine();
    await engine.enqueue({
      clientMutationId: 'queued-edit',
      kind: 'group.update' as never,
      groupId: 'g-goa',
      clientCreatedAt: '2026-08-09T00:00:00.000Z',
      payload: { name: 'retry later' },
    });
    await engine.flush();
    expect(engine.getState().queue.map((item) => item.clientMutationId)).toEqual(['queued-edit']);

    await engine.discard('queued-edit');
    expect(engine.getState().queue).toEqual([]);
    expect(h.disk.queue).toEqual([]);
  });

  it('replaces repeated rejection banners for the same mutation id', async () => {
    online();
    h.invoke.mockResolvedValueOnce({
      data: {
        outcomes: [
          {
            clientMutationId: 'bad-edit',
            status: 'rejected',
            code: 'VALIDATION_FAILED',
            message: 'First reason',
          },
        ],
        changes: [],
        cursors: {},
        serverTime: 'first',
      },
      error: null,
    });
    const engine = new SyncEngine();
    await engine.enqueue({
      clientMutationId: 'bad-edit',
      kind: 'group.update' as never,
      groupId: 'g-goa',
      clientCreatedAt: '2026-08-09T00:00:00.000Z',
      payload: { name: '' },
    });
    await engine.flush();
    expect(engine.getState().rejected.map((item) => item.message)).toEqual(['First reason']);

    h.invoke.mockResolvedValueOnce({
      data: {
        outcomes: [
          {
            clientMutationId: 'bad-edit',
            status: 'rejected',
            code: 'VALIDATION_FAILED',
            message: 'Second reason',
          },
        ],
        changes: [],
        cursors: {},
        serverTime: 'second',
      },
      error: null,
    });
    await engine.enqueue({
      clientMutationId: 'bad-edit',
      kind: 'group.update' as never,
      groupId: 'g-goa',
      clientCreatedAt: '2026-08-09T00:00:01.000Z',
      payload: { name: '' },
    });
    await engine.flush();

    expect(engine.getState().rejected.map((item) => item.message)).toEqual(['Second reason']);
  });

  it('delegates draft saves, reads, listing and clearing to the local store', async () => {
    const engine = new SyncEngine();

    await engine.saveDraft('expense:new', { amount: 123 });
    await expect(engine.readDraft('expense:new')).resolves.toBeNull();
    await expect(engine.listDrafts()).resolves.toEqual([]);
    await expect(engine.clearDraft('expense:new')).resolves.toBeUndefined();
  });
});
