/**
 * The group hero banner shows the viewer's *net* balance, not total group spend.
 *
 * A bug was reported as "when I add an expense, the total amount is not updating
 * in the group hero banner", from a screenshot of a **solo** group ("Goa", one
 * member) reading "All settled ₹0". This suite pins down what the hero is
 * supposed to do, so the report can be judged against behaviour rather than a
 * hunch.
 *
 * The hero reads `useGroupLedger().myBalance`
 * (`apps/mobile/src/data/hooks.ts`), which is:
 *
 *   computeNetBalances(snapshots, settlements).get(currency).get(myMemberId)
 *
 * where `snapshots = materialiseExpenses(mirror, queue, {groupId})` — the mirror
 * with the local mutation queue replayed on top, so a freshly added but still
 * *unsynced* expense is already included (ADR-005, local-first).
 *
 * The mobile `toSnapshot` is a byte-for-byte analogue of core's
 * `toExpenseSnapshot` (both flatten `currentVersion` into an `ExpenseSnapshot`),
 * so reproducing the hero maths with core primitives here exercises the exact
 * arithmetic the banner shows. If these ever diverge, `useGroupLedger`'s own
 * `mismatch` guard would fire against the DB-derived balances.
 */

import { describe, expect, it } from 'vitest';

import {
  computeNetBalances,
  emptyMirror,
  enqueue,
  liveExpenses,
  materialiseExpenses,
  MutationKind,
  toExpenseSnapshot,
  type ExpenseSnapshot,
  type MemberId,
  type MirrorState,
  type QueuedMutation,
  type SettlementSnapshot,
  type ExpenseCreatePayload,
} from '../src/index.js';

const INR = 'INR';

/**
 * Exactly the hero's number: the viewer's net balance in the group currency,
 * computed from the mirror + queue overlay, before any sync. This is the same
 * pipeline `useGroupLedger` runs to produce `myBalance`.
 */
function heroBalance(
  mirror: MirrorState,
  queue: readonly QueuedMutation[],
  groupId: string,
  myMemberId: MemberId,
  settlements: readonly SettlementSnapshot[] = [],
  currency = INR,
): bigint {
  const snapshots = liveExpenses(materialiseExpenses(mirror, queue, { groupId }))
    .map(toExpenseSnapshot)
    .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);
  const net = computeNetBalances(snapshots, settlements);
  return net.get(currency)?.get(myMemberId) ?? 0n;
}

/** Queue an offline expense.create, the way the add-expense screen does. */
function addExpense(
  queue: readonly QueuedMutation[],
  groupId: string,
  payload: ExpenseCreatePayload,
  clientMutationId: string,
  at = '2026-08-25T00:00:00.000Z',
): QueuedMutation[] {
  return enqueue(queue, {
    clientMutationId,
    kind: MutationKind.ExpenseCreate,
    groupId,
    clientCreatedAt: at,
    payload,
  });
}

describe('the group hero balance (useGroupLedger.myBalance)', () => {
  it('solo group: paying for an expense you fully consume nets to 0 — the ₹0 hero is correct', () => {
    // Reproduces the "Goa, 1 member, All settled ₹0" screenshot. The sole member
    // pays the whole bill and is the only participant, so paid − owed = 0.
    const groupId = 'goa';
    const me: MemberId = 'm-solo';

    const before = heroBalance(emptyMirror(), [], groupId, me);
    expect(before).toBe(0n);

    const queue = addExpense(
      [],
      groupId,
      {
        expenseId: 'e1',
        description: 'Beach shack lunch',
        expenseDate: '2026-08-25',
        currency: INR,
        amount: '50000', // ₹500
        splitParams: { kind: 'equal' },
        participants: [me],
        payers: { [me]: '50000' },
      },
      'cm-1',
    );

    // The expense IS materialised from the queue (it is not being dropped)…
    const snapshots = liveExpenses(materialiseExpenses(emptyMirror(), queue, { groupId }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.pending).toBe(true);

    // …but a solo member's net position is unchanged: they owe no one and are
    // owed by no one. The hero staying ₹0 is expected, not a stale-UI bug.
    expect(heroBalance(emptyMirror(), queue, groupId, me)).toBe(0n);
  });

  it('two-member group with a ghost: the payer moves immediately from the queue, pre-sync', () => {
    // The real add-expense → hero path in a shareable group. Mirror is empty
    // (nothing synced); the balance must move purely from the pending queue.
    const groupId = 'trip';
    const me: MemberId = 'm-me';
    const ghost: MemberId = 'm-ghost';

    expect(heroBalance(emptyMirror(), [], groupId, me)).toBe(0n);

    const queue = addExpense(
      [],
      groupId,
      {
        expenseId: 'e1',
        description: 'Cab from airport',
        expenseDate: '2026-08-25',
        currency: INR,
        amount: '1000', // ₹10, split equally: 500 / 500
        splitParams: { kind: 'equal' },
        participants: [me, ghost],
        payers: { [me]: '1000' },
      },
      'cm-1',
    );

    // I paid 1000, my share is 500 → I am owed 500, before any sync.
    expect(heroBalance(emptyMirror(), queue, groupId, me)).toBe(500n);
    // The ghost owes their 500 share.
    expect(heroBalance(emptyMirror(), queue, groupId, ghost)).toBe(-500n);
  });

  it('multiple payers + uneven (weighted) split still nets correctly from the queue', () => {
    const groupId = 'dinner';
    const m1: MemberId = 'm1';
    const m2: MemberId = 'm2';

    // ₹10 total. Weights 1:3 → m1 owes 250, m2 owes 750.
    // Payers are uneven too: m1 fronts 600, m2 fronts 400.
    const queue = addExpense(
      [],
      groupId,
      {
        expenseId: 'e1',
        description: 'Split bill, split tab',
        expenseDate: '2026-08-25',
        currency: INR,
        amount: '1000',
        splitParams: { kind: 'shares', weights: { [m1]: 1, [m2]: 3 } },
        participants: [m1, m2],
        payers: { [m1]: '600', [m2]: '400' },
      },
      'cm-1',
    );

    // m1: paid 600 − owed 250 = +350. m2: paid 400 − owed 750 = −350.
    expect(heroBalance(emptyMirror(), queue, groupId, m1)).toBe(350n);
    expect(heroBalance(emptyMirror(), queue, groupId, m2)).toBe(-350n);
    // Zero-sum invariant across the two members.
    const m1b = heroBalance(emptyMirror(), queue, groupId, m1);
    const m2b = heroBalance(emptyMirror(), queue, groupId, m2);
    expect(m1b + m2b).toBe(0n);
  });

  it('reactivity: enqueuing yields a NEW queue reference whose overlay reflects the add', () => {
    // The provider re-renders on a new `queue` reference; the group screen's
    // `useMemo([mirror, queue, groupId])` then recomputes. Prove that enqueue
    // returns a fresh array AND that the materialised balance changes with it —
    // the two facts the memo depends on to update the hero without a sync.
    const groupId = 'trip';
    const me: MemberId = 'm-me';
    const ghost: MemberId = 'm-ghost';

    const before: QueuedMutation[] = [];
    expect(heroBalance(emptyMirror(), before, groupId, me)).toBe(0n);

    const after = addExpense(
      before,
      groupId,
      {
        expenseId: 'e1',
        description: 'Groceries',
        expenseDate: '2026-08-25',
        currency: INR,
        amount: '2000',
        splitParams: { kind: 'equal' },
        participants: [me, ghost],
        payers: { [me]: '2000' },
      },
      'cm-1',
    );

    // New reference (the memo dep actually changes identity)…
    expect(after).not.toBe(before);
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(1);
    // …and the recomputed hero moves from the same inputs the memo would see.
    expect(heroBalance(emptyMirror(), after, groupId, me)).toBe(1000n);
  });

  it('a confirmed settlement clears the payer back toward zero', () => {
    // Sanity that the hero also reflects settlements, not only expenses.
    const groupId = 'trip';
    const me: MemberId = 'm-me';
    const ghost: MemberId = 'm-ghost';

    const queue = addExpense(
      [],
      groupId,
      {
        expenseId: 'e1',
        description: 'Hotel',
        expenseDate: '2026-08-25',
        currency: INR,
        amount: '1000',
        splitParams: { kind: 'equal' },
        participants: [me, ghost],
        payers: { [me]: '1000' },
      },
      'cm-1',
    );
    expect(heroBalance(emptyMirror(), queue, groupId, me)).toBe(500n);

    // Ghost pays me back 500 (confirmed) → I am settled.
    const settlements: SettlementSnapshot[] = [
      {
        id: 's1',
        from: ghost,
        to: me,
        currency: INR,
        amount: 500n,
        status: 'confirmed' as SettlementSnapshot['status'],
        at: '2026-08-26T00:00:00.000Z',
      },
    ];
    expect(heroBalance(emptyMirror(), queue, groupId, me, settlements)).toBe(0n);
  });
});
