/**
 * The personal-finance maths (A48). All of it is pure, so the sums the "Me" tab
 * shows — a month's net, a loan's outstanding balance, a budget's remaining, and
 * when a recurring rule is next due — are pinned here without a device.
 */

import { describe, expect, it } from 'vitest';

import {
  addToDate,
  cashflowTrend,
  categoryBreakdown,
  dayDelta,
  decodeTxn,
  encodeTxn,
  isRecurringDue,
  loanOutstanding,
  monthlySummary,
  nextRecurring,
  personalBudgetProgress,
  recentMonths,
  recurringCatchUp,
  recurringOccurrenceId,
  savingsRate,
  worstOverBudget,
  type PersonalBudget,
  type PersonalLoan,
  type PersonalRecurring,
  type PersonalTxn,
} from '../src/personal/index.js';

const txn = (over: Partial<PersonalTxn>): PersonalTxn => ({
  id: over.id ?? crypto.randomUUID(),
  kind: over.kind ?? 'expense',
  amount: over.amount ?? 0n,
  currency: over.currency ?? 'INR',
  category: over.category ?? null,
  note: over.note ?? null,
  date: over.date ?? '2026-08-15',
  loanId: over.loanId ?? null,
  recurringId: over.recurringId ?? null,
});

describe('addToDate', () => {
  it('hops exact weeks', () => {
    expect(addToDate('2026-08-15', 'weekly', 1)).toBe('2026-08-22');
    expect(addToDate('2026-08-28', 'weekly', 1)).toBe('2026-09-04');
  });

  it('clamps a month step to the shorter month', () => {
    // Jan 31 + 1 month is Feb 28, not an invalid Feb 31 that rolls into March.
    expect(addToDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(addToDate('2028-01-31', 'monthly', 1)).toBe('2028-02-29'); // leap year
  });

  it('rolls a month step across the year boundary', () => {
    expect(addToDate('2026-12-10', 'monthly', 1)).toBe('2027-01-10');
    expect(addToDate('2026-11-15', 'monthly', 3)).toBe('2027-02-15');
  });

  it('clamps a yearly step off Feb 29', () => {
    expect(addToDate('2028-02-29', 'yearly', 1)).toBe('2029-02-28');
  });
});

describe('recurringCatchUp', () => {
  const base: PersonalRecurring = {
    id: 'r1',
    txnKind: 'expense',
    amount: 50000n,
    currency: 'INR',
    category: null,
    note: 'Phone',
    cadence: 'monthly',
    interval: 1,
    anchorDate: '2026-06-01',
    nextDate: '2026-06-01',
    endDate: null,
    autoPost: true,
    active: true,
  };

  it('returns every missed occurrence up to today, then the new next date', () => {
    const { dates, nextDate } = recurringCatchUp(base, '2026-08-15');
    expect(dates).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    expect(nextDate).toBe('2026-09-01');
  });

  it('stops at the end date', () => {
    const { dates } = recurringCatchUp({ ...base, endDate: '2026-07-01' }, '2026-12-01');
    expect(dates).toEqual(['2026-06-01', '2026-07-01']);
  });

  it('caps a far-past anchor rather than minting forever', () => {
    const { dates } = recurringCatchUp({ ...base, cadence: 'weekly' }, '2030-01-01', 10);
    expect(dates).toHaveLength(10);
  });

  it('isRecurringDue tracks active, end date and today', () => {
    expect(isRecurringDue(base, '2026-06-01')).toBe(true);
    expect(isRecurringDue(base, '2026-05-31')).toBe(false);
    expect(isRecurringDue({ ...base, active: false }, '2026-08-01')).toBe(false);
    expect(isRecurringDue({ ...base, endDate: '2026-05-01' }, '2026-08-01')).toBe(false);
  });
});

describe('recurringOccurrenceId', () => {
  it('is deterministic per rule and date, and a valid uuid shape', () => {
    const a = recurringOccurrenceId('r1', '2026-08-01');
    const b = recurringOccurrenceId('r1', '2026-08-01');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('differs by date and by rule', () => {
    expect(recurringOccurrenceId('r1', '2026-08-01')).not.toBe(
      recurringOccurrenceId('r1', '2026-09-01'),
    );
    expect(recurringOccurrenceId('r1', '2026-08-01')).not.toBe(
      recurringOccurrenceId('r2', '2026-08-01'),
    );
  });
});

describe('monthlySummary', () => {
  it('nets income against expense within one month and currency', () => {
    const txns = [
      txn({ kind: 'income', amount: 100000n, date: '2026-08-01' }),
      txn({ kind: 'expense', amount: 30000n, date: '2026-08-10' }),
      txn({ kind: 'expense', amount: 20000n, date: '2026-08-20' }),
      txn({ kind: 'expense', amount: 99999n, date: '2026-07-31' }), // other month
      txn({ kind: 'expense', amount: 99999n, currency: 'USD', date: '2026-08-05' }), // other currency
    ];
    const s = monthlySummary(txns, '2026-08', 'INR');
    expect(s.income).toBe(100000n);
    expect(s.expense).toBe(50000n);
    expect(s.net).toBe(50000n);
  });
});

describe('loanOutstanding', () => {
  const loan: PersonalLoan = {
    id: 'L1',
    direction: 'borrowed',
    counterpart: 'Bank',
    principal: 100000n,
    currency: 'INR',
    note: null,
    startDate: '2026-01-01',
    status: 'active',
  };

  it('is the principal less linked repayments, floored at zero', () => {
    const txns = [
      txn({ amount: 40000n, loanId: 'L1' }),
      txn({ amount: 70000n, loanId: 'L1' }), // over-pays
      txn({ amount: 99999n, loanId: 'other' }), // not this loan
    ];
    expect(loanOutstanding(loan, txns)).toBe(0n);
    expect(loanOutstanding(loan, [txn({ amount: 25000n, loanId: 'L1' })])).toBe(75000n);
  });
});

describe('personalBudgetProgress', () => {
  const budget: PersonalBudget = { id: 'B1', category: 'food', limit: 50000n, currency: 'INR' };

  it('counts matching-category expenses in the month, not income or loan repayments', () => {
    const txns = [
      txn({ kind: 'expense', category: 'food', amount: 20000n, date: '2026-08-02' }),
      txn({ kind: 'expense', category: 'food', amount: 15000n, date: '2026-08-09' }),
      txn({ kind: 'expense', category: 'travel', amount: 9999n, date: '2026-08-09' }), // other category
      txn({ kind: 'income', category: 'food', amount: 9999n, date: '2026-08-09' }), // income
      txn({ kind: 'expense', category: 'food', amount: 9999n, loanId: 'L1', date: '2026-08-09' }), // repayment
      txn({ kind: 'expense', category: 'food', amount: 9999n, date: '2026-07-31' }), // other month
    ];
    const p = personalBudgetProgress(budget, txns, '2026-08');
    expect(p.spent).toBe(35000n);
    expect(p.remaining).toBe(15000n);
  });

  it('an overall budget (null category) counts every everyday expense', () => {
    const overall: PersonalBudget = { id: 'B2', category: null, limit: 40000n, currency: 'INR' };
    const txns = [
      txn({ kind: 'expense', category: 'food', amount: 20000n, date: '2026-08-02' }),
      txn({ kind: 'expense', category: 'travel', amount: 30000n, date: '2026-08-02' }),
    ];
    const p = personalBudgetProgress(overall, txns, '2026-08');
    expect(p.spent).toBe(50000n);
    expect(p.remaining).toBe(-10000n); // over budget
  });
});

describe('txn codec', () => {
  it('round-trips through the wire blob', () => {
    const original = txn({
      kind: 'income',
      amount: 123456n,
      currency: 'INR',
      category: 'salary',
      note: 'August pay',
      date: '2026-08-01',
      loanId: null,
      recurringId: 'r9',
    });
    const decoded = decodeTxn(original.id, encodeTxn(original));
    expect(decoded).toEqual(original);
  });

  it('decodes a malformed blob to safe defaults rather than throwing', () => {
    const decoded = decodeTxn('x', { amount: 'not-a-number', kind: 'weird' });
    expect(decoded.amount).toBe(0n);
    expect(decoded.kind).toBe('expense');
    expect(decoded.currency).toBe('INR');
  });
});

describe('savingsRate', () => {
  it('is the fraction of income kept', () => {
    expect(savingsRate(1000n, 250n)).toBeCloseTo(0.75);
    expect(savingsRate(1000n, 1000n)).toBe(0);
  });

  it('is negative when spending runs past income', () => {
    expect(savingsRate(1000n, 1500n)).toBeCloseTo(-0.5);
  });

  it('is null when there was no income to measure against', () => {
    expect(savingsRate(0n, 500n)).toBeNull();
    expect(savingsRate(-10n, 0n)).toBeNull();
  });
});

describe('dayDelta', () => {
  it('counts whole days, signed, and across a month boundary', () => {
    expect(dayDelta('2026-08-28', '2026-08-28')).toBe(0);
    expect(dayDelta('2026-08-28', '2026-08-29')).toBe(1);
    expect(dayDelta('2026-08-28', '2026-08-27')).toBe(-1);
    expect(dayDelta('2026-08-28', '2026-09-01')).toBe(4);
  });

  it('is 0 for a malformed date rather than NaN', () => {
    expect(dayDelta('nope', '2026-08-28')).toBe(0);
  });
});

describe('recentMonths', () => {
  it('returns the count months ending at the anchor, oldest first', () => {
    expect(recentMonths('2026-08', 3)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('rolls the year boundary', () => {
    expect(recentMonths('2027-01', 3)).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('falls back to the anchor for a bad month or count', () => {
    expect(recentMonths('2026-08', 0)).toEqual(['2026-08']);
    expect(recentMonths('nope', 3)).toEqual(['nope']);
  });
});

describe('categoryBreakdown', () => {
  it('splits a month by category, biggest first, with shares that sum to one', () => {
    const txns = [
      txn({ kind: 'expense', category: 'food', amount: 30000n, date: '2026-08-02' }),
      txn({ kind: 'expense', category: 'food', amount: 10000n, date: '2026-08-10' }),
      txn({ kind: 'expense', category: 'travel', amount: 60000n, date: '2026-08-05' }),
      txn({ kind: 'income', category: 'salary', amount: 99999n, date: '2026-08-01' }), // income excluded
      txn({ kind: 'expense', category: 'food', amount: 99999n, date: '2026-07-31' }), // other month
      txn({
        kind: 'expense',
        category: 'food',
        amount: 99999n,
        currency: 'USD',
        date: '2026-08-01',
      }), // other currency
    ];
    const rows = categoryBreakdown(txns, '2026-08', 'INR');
    expect(rows.map((r) => r.category)).toEqual(['travel', 'food']);
    expect(rows[0]!.spent).toBe(60000n);
    expect(rows[1]!.spent).toBe(40000n);
    expect(rows[0]!.share).toBeCloseTo(0.6);
    expect(rows[1]!.share).toBeCloseTo(0.4);
  });

  it('folds uncategorised expenses under a null key and reconciles with the month expense', () => {
    const txns = [
      txn({ kind: 'expense', category: null, amount: 25000n, date: '2026-08-02' }),
      txn({ kind: 'expense', category: 'food', amount: 25000n, date: '2026-08-03' }),
    ];
    const rows = categoryBreakdown(txns, '2026-08', 'INR');
    const total = rows.reduce((sum, r) => sum + r.spent, 0n);
    expect(total).toBe(monthlySummary(txns, '2026-08', 'INR').expense);
    expect(rows.some((r) => r.category === null)).toBe(true);
  });

  it('is empty when nothing was spent that month', () => {
    expect(categoryBreakdown([], '2026-08', 'INR')).toEqual([]);
  });
});

describe('cashflowTrend', () => {
  it('gives income, expense and net per month in order', () => {
    const txns = [
      txn({ kind: 'income', amount: 100000n, date: '2026-06-01' }),
      txn({ kind: 'expense', amount: 40000n, date: '2026-06-10' }),
      txn({ kind: 'expense', amount: 20000n, date: '2026-08-05' }),
    ];
    const trend = cashflowTrend(txns, recentMonths('2026-08', 3), 'INR');
    expect(trend.map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(trend[0]).toMatchObject({ income: 100000n, expense: 40000n, net: 60000n });
    expect(trend[1]).toMatchObject({ income: 0n, expense: 0n, net: 0n });
    expect(trend[2]).toMatchObject({ income: 0n, expense: 20000n, net: -20000n });
  });
});

describe('nextRecurring', () => {
  const rule = (over: Partial<PersonalRecurring>): PersonalRecurring => ({
    id: over.id ?? 'r1',
    txnKind: over.txnKind ?? 'expense',
    amount: over.amount ?? 50000n,
    currency: over.currency ?? 'INR',
    category: over.category ?? null,
    note: over.note ?? null,
    cadence: over.cadence ?? 'monthly',
    interval: over.interval ?? 1,
    anchorDate: over.anchorDate ?? '2026-08-01',
    nextDate: over.nextDate ?? '2026-08-01',
    endDate: over.endDate ?? null,
    autoPost: over.autoPost ?? true,
    active: over.active ?? true,
  });

  it('picks the soonest active rule', () => {
    const picked = nextRecurring(
      [rule({ id: 'rent', nextDate: '2026-09-01' }), rule({ id: 'phone', nextDate: '2026-08-29' })],
      '2026-08-28',
    );
    expect(picked?.rule.id).toBe('phone');
    expect(picked?.date).toBe('2026-08-29');
  });

  it('skips paused and past-their-end rules', () => {
    const picked = nextRecurring(
      [
        rule({ id: 'a', nextDate: '2026-08-29', active: false }),
        rule({ id: 'b', nextDate: '2026-09-05', endDate: '2026-08-01' }),
        rule({ id: 'c', nextDate: '2026-09-10' }),
      ],
      '2026-08-28',
    );
    expect(picked?.rule.id).toBe('c');
  });

  it('is null when nothing is scheduled', () => {
    expect(nextRecurring([], '2026-08-28')).toBeNull();
    expect(nextRecurring([rule({ active: false })], '2026-08-28')).toBeNull();
  });
});

describe('worstOverBudget', () => {
  it('names the category furthest past its cap', () => {
    const budgets: PersonalBudget[] = [
      { id: 'food', category: 'food', limit: 50000n, currency: 'INR' },
      { id: 'travel', category: 'travel', limit: 20000n, currency: 'INR' },
    ];
    const txns = [
      txn({ kind: 'expense', category: 'food', amount: 60000n, date: '2026-08-02' }), // 10000 over
      txn({ kind: 'expense', category: 'travel', amount: 55000n, date: '2026-08-03' }), // 35000 over
    ];
    const worst = worstOverBudget(budgets, txns, '2026-08');
    expect(worst?.budget.id).toBe('travel');
    expect(worst?.over).toBe(35000n);
  });

  it('is null when everything is within its cap', () => {
    const budgets: PersonalBudget[] = [
      { id: 'food', category: 'food', limit: 50000n, currency: 'INR' },
    ];
    const txns = [txn({ kind: 'expense', category: 'food', amount: 10000n, date: '2026-08-02' })];
    expect(worstOverBudget(budgets, txns, '2026-08')).toBeNull();
    expect(worstOverBudget([], txns, '2026-08')).toBeNull();
  });
});
