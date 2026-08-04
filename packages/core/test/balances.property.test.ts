/**
 * ADR-004 / ADR-014: balances are derived, and they always sum to zero.
 * The Postgres derived tables are tested against these same rules in
 * packages/db, so client and server can never disagree.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  balanceSums,
  computeNetBalances,
  computePairwiseBalances,
  netFromPairwise,
} from '../src/balances/balances.js';
import type { ExpenseSnapshot, SettlementSnapshot } from '../src/balances/types.js';
import { computeShares } from '../src/split/computeShares.js';
import type { MemberId } from '../src/split/types.js';
import { memberIds, positiveAmounts } from './arbitraries.js';

const INR = 'INR';

/** A group of expenses whose payers and shares are internally consistent. */
const groupLedger = fc
  .record({
    members: memberIds(2, 6),
    expenseCount: fc.integer({ min: 0, max: 12 }),
    settlementCount: fc.integer({ min: 0, max: 5 }),
  })
  .chain(({ members, expenseCount, settlementCount }) =>
    fc.record({
      members: fc.constant(members),
      expenses: fc.array(
        fc.record({
          amount: positiveAmounts(500_000n),
          payerCount: fc.integer({ min: 1, max: members.length }),
          payerOffset: fc.integer({ min: 0, max: members.length - 1 }),
          participantCount: fc.integer({ min: 1, max: members.length }),
          participantOffset: fc.integer({ min: 0, max: members.length - 1 }),
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
            'initiated' as const,
            'confirmed' as const,
            'auto_confirmed' as const,
            'cancelled' as const,
          ),
        }),
        { minLength: settlementCount, maxLength: settlementCount },
      ),
    }),
  )
  .map(({ members, expenses, settlements }) => {
    const built: ExpenseSnapshot[] = expenses.map((draw, index) => {
      const participants: MemberId[] = [];
      for (let step = 0; step < draw.participantCount; step += 1) {
        participants.push(members[(draw.participantOffset + step) % members.length] as MemberId);
      }
      const uniqueParticipants = [...new Set(participants)];
      const id = `exp-${index}`;
      const shareMap = computeShares({
        amount: draw.amount,
        currency: INR,
        params: { kind: 'equal' },
        participants: uniqueParticipants,
        seed: id,
      });

      // Split what was actually paid across `payerCount` members.
      const payerList: MemberId[] = [];
      for (let step = 0; step < draw.payerCount; step += 1) {
        payerList.push(members[(draw.payerOffset + step) % members.length] as MemberId);
      }
      const uniquePayers = [...new Set(payerList)];
      const paidMap = computeShares({
        amount: draw.amount,
        currency: INR,
        params: { kind: 'equal' },
        participants: uniquePayers,
        seed: `${id}:payers`,
      });

      return {
        id,
        currency: INR,
        amount: draw.amount,
        payers: Object.fromEntries(paidMap),
        shares: Object.fromEntries(shareMap),
        date: `2026-03-${String(draw.day).padStart(2, '0')}`,
        deletedAt: draw.deleted ? '2026-04-01T00:00:00Z' : null,
      } satisfies ExpenseSnapshot;
    });

    const builtSettlements: SettlementSnapshot[] = settlements.map((draw, index) => {
      const from = members[draw.fromIndex] as MemberId;
      const to = members[(draw.fromIndex + draw.toOffset) % members.length] as MemberId;
      return {
        id: `set-${index}`,
        from,
        to,
        currency: INR,
        amount: draw.amount,
        status: draw.status,
        at: `2026-04-0${(index % 9) + 1}T10:00:00Z`,
      } satisfies SettlementSnapshot;
    });

    return { members, expenses: built, settlements: builtSettlements };
  });

describe('derived balances', () => {
  it('always sum to zero per currency', () => {
    fc.assert(
      fc.property(groupLedger, ({ expenses, settlements }) => {
        const balances = computeNetBalances(expenses, settlements);
        for (const total of balanceSums(balances).values()) {
          expect(total).toBe(0n);
        }
      }),
    );
  });

  it('sum to zero with pending settlements included too', () => {
    fc.assert(
      fc.property(groupLedger, ({ expenses, settlements }) => {
        const balances = computeNetBalances(expenses, settlements, { includePending: true });
        for (const total of balanceSums(balances).values()) {
          expect(total).toBe(0n);
        }
      }),
    );
  });

  it('reconcile exactly with the pairwise ledger', () => {
    fc.assert(
      fc.property(groupLedger, ({ members, expenses, settlements }) => {
        const net = computeNetBalances(expenses, settlements);
        const pairwise = computePairwiseBalances(expenses, settlements);
        const impliedNet = netFromPairwise(pairwise);
        for (const member of members) {
          expect(impliedNet.get(INR)?.get(member) ?? 0n).toBe(net.get(INR)?.get(member) ?? 0n);
        }
      }),
    );
  });

  it('ignores soft-deleted expenses but keeps them restorable data', () => {
    const live: ExpenseSnapshot = {
      id: 'e1',
      currency: INR,
      amount: 10000n,
      payers: { asha: 10000n },
      shares: { asha: 5000n, ravi: 5000n },
      date: '2026-03-01',
      deletedAt: null,
    };
    const deleted: ExpenseSnapshot = { ...live, id: 'e2', deletedAt: '2026-03-02T00:00:00Z' };

    const balances = computeNetBalances([live, deleted], []);
    expect(balances.get(INR)?.get('asha')).toBe(5000n);
    expect(balances.get(INR)?.get('ravi')).toBe(-5000n);
  });

  it('counts confirmed settlements and excludes pending ones from the headline', () => {
    const expense: ExpenseSnapshot = {
      id: 'e1',
      currency: INR,
      amount: 10000n,
      payers: { asha: 10000n },
      shares: { asha: 5000n, ravi: 5000n },
      date: '2026-03-01',
    };
    const pending: SettlementSnapshot = {
      id: 's1',
      from: 'ravi',
      to: 'asha',
      currency: INR,
      amount: 5000n,
      status: 'initiated',
      at: '2026-03-02T00:00:00Z',
    };

    expect(computeNetBalances([expense], [pending]).get(INR)?.get('ravi')).toBe(-5000n);
    expect(
      computeNetBalances([expense], [pending], { includePending: true }).get(INR)?.get('ravi'),
    ).toBe(0n);
    expect(
      computeNetBalances([expense], [{ ...pending, status: 'confirmed' }]).get(INR)?.get('ravi'),
    ).toBe(0n);
  });
});
