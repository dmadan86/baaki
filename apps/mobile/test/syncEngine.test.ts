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

import { materialiseGroups, type MirrorState, type QueuedMutation } from '@baaki/core';

// Hoisted so the module mocks below can close over the same handles the tests
// poke at: the network verdict, the `sync` invocation, and the one shared
// "disk" every `createLocalStore()` reads and writes.
const h = vi.hoisted(() => ({
  net: vi.fn(),
  invoke: vi.fn(),
  disk: {
    rows: new Map<string, { table: string; id: string; groupId: string; seq: number; row: unknown }>(),
    cursors: {} as Record<string, number>,
    queue: [] as QueuedMutation[],
  },
}));

vi.mock('expo-network', () => ({ getNetworkStateAsync: h.net }));

vi.mock('@/lib/supabase', () => ({
  supabase: { functions: { invoke: h.invoke } },
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
