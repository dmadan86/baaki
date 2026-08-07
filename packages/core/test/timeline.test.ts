/**
 * The trip timeline: days, plans, and what they actually cost.
 */

import { describe, expect, it } from 'vitest';

import {
  addDays,
  budgetVariance,
  buildTimeline,
  dayNumber,
  daysBetween,
  type PlanItem,
  type TimelineExpense,
} from '../src/trip/timeline';

const item = (over: Partial<PlanItem> & { id: string; day: string }): PlanItem => ({
  startsAt: null,
  title: 'Something',
  note: null,
  category: null,
  plannedMinor: null,
  currency: 'INR',
  done: false,
  expenseId: null,
  position: 0,
  ...over,
});

const spend = (
  over: Partial<TimelineExpense> & { id: string; date: string; amountMinor: bigint },
): TimelineExpense => ({
  description: 'Something',
  category: null,
  currency: 'INR',
  ...over,
});

describe('walking the days', () => {
  it('counts across a month end without a timezone touching it', () => {
    // Building a Date to add a day is how a trip starting on the 14th shows
    // its first expense on the 13th for everybody east of UTC.
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('includes both ends of a range', () => {
    expect(daysBetween('2026-03-14', '2026-03-17')).toEqual([
      '2026-03-14',
      '2026-03-15',
      '2026-03-16',
      '2026-03-17',
    ]);
    expect(daysBetween('2026-03-14', '2026-03-14')).toEqual(['2026-03-14']);
  });

  it('says nothing rather than looping on a backwards range', () => {
    expect(daysBetween('2026-03-17', '2026-03-14')).toEqual([]);
    expect(daysBetween('', '2026-03-14')).toEqual([]);
  });

  it('knows which day of the trip it is', () => {
    expect(dayNumber('2026-03-14', '2026-03-14', '2026-03-17')).toBe(1);
    expect(dayNumber('2026-03-16', '2026-03-14', '2026-03-17')).toBe(3);
    expect(dayNumber('2026-03-18', '2026-03-14', '2026-03-17')).toBeNull();
    expect(dayNumber('2026-03-14', null, null)).toBeNull();
  });
});

describe('the timeline', () => {
  it('keeps an empty day in the middle', () => {
    // A planner that hides the days with nothing on them is a planner nobody
    // can plan into.
    const timeline = buildTimeline({
      items: [item({ id: 'a', day: '2026-03-14' })],
      expenses: [],
      startDate: '2026-03-14',
      endDate: '2026-03-16',
    });
    expect(timeline.days.map((day) => day.day)).toEqual(['2026-03-14', '2026-03-15', '2026-03-16']);
    expect(timeline.days[1]!.items).toEqual([]);
  });

  it('keeps an expense from outside the trip dates rather than dropping it', () => {
    // An expense on the way home is a real expense, and hiding it would make
    // these totals disagree with the group's own balances.
    const timeline = buildTimeline({
      items: [],
      expenses: [spend({ id: 'e', date: '2026-03-18', amountMinor: 5000n })],
      startDate: '2026-03-14',
      endDate: '2026-03-16',
    });
    expect(timeline.days.map((day) => day.day)).toContain('2026-03-18');
    expect(timeline.spentByCurrency).toEqual({ INR: 5000n });
  });

  it('works for a group with no dates at all', () => {
    const timeline = buildTimeline({
      items: [item({ id: 'a', day: '2026-03-14' })],
      expenses: [spend({ id: 'e', date: '2026-03-15', amountMinor: 100n })],
    });
    expect(timeline.days.map((day) => day.day)).toEqual(['2026-03-14', '2026-03-15']);
  });

  it('puts timed things first, in order, and leaves the rest where they were put', () => {
    const timeline = buildTimeline({
      items: [
        item({ id: 'c', day: 'd', position: 2 }),
        item({ id: 'b', day: 'd', startsAt: '14:00' }),
        item({ id: 'a', day: 'd', startsAt: '09:30' }),
        item({ id: 'd', day: 'd', position: 1 }),
      ],
      expenses: [],
    });
    expect(timeline.days[0]!.items.map((entry) => entry.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('adds up planned and spent per day and over the trip', () => {
    const timeline = buildTimeline({
      items: [
        item({ id: 'a', day: '2026-03-14', plannedMinor: 200000n }),
        item({ id: 'b', day: '2026-03-15', plannedMinor: 50000n }),
        // No estimate yet — counted as nothing, not as budgeted-at-zero.
        item({ id: 'c', day: '2026-03-15' }),
      ],
      expenses: [
        spend({ id: 'e1', date: '2026-03-14', amountMinor: 315000n }),
        spend({ id: 'e2', date: '2026-03-15', amountMinor: 40000n }),
      ],
      startDate: '2026-03-14',
      endDate: '2026-03-15',
    });

    expect(timeline.days[0]!.plannedByCurrency).toEqual({ INR: 200000n });
    expect(timeline.days[0]!.spentByCurrency).toEqual({ INR: 315000n });
    expect(timeline.plannedByCurrency).toEqual({ INR: 250000n });
    expect(timeline.spentByCurrency).toEqual({ INR: 355000n });
  });

  it('never mixes two currencies into one number', () => {
    // A day with a hotel in euros and lunch in rupees has two totals, not one
    // made up by a rate nobody agreed (ADR-003).
    const timeline = buildTimeline({
      items: [
        item({ id: 'a', day: 'd', plannedMinor: 12000n, currency: 'EUR' }),
        item({ id: 'b', day: 'd', plannedMinor: 80000n, currency: 'INR' }),
      ],
      expenses: [
        spend({ id: 'e1', date: 'd', amountMinor: 15000n, currency: 'EUR' }),
        spend({ id: 'e2', date: 'd', amountMinor: 60000n, currency: 'INR' }),
      ],
    });
    expect(timeline.plannedByCurrency).toEqual({ EUR: 12000n, INR: 80000n });
    expect(timeline.spentByCurrency).toEqual({ EUR: 15000n, INR: 60000n });
  });
});

describe('planned against actual', () => {
  it('reports over budget as positive, because that is the number people look for', () => {
    expect(
      budgetVariance({ plannedByCurrency: { INR: 250000n }, spentByCurrency: { INR: 355000n } }),
    ).toEqual({ INR: 105000n });
  });

  it('reports under budget as negative', () => {
    expect(
      budgetVariance({ plannedByCurrency: { INR: 250000n }, spentByCurrency: { INR: 100000n } }),
    ).toEqual({ INR: -150000n });
  });

  it('does not let a trip look on budget because nobody budgeted', () => {
    expect(budgetVariance({ plannedByCurrency: {}, spentByCurrency: { INR: 90000n } })).toEqual({
      INR: 90000n,
    });
    expect(budgetVariance({ plannedByCurrency: { EUR: 5000n }, spentByCurrency: {} })).toEqual({
      EUR: -5000n,
    });
  });

  it('keeps each currency’s answer separate', () => {
    expect(
      budgetVariance({
        plannedByCurrency: { INR: 100n, EUR: 100n },
        spentByCurrency: { INR: 150n, EUR: 50n },
      }),
    ).toEqual({ INR: 50n, EUR: -50n });
  });
});
