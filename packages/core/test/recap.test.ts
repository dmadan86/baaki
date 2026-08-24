/**
 * Recap pins: currencies stay in separate blocks, the daily average divides by
 * the trip's real length (not just days with spend), and every "top" is
 * deterministic on a tie.
 */

import { describe, expect, it } from 'vitest';

import { recap, type RecapExpense } from '../src/trip/recap';

const expenses: RecapExpense[] = [
  {
    id: 'e1',
    date: '2026-03-14',
    description: 'Houseboat',
    category: 'stays',
    amountMinor: 40000n,
    currency: 'INR',
    payers: [{ member: 'ravi', amountMinor: 40000n }],
  },
  {
    id: 'e2',
    date: '2026-03-14',
    description: 'Lunch',
    category: 'food',
    amountMinor: 4000n,
    currency: 'INR',
    payers: [{ member: 'asha', amountMinor: 4000n }],
  },
  {
    id: 'e3',
    date: '2026-03-15',
    description: 'Beers',
    category: 'food',
    amountMinor: 40000n, // ties the houseboat; e1 wins the biggest by id order
    currency: 'INR',
    payers: [{ member: 'ravi', amountMinor: 40000n }],
  },
  {
    id: 'e4',
    date: '2026-03-15',
    description: 'Spa',
    category: 'wellness',
    amountMinor: 9000n,
    currency: 'THB',
    payers: [{ member: 'neha', amountMinor: 9000n }],
  },
];

describe('recap', () => {
  it('carries one block per currency, biggest total first', () => {
    const r = recap({ expenses });
    expect(r.byCurrency.map((b) => b.currency)).toEqual(['INR', 'THB']);
    expect(r.byCurrency[0].totalMinor).toBe(84000n);
    expect(r.expenseCount).toBe(4);
  });

  it('ranks the top category by spend, breaking ties by name', () => {
    const r = recap({ expenses });
    // food = 44000, stays = 40000 → food leads.
    expect(r.byCurrency[0].topCategory).toEqual({ category: 'food', totalMinor: 44000n });
  });

  it('breaks a biggest-expense tie deterministically by id', () => {
    const r = recap({ expenses });
    expect(r.byCurrency[0].biggestExpense?.id).toBe('e1');
  });

  it('credits the top payer across every expense they fronted', () => {
    const r = recap({ expenses });
    expect(r.byCurrency[0].topPayer).toEqual({ member: 'ravi', paidMinor: 80000n });
  });

  it('averages over the trip length when given dates, not just active days', () => {
    const r = recap({ expenses, startDate: '2026-03-14', endDate: '2026-03-17' });
    // 84000 over 4 trip days, not 2 days-with-spend.
    expect(r.byCurrency[0].dayCount).toBe(4);
    expect(r.byCurrency[0].dailyAverageMinor).toBe(21000n);
  });

  it('falls back to days-with-spend when the trip has no dates', () => {
    const r = recap({ expenses });
    expect(r.byCurrency[0].dayCount).toBe(2); // the 14th and 15th
    expect(r.byCurrency[0].dailyAverageMinor).toBe(42000n);
    expect(r.firstDay).toBe('2026-03-14');
    expect(r.lastDay).toBe('2026-03-15');
  });

  it('leaves uncategorised spend out of the category race', () => {
    const r = recap({
      expenses: [
        {
          id: 'x',
          date: '2026-03-14',
          description: 'ATM',
          category: null,
          amountMinor: 5000n,
          currency: 'INR',
          payers: [{ member: 'ravi', amountMinor: 5000n }],
        },
      ],
    });
    expect(r.byCurrency[0].topCategory).toBeNull();
  });
});
