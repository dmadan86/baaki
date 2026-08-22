/**
 * Monkey + stress tests: hammer the money core and the sync overlay with long
 * random sessions and large loads, asserting the invariants that must hold no
 * matter what a user (or a flaky network replaying a queue) throws at them.
 *
 * "Monkey" here is model-based: a random sequence of mutations is applied and
 * an independent model predicts what the screen must show, so a divergence is a
 * real bug rather than a restatement of the code. "Stress" scales the same
 * checks up — big groups, hundreds of expenses, thousands of runs.
 *
 * Volume is env-tunable so CI stays quick but a local run can go deep:
 *   MONKEY_RUNS=3000 pnpm -C packages/core test monkey
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  emptyMirror,
  materialiseMemberBudgets,
  materialisePlanItems,
  openPlanItems,
  reconcile,
} from '../src/sync/mirror.js';
import { enqueue, type QueuedMutation } from '../src/sync/queue.js';
import {
  MutationKind,
  SyncTable,
  type MutationEnvelope,
  type SyncChange,
} from '../src/sync/protocol.js';
import {
  balanceSums,
  computeNetBalances,
  computePairwiseBalances,
  netFromPairwise,
} from '../src/balances/balances.js';
import { SettlementStatus } from '../src/balances/types.js';
import type { ExpenseSnapshot, SettlementSnapshot } from '../src/balances/types.js';
import { computeShares } from '../src/split/computeShares.js';
import type { MemberId } from '../src/split/types.js';
import { memberIds, positiveAmounts } from './arbitraries.js';

// `process` is not in core's tsconfig types; reach it through globalThis so the
// run count stays env-tunable without pulling @types/node into the package.
const envRuns = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env?.MONKEY_RUNS;
const parsedRuns = Number(envRuns);
const RUNS = Number.isFinite(parsedRuns) && parsedRuns > 0 ? Math.floor(parsedRuns) : 200;
const SCALE_RUNS = Math.max(20, Math.round(RUNS / 5));
const GROUP = 'g-monkey';
const OTHER = 'g-other';
const INR = 'INR';

const BASE_MS = Date.parse('2026-05-01T00:00:00.000Z');
// Time and identity are separate counters: `instant` only ever moves forward (a
// fixed epoch plus a strictly increasing millisecond, no 60s wrap), so
// clientCreatedAt is genuinely monotonic; `idSeq` keeps mutation ids unique
// without perturbing the clock.
let instant = 0;
let idSeq = 0;
const tick = (): string => new Date(BASE_MS + instant++).toISOString();

function env(
  kind: MutationKind,
  payload: Record<string, unknown>,
  groupId = GROUP,
): MutationEnvelope {
  return { clientMutationId: `mut-${idSeq++}`, kind, groupId, clientCreatedAt: tick(), payload };
}

function build(envelopes: readonly MutationEnvelope[]): QueuedMutation[] {
  let queue: QueuedMutation[] = [];
  for (const e of envelopes) queue = enqueue(queue, e);
  return queue;
}

// ─────────────────────────────────────────────── plan-item overlay monkey ──

type PlanOp =
  | { t: 'create'; id: string; day: string }
  | { t: 'update'; id: string; title: string }
  | { t: 'done'; id: string; done: boolean }
  | { t: 'delete'; id: string }
  | { t: 'ghost-delete'; id: string } // delete an id that was never created
  | { t: 'other-group'; id: string }; // a create in a different group

const planOps = (): fc.Arbitrary<PlanOp[]> =>
  fc.array(
    fc.oneof(
      fc.record({
        t: fc.constant('create' as const),
        id: fc.integer({ min: 0, max: 40 }).map((n) => `it-${n}`),
        day: fc.integer({ min: 1, max: 5 }).map((d) => `2026-05-0${d}`),
      }),
      fc.record({
        t: fc.constant('update' as const),
        id: fc.integer({ min: 0, max: 40 }).map((n) => `it-${n}`),
        title: fc.constantFrom('A', 'B', 'C', 'D'),
      }),
      fc.record({
        t: fc.constant('done' as const),
        id: fc.integer({ min: 0, max: 40 }).map((n) => `it-${n}`),
        done: fc.boolean(),
      }),
      fc.record({
        t: fc.constant('delete' as const),
        id: fc.integer({ min: 0, max: 40 }).map((n) => `it-${n}`),
      }),
      fc.record({
        t: fc.constant('ghost-delete' as const),
        id: fc.integer({ min: 100, max: 140 }).map((n) => `it-${n}`),
      }),
      fc.record({
        t: fc.constant('other-group' as const),
        id: fc.integer({ min: 0, max: 40 }).map((n) => `it-${n}`),
      }),
    ),
    { minLength: 0, maxLength: 60 },
  );

describe('monkey: the trip-plan overlay never lies about what is on screen', () => {
  it('shows exactly the items created-and-not-removed, in a stable order', () => {
    fc.assert(
      fc.property(planOps(), (ops) => {
        // The model of what THIS group's screen must show: for each live id, the
        // title and done-state it should carry; plus the set that was removed.
        const model = new Map<string, { title: string; done: boolean }>();
        const removed = new Set<string>();
        const envs: MutationEnvelope[] = [];

        for (const op of ops) {
          switch (op.t) {
            case 'create':
              // Always enqueue — even a create for a live or already-removed id,
              // so the overlay's idempotency key (first create wins, a create
              // after delete stays gone) is genuinely exercised. The model only
              // adopts the first create of a still-unseen id.
              envs.push(
                env(MutationKind.PlanItemCreate, {
                  itemId: op.id,
                  day: op.day,
                  title: op.id,
                  currency: INR,
                }),
              );
              if (!model.has(op.id) && !removed.has(op.id)) {
                model.set(op.id, { title: op.id, done: false });
              }
              break;
            case 'update':
              envs.push(env(MutationKind.PlanItemUpdate, { itemId: op.id, title: op.title }));
              // An update only shows on a live item; on a missing or removed one it is a no-op.
              if (model.has(op.id)) model.get(op.id)!.title = op.title;
              break;
            case 'done':
              envs.push(env(MutationKind.PlanItemUpdate, { itemId: op.id, done: op.done }));
              if (model.has(op.id)) model.get(op.id)!.done = op.done;
              break;
            case 'delete':
              envs.push(env(MutationKind.PlanItemDelete, { itemId: op.id }));
              if (model.has(op.id)) {
                model.delete(op.id);
                removed.add(op.id);
              }
              break;
            case 'ghost-delete':
              envs.push(env(MutationKind.PlanItemDelete, { itemId: op.id }));
              break;
            case 'other-group':
              envs.push(
                env(
                  MutationKind.PlanItemCreate,
                  { itemId: op.id, day: '2026-05-01', title: op.id, currency: INR },
                  OTHER,
                ),
              );
              break;
          }
        }

        const queue = build(envs);
        const all = materialisePlanItems(emptyMirror(), queue, { groupId: GROUP });
        const open = openPlanItems(all);
        const openIds = new Set(open.map((r) => r.id));

        // 1. Exactly the live set is visible — no ghost creates, no leaked other-group items.
        expect(openIds).toEqual(new Set(model.keys()));
        // 2. No removed item is ever shown, though its tombstone is retained for sync.
        for (const id of removed) expect(openIds.has(id)).toBe(false);
        // 3. No duplicates.
        expect(open.length).toBe(openIds.size);
        // 4. Every visible row is genuinely live and carries the title/done the model expects.
        for (const r of open) {
          const expected = model.get(r.id)!;
          expect(r.deleted_at).toBeNull();
          expect(r.title).toBe(expected.title);
          expect(r.done_at !== null).toBe(expected.done);
        }
        // 5. Deterministic: materialising the same inputs twice is identical.
        const again = openPlanItems(materialisePlanItems(emptyMirror(), queue, { groupId: GROUP }));
        expect(again.map((r) => r.id)).toEqual(open.map((r) => r.id));
        // 6. Sorted by (day, position, then queue order / id) — non-decreasing day.
        const days = open.map((r) => r.day);
        expect([...days].sort()).toEqual(days);
      }),
      { numRuns: RUNS },
    );
  });
});

// ───────────────────────────────────────────────── member-budget monkey ──

describe('monkey: my trip budget reflects only my last set/clear', () => {
  it('is present with the last amount, or absent after a clear', () => {
    const ME = 'me-0001';
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              t: fc.constant('set' as const),
              amount: positiveAmounts(2_000_000n),
              vis: fc.constantFrom('private' as const, 'group' as const),
            }),
            fc.record({ t: fc.constant('clear' as const) }),
          ),
          { minLength: 0, maxLength: 40 },
        ),
        (ops) => {
          const envs: MutationEnvelope[] = [];
          let expected: { amount: bigint } | null = null;
          for (const op of ops) {
            if (op.t === 'set') {
              envs.push(
                env(MutationKind.MemberBudgetSet, {
                  amountMinor: op.amount.toString(),
                  currency: INR,
                  visibility: op.vis,
                }),
              );
              expected = { amount: op.amount };
            } else {
              envs.push(env(MutationKind.MemberBudgetClear, {}));
              expected = null;
            }
          }
          const rows = materialiseMemberBudgets(emptyMirror(), build(envs), {
            groupId: GROUP,
            myMemberId: ME,
          });
          if (expected === null) {
            expect(rows).toHaveLength(0);
          } else {
            expect(rows).toHaveLength(1);
            expect(rows[0]?.amount_minor).toBe(expected.amount.toString());
            expect(rows[0]?.deleted_at).toBeNull();
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ──────────────────────────────────────────── reconcile idempotency stress ──

const syncBatch = (): fc.Arbitrary<SyncChange[]> =>
  fc
    .array(
      fc.record({
        table: fc.constantFrom(SyncTable.TripPlanItems, SyncTable.Settlements),
        groupId: fc.constantFrom(GROUP, OTHER),
        // The bare row number; the group is prefixed below so the id is unique
        // across groups. Production ids are UUIDs (globally unique), so a `row-5`
        // in one group and a `row-5` in another cannot be the same row — and the
        // mirror stores a table's rows by id, so letting the fuzzer collide two
        // groups on one id models a state the protocol never produces and makes
        // the order-independence assertion spuriously order-dependent.
        id: fc.integer({ min: 0, max: 200 }).map((n) => `row-${n}`),
        // A random positive step, accumulated per group below, so each group's
        // seqs are strictly increasing and unique — the protocol baaki_next_group_seq
        // guarantees. The reverse-order assertion depends on this: two changes
        // sharing a seq would make the winner order-dependent.
        step: fc.integer({ min: 1, max: 50 }),
        deleted: fc.boolean(),
      }),
      { minLength: 0, maxLength: 120 },
    )
    .map((rows) => {
      const nextSeq: Record<string, number> = {};
      return rows.map((r) => {
        nextSeq[r.groupId] = (nextSeq[r.groupId] ?? 0) + r.step;
        // Group-namespaced id, matching production's globally-unique UUIDs, so no
        // two groups ever share a storage key in a table.
        const rowId = `${r.groupId}:${r.id}`;
        return {
          table: r.table,
          groupId: r.groupId,
          seq: nextSeq[r.groupId] as number,
          row: {
            id: rowId,
            group_id: r.groupId,
            day: '2026-05-01',
            currency: INR,
            deleted_at: null,
            position: 0,
            title: rowId,
          },
          deleted: r.deleted,
        };
      });
    });

describe('stress: reconciling a pull is idempotent and cursors only move forward', () => {
  it('re-applying the same batch changes nothing and skips everything', () => {
    fc.assert(
      fc.property(syncBatch(), (batch) => {
        const first = reconcile(emptyMirror(), batch);
        const second = reconcile(first.state, batch);

        // 1. The mirror is a fixed point: a second identical pull is a no-op.
        expect(second.state).toEqual(first.state);
        // 2. Everything in the second pass was recognised as already-seen.
        expect(second.skipped).toBe(batch.length);
        // 3. Each group's cursor is exactly the highest seq that targeted it.
        const maxSeq = new Map<string, number>();
        for (const c of batch) maxSeq.set(c.groupId, Math.max(maxSeq.get(c.groupId) ?? 0, c.seq));
        for (const [g, seq] of maxSeq) expect(first.state.cursors[g]).toBe(seq);
        // 4. Applying in shuffled order lands on the same state (order-independent within a batch).
        const shuffled = reconcile(emptyMirror(), [...batch].reverse());
        expect(shuffled.state).toEqual(first.state);
      }),
      { numRuns: RUNS },
    );
  });
});

// ───────────────────────────────────────────────────── money at scale ──

/** A big internally-consistent ledger: many members, many expenses, many settlements. */
const bigLedger = fc
  .record({
    members: memberIds(2, 40),
    expenseCount: fc.integer({ min: 0, max: 200 }),
    settleCount: fc.integer({ min: 0, max: 40 }),
  })
  .chain(({ members, expenseCount, settleCount }) =>
    fc.record({
      members: fc.constant(members),
      expenses: fc.array(
        fc.record({
          amount: positiveAmounts(5_000_000n),
          payerOffset: fc.integer({ min: 0, max: members.length - 1 }),
          payerCount: fc.integer({ min: 1, max: members.length }),
          partOffset: fc.integer({ min: 0, max: members.length - 1 }),
          partCount: fc.integer({ min: 1, max: members.length }),
          day: fc.integer({ min: 1, max: 28 }),
          deleted: fc.boolean(),
        }),
        { minLength: expenseCount, maxLength: expenseCount },
      ),
      settlements: fc.array(
        fc.record({
          amount: positiveAmounts(200_000n),
          fromIndex: fc.integer({ min: 0, max: members.length - 1 }),
          toOffset: fc.integer({ min: 1, max: Math.max(1, members.length - 1) }),
          status: fc.constantFrom(
            SettlementStatus.Initiated,
            SettlementStatus.Confirmed,
            SettlementStatus.AutoConfirmed,
            SettlementStatus.Cancelled,
          ),
        }),
        { minLength: settleCount, maxLength: settleCount },
      ),
    }),
  )
  .map(({ members, expenses, settlements }) => {
    const built: ExpenseSnapshot[] = expenses.map((d, i) => {
      const take = (offset: number, count: number): MemberId[] => {
        const out: MemberId[] = [];
        for (let s = 0; s < count; s += 1)
          out.push(members[(offset + s) % members.length] as MemberId);
        return [...new Set(out)];
      };
      const id = `e-${i}`;
      const shares = computeShares({
        amount: d.amount,
        currency: INR,
        params: { kind: 'equal' },
        participants: take(d.partOffset, d.partCount),
        seed: id,
      });
      const payers = computeShares({
        amount: d.amount,
        currency: INR,
        params: { kind: 'equal' },
        participants: take(d.payerOffset, d.payerCount),
        seed: `${id}:p`,
      });
      return {
        id,
        currency: INR,
        amount: d.amount,
        payers: Object.fromEntries(payers),
        shares: Object.fromEntries(shares),
        date: `2026-03-${String(d.day).padStart(2, '0')}`,
        deletedAt: d.deleted ? '2026-04-01T00:00:00Z' : null,
      } satisfies ExpenseSnapshot;
    });
    const builtSettles: SettlementSnapshot[] = settlements.map((d, i) => ({
      id: `s-${i}`,
      from: members[d.fromIndex] as MemberId,
      to: members[(d.fromIndex + d.toOffset) % members.length] as MemberId,
      currency: INR,
      amount: d.amount,
      status: d.status,
      at: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    }));
    return { members, expenses: built, settlements: builtSettles };
  });

describe('stress: big ledgers stay balanced to the paisa', () => {
  it('net balances sum to zero and reconcile with the pairwise ledger', () => {
    fc.assert(
      fc.property(bigLedger, ({ members, expenses, settlements }) => {
        const net = computeNetBalances(expenses, settlements);
        // 1. Zero-sum per currency — the ledger never invents or loses money.
        for (const total of balanceSums(net).values()) expect(total).toBe(0n);
        // 2. The headline net equals what the pairwise ledger implies, member by member.
        const implied = netFromPairwise(computePairwiseBalances(expenses, settlements));
        for (const m of members) {
          expect(implied.get(INR)?.get(m) ?? 0n).toBe(net.get(INR)?.get(m) ?? 0n);
        }
        // 3. Every live expense's shares sum to its amount (no paisa leaks at scale).
        for (const e of expenses) {
          if (e.deletedAt) continue;
          const sum = Object.values(e.shares).reduce((a, b) => a + b, 0n);
          expect(sum).toBe(e.amount);
        }
      }),
      { numRuns: SCALE_RUNS },
    );
  });
});
