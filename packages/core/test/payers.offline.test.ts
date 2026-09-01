/**
 * A bill several people paid, all the way down the offline-first path.
 *
 * `payers.test.ts` proves the arithmetic. This proves the *plumbing*: that a
 * multi-payer expense queued on a plane shows the right balance before it ever
 * reaches a server, that editing it re-versions rather than duplicates, and that
 * what the mirror replays matches what the server would have computed.
 *
 * The pipeline here is the one `useGroupLedger` runs to produce the group hero
 * number — mirror + queue overlay, materialised, netted (ADR-005) — so a break
 * in this file is a wrong number on somebody's screen, not a failing abstraction.
 */

import { describe, expect, it } from 'vitest';

import {
  balanceSums,
  computeNetBalances,
  emptyMirror,
  enqueue,
  liveExpenses,
  materialiseExpenses,
  MutationKind,
  payerTotal,
  serialisePayers,
  splitPaidEqually,
  toExpenseSnapshot,
  validatePayers,
  type ExpenseCreatePayload,
  type ExpenseSnapshot,
  type MemberId,
  type MirrorState,
  type QueuedMutation,
} from '../src/index.js';

const INR = 'INR';
const GROUP = 'goa';

const ASHA: MemberId = 'm-asha';
const RAVI: MemberId = 'm-ravi';
const MO: MemberId = 'm-mo';
const SAM: MemberId = 'm-sam';
const EVERYONE = [ASHA, RAVI, MO, SAM];

/** Queue a create, the way the add-expense screen does. */
function queueCreate(
  queue: readonly QueuedMutation[],
  payload: ExpenseCreatePayload,
  clientMutationId: string,
): QueuedMutation[] {
  return enqueue(queue, {
    clientMutationId,
    kind: MutationKind.ExpenseCreate,
    groupId: GROUP,
    clientCreatedAt: '2026-09-01T00:00:00.000Z',
    payload,
  });
}

/** Every live expense the group has, mirror plus anything still unsent. */
function snapshots(mirror: MirrorState, queue: readonly QueuedMutation[]): ExpenseSnapshot[] {
  return liveExpenses(materialiseExpenses(mirror, queue, { groupId: GROUP }))
    .map(toExpenseSnapshot)
    .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);
}

/** The group hero's number for one member. */
function balance(mirror: MirrorState, queue: readonly QueuedMutation[], member: MemberId): bigint {
  return computeNetBalances(snapshots(mirror, queue), []).get(INR)?.get(member) ?? 0n;
}

describe('a multi-payer bill queued offline', () => {
  it('nets correctly before it has ever reached a server', () => {
    // ₹1000 dinner for four. Asha put in ₹600, Ravi ₹400.
    const payers = new Map([
      [ASHA, 60_000n],
      [RAVI, 40_000n],
    ]);
    expect(validatePayers(100_000n, payers)).toBeNull();

    const queue = queueCreate(
      [],
      {
        expenseId: 'e-dinner',
        description: 'Beach shack dinner',
        expenseDate: '2026-09-01',
        currency: INR,
        amount: '100000',
        splitParams: { kind: 'equal' },
        participants: EVERYONE,
        payers: serialisePayers(payers),
      },
      'cm-1',
    );

    const mirror = emptyMirror();
    expect(balance(mirror, queue, ASHA)).toBe(35_000n); // paid 600, owes 250
    expect(balance(mirror, queue, RAVI)).toBe(15_000n); // paid 400, owes 250
    expect(balance(mirror, queue, MO)).toBe(-25_000n);
    expect(balance(mirror, queue, SAM)).toBe(-25_000n);
    expect(balanceSums(computeNetBalances(snapshots(mirror, queue), [])).get(INR)).toBe(0n);
  });

  it('is one expense in the ledger, not one per payer', () => {
    const queue = queueCreate(
      [],
      {
        expenseId: 'e-dinner',
        description: 'Beach shack dinner',
        expenseDate: '2026-09-01',
        currency: INR,
        amount: '100000',
        splitParams: { kind: 'equal' },
        participants: EVERYONE,
        payers: { [ASHA]: '60000', [RAVI]: '40000' },
      },
      'cm-1',
    );
    const rows = snapshots(emptyMirror(), queue);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]?.payers ?? {})).toHaveLength(2);
  });

  it('survives the round trip through the wire form the queue stores', () => {
    // The payload holds decimal strings, because JSON has no bigint. What comes
    // back out of the mirror has to be the same money that went in.
    const paid = splitPaidEqually(100_001n, [ASHA, RAVI, MO], 'e-odd');
    const queue = queueCreate(
      [],
      {
        expenseId: 'e-odd',
        description: 'Auto',
        expenseDate: '2026-09-01',
        currency: INR,
        amount: '100001',
        splitParams: { kind: 'equal' },
        participants: EVERYONE,
        payers: serialisePayers(paid),
      },
      'cm-odd',
    );
    const row = snapshots(emptyMirror(), queue)[0] as ExpenseSnapshot;
    const back = new Map(Object.entries(row.payers));
    expect(payerTotal(back)).toBe(100_001n);
    expect(payerTotal(back)).toBe(row.amount);
  });

  it('editing it to a single payer moves the money without duplicating the row', () => {
    let queue = queueCreate(
      [],
      {
        expenseId: 'e-dinner',
        description: 'Beach shack dinner',
        expenseDate: '2026-09-01',
        currency: INR,
        amount: '100000',
        splitParams: { kind: 'equal' },
        participants: [ASHA, RAVI],
        payers: { [ASHA]: '60000', [RAVI]: '40000' },
      },
      'cm-1',
    );
    // The correction: Ravi actually paid the whole thing.
    queue = enqueue(queue, {
      clientMutationId: 'cm-2',
      kind: MutationKind.ExpenseUpdate,
      groupId: GROUP,
      clientCreatedAt: '2026-09-01T01:00:00.000Z',
      payload: {
        expenseId: 'e-dinner',
        description: 'Beach shack dinner',
        expenseDate: '2026-09-01',
        currency: INR,
        amount: '100000',
        splitParams: { kind: 'equal' },
        participants: [ASHA, RAVI],
        payers: { [RAVI]: '100000' },
      },
    });

    const rows = snapshots(emptyMirror(), queue);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payers).toEqual({ [RAVI]: 100_000n });
    expect(balance(emptyMirror(), queue, ASHA)).toBe(-50_000n);
    expect(balance(emptyMirror(), queue, RAVI)).toBe(50_000n);
  });

  it('several multi-payer bills in one queue still sum to zero across the group', () => {
    let queue = queueCreate(
      [],
      {
        expenseId: 'e-1',
        description: 'Hotel',
        expenseDate: '2026-09-01',
        currency: INR,
        amount: '333333',
        splitParams: { kind: 'equal' },
        participants: EVERYONE,
        payers: serialisePayers(splitPaidEqually(333_333n, [ASHA, RAVI, MO], 'e-1')),
      },
      'cm-1',
    );
    queue = queueCreate(
      queue,
      {
        expenseId: 'e-2',
        description: 'Boat',
        expenseDate: '2026-09-02',
        currency: INR,
        amount: '77777',
        splitParams: {
          kind: 'shares' as const,
          weights: { [ASHA]: 2, [RAVI]: 1, [MO]: 1, [SAM]: 1 },
        },
        participants: EVERYONE,
        payers: { [SAM]: '50000', [MO]: '27777' },
      },
      'cm-2',
    );

    const rows = snapshots(emptyMirror(), queue);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(payerTotal(new Map(Object.entries(row.payers)))).toBe(row.amount);
    }
    expect(balanceSums(computeNetBalances(rows, [])).get(INR)).toBe(0n);
  });

  it('a payer who is not in the split still shows up as a creditor', () => {
    const queue = queueCreate(
      [],
      {
        expenseId: 'e-gift',
        description: 'Dad chipped in',
        expenseDate: '2026-09-01',
        currency: INR,
        amount: '60000',
        splitParams: { kind: 'equal' },
        participants: [ASHA, RAVI],
        payers: { [MO]: '30000', [ASHA]: '30000' },
      },
      'cm-gift',
    );
    expect(balance(emptyMirror(), queue, MO)).toBe(30_000n);
    expect(balance(emptyMirror(), queue, ASHA)).toBe(0n);
    expect(balance(emptyMirror(), queue, RAVI)).toBe(-30_000n);
  });
});
