/**
 * ADR-005 / ADR-014: "sync code is the hardest part of the client — it gets the
 * deepest test suite."
 *
 * The M2 acceptance criterion is stated in TDR §10 as a scenario: *add 10
 * expenses on 2 devices in airplane mode, reconnect, get identical balances
 * with no duplicates.* That scenario is a property, so it is written as one
 * here and run hundreds of times against a model of the server, then again for
 * real against Postgres in `e2e/m2-sync.mjs`.
 *
 * The model server below deliberately mirrors the real one's two guarantees and
 * nothing else: it dedupes by `client_mutation_id`, and it recomputes every
 * share itself rather than believing the client (TDR §4).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  applyOutcomes,
  backoffMs,
  discard,
  emptyMirror,
  enqueue,
  liveExpenses,
  markFailed,
  materialiseExpenses,
  MutationKind,
  nextBatch,
  overlayPending,
  reconcile,
  retryNow,
  SyncRejectionCode,
  SyncTable,
  toExpenseSnapshot,
  type MirrorExpense,
  type MirrorState,
  type QueuedMutation,
} from '../src/sync/index.js';
import type {
  ExpenseCreatePayload,
  MutationEnvelope,
  SyncChange,
  SyncMutationOutcome,
  SyncRequest,
  SyncResponse,
} from '../src/sync/protocol.js';
import { computeShares } from '../src/split/computeShares.js';
import { computeNetBalances, balanceSums } from '../src/balances/balances.js';
import type { ExpenseSnapshot } from '../src/balances/types.js';
import type { MemberId } from '../src/split/types.js';

const GROUP = 'group-1';
const INR = 'INR';

// ───────────────────────────────────────────────── the model server ──

interface StoredExpense {
  [key: string]: unknown;
  id: string;
  group_id: string;
  deleted_at: string | null;
  created_at: string;
  updated_seq: number;
  currentVersion: Record<string, unknown> | null;
}

class ModelServer {
  private seq = 0;
  private readonly expenses = new Map<string, StoredExpense>();
  /** client_mutation_id → the expense it produced. The idempotency key. */
  private readonly applied = new Map<string, string>();
  /** Every version ever written, so we can assert append-only behaviour. */
  readonly versions: { expenseId: string; versionNo: number }[] = [];

  sync(request: SyncRequest): SyncResponse {
    const outcomes: SyncMutationOutcome[] = [];

    for (const mutation of request.mutations) {
      if (this.applied.has(mutation.clientMutationId)) {
        outcomes.push({ clientMutationId: mutation.clientMutationId, status: 'duplicate' });
        continue;
      }
      try {
        this.apply(mutation);
        this.applied.set(mutation.clientMutationId, 'ok');
        outcomes.push({ clientMutationId: mutation.clientMutationId, status: 'applied' });
      } catch (error) {
        outcomes.push({
          clientMutationId: mutation.clientMutationId,
          status: 'rejected',
          code: SyncRejectionCode.ValidationFailed,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const since = request.cursors[GROUP] ?? 0;
    const changes: SyncChange[] = [...this.expenses.values()]
      .filter((row) => row.updated_seq > since)
      .sort((a, b) => a.updated_seq - b.updated_seq)
      .map((row) => ({ table: SyncTable.Expenses, groupId: GROUP, seq: row.updated_seq, row }));

    return {
      outcomes,
      changes,
      cursors: { [GROUP]: this.seq },
      serverTime: new Date(0).toISOString(),
    };
  }

  private apply(mutation: MutationEnvelope): void {
    if (mutation.kind === 'expense.delete') {
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

    const payload = mutation.payload as ExpenseCreatePayload;
    const existing = this.expenses.get(payload.expenseId);
    const versionNo = ((existing?.currentVersion?.version_no as number) ?? 0) + 1;

    // The server never trusts client-computed shares (TDR §4).
    const shares = computeShares({
      amount: BigInt(payload.amount),
      currency: INR,
      params: payload.splitParams,
      participants: payload.participants as readonly MemberId[],
      seed: payload.expenseId,
    });

    this.seq += 1;
    this.versions.push({ expenseId: payload.expenseId, versionNo });
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
}

// ───────────────────────────────────────────────────── the device ──

class Device {
  mirror: MirrorState = emptyMirror();
  queue: QueuedMutation[] = [];

  add(payload: ExpenseCreatePayload, clientMutationId: string, at: string): void {
    this.queue = enqueue(this.queue, {
      clientMutationId,
      kind: MutationKind.ExpenseCreate,
      groupId: GROUP,
      clientCreatedAt: at,
      payload,
    });
  }

  /** One round trip. Returns the batch that was sent, for replay tests. */
  sync(server: ModelServer, now = 0): QueuedMutation[] {
    const batch = nextBatch(this.queue, { now });
    const response = server.sync({
      deviceId: 'device',
      mutations: batch,
      cursors: this.mirror.cursors,
    });
    this.queue = applyOutcomes(this.queue, response.outcomes).queue;
    this.mirror = reconcile(this.mirror, response.changes).state;
    return batch;
  }

  snapshots(): ExpenseSnapshot[] {
    return liveExpenses(materialiseExpenses(this.mirror, this.queue, { groupId: GROUP }))
      .map(toExpenseSnapshot)
      .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);
  }

  balances(): Map<MemberId, bigint> {
    return computeNetBalances(this.snapshots(), []).get(INR) ?? new Map();
  }
}

// ──────────────────────────────────────────────────── generators ──

const members: MemberId[] = ['m1', 'm2', 'm3'];

const expenseDraft = (device: string, index: number): fc.Arbitrary<ExpenseCreatePayload> =>
  fc
    .record({
      amount: fc.bigInt({ min: 1n, max: 500_000n }).map(String),
      payerIndex: fc.integer({ min: 0, max: members.length - 1 }),
    })
    .map(({ amount, payerIndex }) => ({
      expenseId: `${device}-e${index}`,
      description: `Expense ${index}`,
      expenseDate: '2026-03-01',
      currency: INR,
      amount,
      splitParams: { kind: 'equal' as const },
      participants: members,
      payers: { [members[payerIndex] as MemberId]: amount },
    }));

// ──────────────────────────────────────────────────────── tests ──

describe('the M2 acceptance scenario (TDR §10)', () => {
  it('two devices, offline, reconnect: identical balances and no duplicates', () => {
    fc.assert(
      fc.property(
        fc.array(expenseDraft('a', 0), { minLength: 1, maxLength: 10 }),
        fc.array(expenseDraft('b', 0), { minLength: 1, maxLength: 10 }),
        (draftsA, draftsB) => {
          const server = new ModelServer();
          const alpha = new Device();
          const beta = new Device();

          // Airplane mode: both queue everything, neither can reach the server.
          draftsA.forEach((draft, index) => {
            const payload = { ...draft, expenseId: `a-e${index}` };
            alpha.add(payload, `a-m${index}`, `2026-03-01T00:00:0${index % 10}.000Z`);
          });
          draftsB.forEach((draft, index) => {
            const payload = { ...draft, expenseId: `b-e${index}` };
            beta.add(payload, `b-m${index}`, `2026-03-01T00:00:0${index % 10}.000Z`);
          });

          // Everything is visible locally before any network exists (ADR-005).
          expect(alpha.snapshots()).toHaveLength(draftsA.length);
          expect(beta.snapshots()).toHaveLength(draftsB.length);

          // Reconnect. Two rounds each: push mine, then pull yours.
          alpha.sync(server);
          beta.sync(server);
          alpha.sync(server);
          beta.sync(server);

          expect(alpha.queue).toHaveLength(0);
          expect(beta.queue).toHaveLength(0);

          const total = draftsA.length + draftsB.length;
          expect(alpha.snapshots()).toHaveLength(total);
          expect(beta.snapshots()).toHaveLength(total);

          // The headline assertion: the two devices agree, exactly.
          expect([...alpha.balances()].sort()).toEqual([...beta.balances()].sort());
          for (const [, sum] of balanceSums(computeNetBalances(alpha.snapshots(), []))) {
            expect(sum).toBe(0n);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('replaying a queue after a crash does not double-post', () => {
    fc.assert(
      fc.property(fc.array(expenseDraft('a', 0), { minLength: 1, maxLength: 6 }), (drafts) => {
        const server = new ModelServer();
        const device = new Device();
        drafts.forEach((draft, index) => {
          device.add({ ...draft, expenseId: `a-e${index}` }, `a-m${index}`, '2026-03-01T00:00:00Z');
        });

        // The app is killed after the request reaches the server but before the
        // response clears the queue: the mutations are still pending on restart.
        const sent = nextBatch(device.queue, { now: 0 });
        server.sync({ deviceId: 'd', mutations: sent, cursors: {} });

        device.sync(server);
        device.sync(server);

        expect(device.queue).toHaveLength(0);
        expect(device.snapshots()).toHaveLength(drafts.length);
        // Every expense has exactly one version: the replay wrote nothing new.
        expect(server.versions).toHaveLength(drafts.length);
      }),
      { numRuns: 100 },
    );
  });
});

describe('reconciliation', () => {
  it('is idempotent — re-applying a pull changes nothing', () => {
    const changes: SyncChange[] = [
      { table: SyncTable.Expenses, groupId: GROUP, seq: 1, row: { id: 'e1', group_id: GROUP } },
      { table: SyncTable.Expenses, groupId: GROUP, seq: 2, row: { id: 'e2', group_id: GROUP } },
    ];
    const once = reconcile(emptyMirror(), changes);
    const twice = reconcile(once.state, changes);

    expect(once.applied).toEqual(changes);
    expect(twice.state).toEqual(once.state);
    expect(twice.applied).toEqual([]);
    expect(twice.skipped).toBe(2);
    expect(once.state.cursors[GROUP]).toBe(2);
  });

  it('converges regardless of the order changes arrive in', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([1, 2, 3, 4, 5], { minLength: 5 }), (order) => {
        const changes: SyncChange[] = order.map((seq) => ({
          table: SyncTable.Expenses,
          groupId: GROUP,
          seq,
          row: { id: 'e1', group_id: GROUP, version: seq },
        }));
        const state = reconcile(emptyMirror(), changes).state;
        // The highest seq wins whatever order it was delivered in.
        expect(state.tables.expenses.e1).toEqual({ id: 'e1', group_id: GROUP, version: 5 });
        expect(state.cursors[GROUP]).toBe(5);
      }),
    );
  });

  it('never moves a cursor backwards', () => {
    const ahead = reconcile(emptyMirror(), [
      { table: SyncTable.Expenses, groupId: GROUP, seq: 9, row: { id: 'e1', group_id: GROUP } },
    ]).state;
    const stale = reconcile(ahead, [
      { table: SyncTable.Expenses, groupId: GROUP, seq: 3, row: { id: 'e2', group_id: GROUP } },
    ]).state;

    expect(stale.cursors[GROUP]).toBe(9);
    expect(stale.tables.expenses.e2).toBeUndefined();
  });

  it('applies a soft delete and drops the expense from balances', () => {
    const device = new Device();
    const server = new ModelServer();
    device.add(
      {
        expenseId: 'e1',
        description: 'Dinner',
        expenseDate: '2026-03-01',
        currency: INR,
        amount: '900',
        splitParams: { kind: 'equal' },
        participants: members,
        payers: { m1: '900' },
      },
      'm-1',
      '2026-03-01T00:00:00Z',
    );
    device.sync(server);
    expect(device.balances().get('m1')).toBe(600n);

    device.queue = enqueue(device.queue, {
      clientMutationId: 'm-2',
      kind: MutationKind.ExpenseDelete,
      groupId: GROUP,
      clientCreatedAt: '2026-03-02T00:00:00Z',
      payload: { expenseId: 'e1' },
    });
    // Gone from the UI before the server has heard about it.
    expect(device.snapshots()).toHaveLength(0);

    device.sync(server);
    expect(device.snapshots()).toHaveLength(0);
    expect(device.queue).toHaveLength(0);
  });
});

describe('the mutation queue', () => {
  const envelope = (
    id: string,
    groupId: string,
    kind: MutationEnvelope['kind'],
  ): MutationEnvelope => ({
    clientMutationId: id,
    kind,
    groupId,
    clientCreatedAt: '2026-03-01T00:00:00Z',
    payload: { expenseId: `e-${id}` },
  });

  it('sends in the order the user made the changes', () => {
    let queue: QueuedMutation[] = [];
    for (const id of ['a', 'b', 'c'])
      queue = enqueue(queue, envelope(id, GROUP, MutationKind.ExpenseCreate));
    expect(nextBatch(queue, { now: 0 }).map((item) => item.clientMutationId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('holds back a group whose head is in backoff, but not other groups', () => {
    let queue: QueuedMutation[] = [];
    queue = enqueue(queue, envelope('a1', 'g1', MutationKind.ExpenseCreate));
    queue = enqueue(queue, envelope('a2', 'g1', MutationKind.ExpenseCreate));
    queue = enqueue(queue, envelope('b1', 'g2', MutationKind.ExpenseCreate));

    const head = queue.filter((item) => item.clientMutationId === 'a1');
    queue = markFailed(queue, head, 'network down', 1_000);

    const batch = nextBatch(queue, { now: 1_500 }).map((item) => item.clientMutationId);
    // a2 must not overtake a1 — it may be an edit of the same expense.
    expect(batch).toEqual(['b1']);

    // Once the backoff expires the whole group flows again, still in order.
    expect(
      nextBatch(queue, { now: 1_000 + backoffMs(1) + 1 }).map((i) => i.clientMutationId),
    ).toEqual(['a1', 'a2', 'b1']);
  });

  it('treats applied and duplicate identically — both mean the server has it', () => {
    let queue: QueuedMutation[] = [];
    queue = enqueue(queue, envelope('a', GROUP, MutationKind.ExpenseCreate));
    queue = enqueue(queue, envelope('b', GROUP, MutationKind.ExpenseCreate));
    queue = enqueue(queue, envelope('c', GROUP, MutationKind.ExpenseCreate));

    const result = applyOutcomes(queue, [
      { clientMutationId: 'a', status: 'applied' },
      { clientMutationId: 'b', status: 'duplicate' },
      {
        clientMutationId: 'c',
        status: 'rejected',
        code: SyncRejectionCode.ShareMismatch,
        message: 'no',
      },
    ]);

    expect(result.queue).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.code).toBe('SHARE_MISMATCH');
  });

  it('backs off exponentially and gives up rather than retrying forever', () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(99)).toBe(5 * 60_000);

    let queue: QueuedMutation[] = [
      enqueue([], envelope('a', GROUP, MutationKind.ExpenseCreate))[0]!,
    ];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      queue = markFailed(queue, queue, 'offline', 0);
    }
    expect(nextBatch(queue, { now: Number.MAX_SAFE_INTEGER })).toHaveLength(0);
    expect(queue[0]?.lastError).toBe('offline');

    // The user can force it through, or abandon it — nothing is lost silently.
    expect(nextBatch(retryNow(queue, 'a'), { now: 0 })).toHaveLength(1);
    expect(discard(queue, 'a')).toHaveLength(0);
  });

  it('collapses un-sent consecutive edits of the same expense', () => {
    const edit = (id: string, description: string): MutationEnvelope => ({
      clientMutationId: id,
      kind: MutationKind.ExpenseUpdate,
      groupId: GROUP,
      clientCreatedAt: '2026-03-01T00:00:00Z',
      payload: { expenseId: 'e1', description },
    });

    let queue: QueuedMutation[] = [];
    queue = enqueue(queue, edit('m1', 'Dinner'));
    queue = enqueue(queue, edit('m2', 'Dinner at Anjappar'));
    queue = enqueue(queue, edit('m3', 'Dinner at Anjappar with Priya'));

    expect(queue).toHaveLength(1);
    expect((queue[0]?.payload as { description: string }).description).toBe(
      'Dinner at Anjappar with Priya',
    );
  });

  it('never collapses an edit the server has already seen', () => {
    const edit = (id: string): MutationEnvelope => ({
      clientMutationId: id,
      kind: MutationKind.ExpenseUpdate,
      groupId: GROUP,
      clientCreatedAt: '2026-03-01T00:00:00Z',
      payload: { expenseId: 'e1' },
    });

    let queue: QueuedMutation[] = enqueue([], edit('m1'));
    queue = markFailed(queue, queue, 'timeout', 0);
    queue = enqueue(queue, edit('m2'));

    // m1 may have reached the server; dropping it would lose a version that
    // other people can already see.
    expect(queue).toHaveLength(2);
  });

  it('does not collapse edits of different expenses', () => {
    const edit = (id: string, expenseId: string): MutationEnvelope => ({
      clientMutationId: id,
      kind: MutationKind.ExpenseUpdate,
      groupId: GROUP,
      clientCreatedAt: '2026-03-01T00:00:00Z',
      payload: { expenseId },
    });
    let queue: QueuedMutation[] = enqueue([], edit('m1', 'e1'));
    queue = enqueue(queue, edit('m2', 'e2'));
    expect(queue).toHaveLength(2);
  });
});

describe('the pending overlay', () => {
  it('shows offline expenses with the shares they will have once synced', () => {
    const device = new Device();
    device.add(
      {
        expenseId: 'e1',
        description: 'Chai',
        expenseDate: '2026-03-01',
        currency: INR,
        amount: '1000', // ₹10 across three people: 334 / 333 / 333
        splitParams: { kind: 'equal' },
        participants: members,
        payers: { m1: '1000' },
      },
      'm-1',
      '2026-03-01T00:00:00Z',
    );

    const [expense] = materialiseExpenses(device.mirror, device.queue, { groupId: GROUP });
    expect(expense?.pending).toBe(true);

    const shares = expense?.currentVersion?.shares ?? [];
    const total = shares.reduce((sum, share) => sum + BigInt(share.amount), 0n);
    expect(total).toBe(1000n);

    // Identical to what the server will compute — same function, same seed.
    const server = computeShares({
      amount: 1000n,
      currency: INR,
      params: { kind: 'equal' },
      participants: members,
      seed: 'e1',
    });
    expect(Object.fromEntries(shares.map((s) => [s.member_id, s.amount]))).toEqual(
      Object.fromEntries([...server].map(([id, amount]) => [id, amount.toString()])),
    );
  });

  it('overlays a queue onto rows that did not come from the mirror', () => {
    // The group screen renders a cached network response, not the mirror, so
    // the overlay has to work over any list of rows. Without this an expense
    // the user just entered is invisible until it syncs — which on screen is
    // indistinguishable from having lost it.
    const server: MirrorExpense[] = [
      {
        id: 'e-server',
        group_id: GROUP,
        deleted_at: null,
        created_at: '2026-03-01T00:00:00Z',
        currentVersion: null,
      },
    ];
    const queue = enqueue([], {
      clientMutationId: 'm-1',
      kind: MutationKind.ExpenseCreate,
      groupId: GROUP,
      clientCreatedAt: '2026-03-02T00:00:00Z',
      payload: {
        expenseId: 'e-local',
        description: 'Entered just now',
        expenseDate: '2026-03-02',
        currency: INR,
        amount: '900',
        splitParams: { kind: 'equal' },
        participants: members,
        payers: { m1: '900' },
      },
    });

    const rows = overlayPending(server, queue, { groupId: GROUP });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === 'e-local')?.pending).toBe(true);
    expect(rows.find((row) => row.id === 'e-server')?.pending).toBeUndefined();
  });

  it('stops overlaying once the server confirms the mutation', () => {
    const server = new ModelServer();
    const device = new Device();
    device.add(
      {
        expenseId: 'e1',
        description: 'Chai',
        expenseDate: '2026-03-01',
        currency: INR,
        amount: '900',
        splitParams: { kind: 'equal' },
        participants: members,
        payers: { m1: '900' },
      },
      'm-1',
      '2026-03-01T00:00:00Z',
    );
    device.sync(server);

    const [expense] = materialiseExpenses(device.mirror, device.queue, { groupId: GROUP });
    expect(expense?.pending).toBeUndefined();
    expect(device.balances().get('m1')).toBe(600n);
  });
});
