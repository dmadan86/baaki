/**
 * ADR-005 / TDR §10: two devices, converged — driven through the *real*
 * `SyncEngine`, not a hand-rolled stand-in.
 *
 * `packages/core/test/sync.property.test.ts` already proves the sync *algebra*
 * converges (a `Device` built straight from `nextBatch`/`applyOutcomes`/
 * `reconcile`), and `e2e/m2-sync.mjs` proves the deployed `/sync` function does.
 * Neither exercises the production client: `apps/mobile/src/sync/engine.ts` —
 * the thing that owns the flush loop, the online/offline gate, the single-flight
 * lock, the persist-then-reconcile order, and the queue on disk. `syncEngine`'s
 * own suite covers that engine, but only ever one device (a relaunch reads the
 * same disk). This is the missing case: two engines, two separate disks, one
 * shared server, interleaved — the scenario two emulators would show, made
 * deterministic and runnable without a device.
 *
 * The fake `sync` server below keeps exactly the two guarantees the real one is
 * defined by (TDR §4): it dedupes by `client_mutation_id`, and it recomputes
 * every share itself rather than trusting the client. Everything two devices
 * must agree on falls out of those two.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeNetBalances,
  computeShares,
  liveExpenses,
  materialiseExpenses,
  toExpenseSnapshot,
  MutationKind,
  type MemberId,
  type MirrorState,
  type MutationEnvelope,
  type QueuedMutation,
  type SyncChange,
} from '@waves/core';

// ── shared handles the module mocks below close over ────────────────────────
// `h.invoke` is every engine's `supabase.functions.invoke`; both devices' calls
// land on the one `server`. `h.disks` is the pool of independent "phones" — the
// store factory hands out the next one per `new SyncEngine()`, so device A and
// device B read and write genuinely separate storage.
type StoredRow = { table: string; id: string; groupId: string; seq: number; row: unknown };
type Disk = {
  rows: Map<string, StoredRow>;
  cursors: Record<string, number>;
  queue: QueuedMutation[];
};

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  net: vi.fn(),
  disks: [] as {
    rows: Map<string, { table: string; id: string; groupId: string; seq: number; row: unknown }>;
    cursors: Record<string, number>;
    queue: QueuedMutation[];
  }[],
}));

const freshDisk = (): Disk => ({ rows: new Map(), cursors: {}, queue: [] });

vi.mock('expo-network', () => ({ getNetworkStateAsync: h.net }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: h.invoke } } }));
vi.mock('@/lib/observability', () => ({ reportHandled: () => {} }));

// The store factory pops the next disk off the pool. `new SyncEngine()` calls
// `createLocalStore()` once, synchronously, in its field initialiser — so
// constructing A then B binds A to disk 0 and B to disk 1, deterministically.
vi.mock('../src/sync/store', () => ({
  createLocalStore: () => {
    // The module exports a `syncEngine` singleton constructed at import time,
    // before any test provisions the pool — hand that one a throwaway disk it
    // never uses. Every engine a test constructs gets a provisioned disk.
    const disk: Disk = h.disks.shift() ?? { rows: new Map(), cursors: {}, queue: [] };
    return {
      ready: async () => {},
      putRows: async (rows: StoredRow[]) => {
        for (const row of rows) disk.rows.set(`${row.table}:${row.id}`, row);
      },
      readRows: async () =>
        [...disk.rows.values()].map((r) => ({
          table: r.table,
          id: r.id,
          groupId: r.groupId,
          seq: r.seq,
          row: r.row,
        })),
      readCursors: async () => ({ ...disk.cursors }),
      writeCursors: async (cursors: Record<string, number>) => {
        disk.cursors = { ...cursors };
      },
      readQueue: async () => [...disk.queue],
      writeQueue: async (queue: QueuedMutation[]) => {
        disk.queue = [...queue];
      },
      readDraft: async () => null,
      writeDraft: async () => {},
      clearDraft: async () => {},
      listDrafts: async () => [],
      forgetGroup: async (groupId: string, queue: QueuedMutation[]) => {
        for (const [key, row] of [...disk.rows]) if (row.groupId === groupId) disk.rows.delete(key);
        delete disk.cursors[groupId];
        disk.queue = [...queue];
      },
      reset: async () => {
        disk.rows.clear();
        disk.cursors = {};
        disk.queue = [];
      },
    };
  },
}));

const { SyncEngine } = await import('../src/sync/engine');

// ── the shared model server ─────────────────────────────────────────────────

const GROUP = 'g-trip';
const INR = 'INR';
const MA = 'm-asha' as MemberId;
const MB = 'm-bharath' as MemberId;
const MEMBERS: MemberId[] = [MA, MB];

type StoredExpense = {
  id: string;
  group_id: string;
  deleted_at: string | null;
  created_at: string;
  updated_seq: number;
  currentVersion: Record<string, unknown> | null;
};

/**
 * Keeps only what the real `/sync` is contractually required to keep: an
 * idempotency ledger and its own recomputation of shares. Seeds the group and
 * both memberships so an empty device discovers them on its first pull, exactly
 * as the deployed function hands back the caller's memberships.
 */
class ModelServer {
  private seq = 3; // 1: group, 2: member A, 3: member B — the base rows below
  private readonly expenses = new Map<string, StoredExpense>();
  private readonly applied = new Map<string, 'ok'>();
  private readonly base: SyncChange[];

  constructor() {
    this.base = [
      {
        table: 'groups' as SyncChange['table'],
        groupId: GROUP,
        seq: 1,
        row: {
          id: GROUP,
          name: 'Goa trip',
          default_currency: INR,
          created_at: '2026-03-01T00:00:00.000Z',
          archived_at: null,
        },
      },
      {
        table: 'group_members' as SyncChange['table'],
        groupId: GROUP,
        seq: 2,
        row: { id: MA, group_id: GROUP, profile_id: 'p-asha' },
      },
      {
        table: 'group_members' as SyncChange['table'],
        groupId: GROUP,
        seq: 3,
        row: { id: MB, group_id: GROUP, profile_id: 'p-bharath' },
      },
    ];
  }

  sync(body: { mutations: MutationEnvelope[]; cursors: Record<string, number> }) {
    const outcomes = body.mutations.map((mutation) => {
      if (this.applied.has(mutation.clientMutationId)) {
        return { clientMutationId: mutation.clientMutationId, status: 'duplicate' as const };
      }
      this.apply(mutation);
      this.applied.set(mutation.clientMutationId, 'ok');
      return { clientMutationId: mutation.clientMutationId, status: 'applied' as const };
    });

    const since = body.cursors[GROUP] ?? 0;
    const expenseChanges: SyncChange[] = [...this.expenses.values()]
      .filter((row) => row.updated_seq > since)
      .sort((a, b) => a.updated_seq - b.updated_seq)
      .map((row) => ({
        table: 'expenses' as SyncChange['table'],
        groupId: GROUP,
        seq: row.updated_seq,
        row,
      }));

    // Below the cursor the base rows (group + members) have already landed; a
    // fresh device (cursor 0) still needs them.
    const changes = since === 0 ? [...this.base, ...expenseChanges] : expenseChanges;

    return {
      data: {
        outcomes,
        changes,
        cursors: { [GROUP]: this.seq },
        serverTime: new Date(0).toISOString(),
      },
      error: null,
    };
  }

  private apply(mutation: MutationEnvelope): void {
    if (mutation.kind === MutationKind.ExpenseDelete) {
      const payload = mutation.payload as { expenseId: string };
      const existing = this.expenses.get(payload.expenseId);
      if (!existing) throw new Error('NOT_FOUND');
      this.seq += 1;
      this.expenses.set(payload.expenseId, {
        ...existing,
        deleted_at: mutation.clientCreatedAt,
        updated_seq: this.seq,
      });
      return;
    }

    const payload = mutation.payload as {
      expenseId: string;
      description: string;
      expenseDate: string;
      currency: string;
      amount: string;
      splitParams: { kind: 'equal' };
      participants: MemberId[];
      payers: Record<string, string>;
    };
    const existing = this.expenses.get(payload.expenseId);
    const versionNo = ((existing?.currentVersion?.version_no as number) ?? 0) + 1;

    // The server never trusts client-computed shares (TDR §4).
    const shares = computeShares({
      amount: BigInt(payload.amount),
      currency: INR,
      params: payload.splitParams,
      participants: payload.participants,
      seed: payload.expenseId,
    });

    this.seq += 1;
    this.expenses.set(payload.expenseId, {
      id: payload.expenseId,
      group_id: GROUP,
      deleted_at: existing?.deleted_at ?? null,
      created_at: existing?.created_at ?? mutation.clientCreatedAt,
      updated_seq: this.seq,
      currentVersion: {
        id: `v:${mutation.clientMutationId}`,
        version_no: versionNo,
        description: payload.description,
        category: null,
        expense_date: payload.expenseDate,
        currency: INR,
        amount: payload.amount,
        split_type: payload.splitParams.kind,
        split_params: payload.splitParams,
        author_member_id: null,
        notes: null,
        created_at: mutation.clientCreatedAt,
        payers: Object.entries(payload.payers).map(([member_id, amount]) => ({
          member_id,
          amount,
        })),
        shares: [...shares].map(([member_id, amount]) => ({
          member_id,
          amount: amount.toString(),
        })),
      },
    });
  }

  count(): number {
    return this.expenses.size;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const online = () => h.net.mockResolvedValue({ isInternetReachable: true });
const offline = () => h.net.mockResolvedValue({ isInternetReachable: false });

let clock = 0;
const at = () => new Date((clock += 1000)).toISOString();

const createExpense = (expenseId: string, payer: MemberId, amount: bigint): MutationEnvelope => ({
  clientMutationId: `cmid-${expenseId}-v1`,
  kind: MutationKind.ExpenseCreate,
  groupId: GROUP,
  clientCreatedAt: at(),
  payload: {
    expenseId,
    description: expenseId,
    expenseDate: '2026-03-01',
    currency: INR,
    amount: amount.toString(),
    splitParams: { kind: 'equal' },
    participants: MEMBERS,
    payers: { [payer]: amount.toString() },
  },
});

const balancesOf = (state: {
  mirror: MirrorState;
  queue: QueuedMutation[];
}): Map<MemberId, bigint> => {
  const snapshots = liveExpenses(materialiseExpenses(state.mirror, state.queue, { groupId: GROUP }))
    .map(toExpenseSnapshot)
    .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
  return computeNetBalances(snapshots, []).get(INR) ?? new Map();
};

const sameBalances = (a: Map<MemberId, bigint>, b: Map<MemberId, bigint>): boolean =>
  a.size === b.size && [...a].every(([member, value]) => b.get(member) === value);

let server: ModelServer;

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  h.disks = [freshDisk(), freshDisk(), freshDisk()];
  server = new ModelServer();
  h.invoke.mockImplementation(
    async (
      _fn: string,
      options: { body: { mutations: MutationEnvelope[]; cursors: Record<string, number> } },
    ) => server.sync(options.body),
  );
  online();
});

// ── tests ───────────────────────────────────────────────────────────────────

describe('two engines, one group', () => {
  it('converge on identical balances after offline entry on both sides', async () => {
    const asha = new SyncEngine();
    const bharath = new SyncEngine();

    // Discover the group on both, so each has the members to split against.
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });

    // Airplane mode: five expenses each, queued, nothing sent.
    offline();
    for (let index = 0; index < 5; index += 1) {
      await asha.enqueue(createExpense(`a-${index}`, MA, BigInt(333 + index)));
      await bharath.enqueue(createExpense(`b-${index}`, MB, BigInt(777 + index)));
    }
    expect(asha.getState().queue).toHaveLength(5);
    expect(bharath.getState().queue).toHaveLength(5);

    // Reconnect. Two rounds each so both push their own and pull the other's.
    online();
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });

    // Both queues drained; exactly ten expenses server-side, no dupes.
    expect(asha.getState().queue).toHaveLength(0);
    expect(bharath.getState().queue).toHaveLength(0);
    expect(server.count()).toBe(10);

    const ashaBalances = balancesOf(asha.getState());
    const bharathBalances = balancesOf(bharath.getState());
    expect(sameBalances(ashaBalances, bharathBalances)).toBe(true);
    expect([...ashaBalances.values()].reduce((sum, value) => sum + value, 0n)).toBe(0n);
  });

  it('one device edits, the other sees the latest amount', async () => {
    const asha = new SyncEngine();
    const bharath = new SyncEngine();
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });

    // Asha creates, both converge on 1000 (Bharath owes his 500 half).
    await asha.enqueue(createExpense('dinner', MA, 1000n));
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });
    expect(balancesOf(bharath.getState()).get(MB)).toBe(-500n);

    // Asha edits the same expense up to 3000 (a new version of the same id).
    await asha.enqueue({
      clientMutationId: 'cmid-dinner-v2',
      kind: MutationKind.ExpenseUpdate,
      groupId: GROUP,
      clientCreatedAt: at(),
      payload: {
        expenseId: 'dinner',
        description: 'dinner (more)',
        expenseDate: '2026-03-01',
        currency: INR,
        amount: '3000',
        splitParams: { kind: 'equal' },
        participants: MEMBERS,
        payers: { [MA]: '3000' },
      },
    });
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });

    // Bharath's owed share follows the edit, and the two still agree.
    expect(balancesOf(bharath.getState()).get(MB)).toBe(-1500n);
    expect(sameBalances(balancesOf(asha.getState()), balancesOf(bharath.getState()))).toBe(true);
  });

  it('a soft delete on one device drops the expense on the other', async () => {
    const asha = new SyncEngine();
    const bharath = new SyncEngine();
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });

    await asha.enqueue(createExpense('taxi', MA, 600n));
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });
    expect(balancesOf(bharath.getState()).get(MB)).toBe(-300n);

    await asha.enqueue({
      clientMutationId: 'cmid-taxi-del',
      kind: MutationKind.ExpenseDelete,
      groupId: GROUP,
      clientCreatedAt: at(),
      payload: { expenseId: 'taxi' },
    });
    await asha.flush({ groupIds: [GROUP] });
    await bharath.flush({ groupIds: [GROUP] });

    // Gone on both — a zeroed ledger, still in agreement.
    expect([...balancesOf(bharath.getState()).values()].every((value) => value === 0n)).toBe(true);
    expect(sameBalances(balancesOf(asha.getState()), balancesOf(bharath.getState()))).toBe(true);
  });

  it('replaying a device queue after a crash never double-posts', async () => {
    const asha = new SyncEngine();
    await asha.flush({ groupIds: [GROUP] });

    const mutation = createExpense('lunch', MA, 900n);
    await asha.enqueue(mutation);
    await asha.flush({ groupIds: [GROUP] }); // applies, clears the queue

    // Simulate the crash: the same envelope is still on a second "device" whose
    // queue never got cleared. It replays the identical client_mutation_id.
    const zombie = new SyncEngine();
    await zombie.flush({ groupIds: [GROUP] });
    await zombie.enqueue(mutation);
    await zombie.flush({ groupIds: [GROUP] });

    // The server saw the id already: still one expense, and its balances hold.
    expect(server.count()).toBe(1);
    expect(balancesOf(zombie.getState()).get(MB)).toBe(-450n);
  });
});
