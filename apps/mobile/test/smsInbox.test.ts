/**
 * What the Bank messages screen shows, and what it adds up.
 *
 * Three rules here are the ones a person would actually notice going wrong, and
 * all three are invisible in code review:
 *
 *   * **A date window means what it says.** "Last 7 days" cut in instants
 *     rather than days drops this morning's coffee at lunchtime, and there is
 *     nothing on screen to suggest it did.
 *   * **Select all means what is on screen.** A search narrowed to one shop,
 *     then "select all", must never tick the eighty rows the search hid — that
 *     is the one mistake this screen could make that costs real money.
 *   * **A total in two currencies is no total.** ₹400 plus $12 is a number true
 *     of nothing, and a number true of nothing on a money screen is worse than
 *     a blank.
 */

import { describe, expect, it } from 'vitest';

import { SmsKind } from '@waves/core';

import {
  allSelected,
  DEFAULT_DATE_FILTER,
  filterBounds,
  matchesQuery,
  monthsPresent,
  reachedReview,
  smsInboxRows,
  stepMonth,
  sumOf,
  toggleAll,
  toggleSelected,
  totalWaiting,
  waitingCounts,
  type SmsDateFilter,
} from '@/lib/smsInbox';
import { SmsSettlement, type StoredSms } from '@/lib/smsMessageTypes';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');

let counter = 0;
function row(overrides: Partial<StoredSms> = {}): StoredSms {
  counter += 1;
  return {
    dedupeKey: `ref:${counter}`,
    body: 'Rs.250 debited at SWIGGY',
    sender: 'AD-HDFCBK',
    kind: SmsKind.Expense,
    reason: null,
    merchant: 'SWIGGY',
    accountTail: '4471',
    currency: 'INR',
    amount: '25000',
    occurredOn: '2026-09-12',
    at: '2026-09-12T10:00:00.000Z',
    confidence: 0.95,
    dateInferred: false,
    settledAs: null,
    captureId: null,
    readAt: '2026-09-13T09:00:00.000Z',
    ...overrides,
  };
}

const shown = (
  rows: readonly StoredSms[],
  over: Partial<Parameters<typeof smsInboxRows>[0]> = {},
) =>
  smsInboxRows({
    rows,
    kind: SmsKind.Expense,
    query: '',
    date: DEFAULT_DATE_FILTER,
    now: NOW,
    ...over,
  });

describe('narrowing by date', () => {
  it('cuts a quick window in days, not in instants', () => {
    // Six days back, inclusive: everything that happened on that day counts,
    // not only the part of it later than this moment.
    expect(filterBounds({ kind: 'window', days: 7 }, NOW)).toEqual({
      from: '2026-09-07',
      to: null,
    });
  });

  it('lets "all" mean all of it', () => {
    expect(filterBounds({ kind: 'window', days: 0 }, NOW)).toEqual({ from: null, to: null });
  });

  it('takes a month as its own bound, with no arithmetic about its length', () => {
    const bounds = filterBounds({ kind: 'month', month: '2026-02' }, NOW);
    expect('2026-02-28' >= bounds.from!).toBe(true);
    expect('2026-02-28' <= bounds.to!).toBe(true);
    expect('2026-03-01' <= bounds.to!).toBe(false);
  });

  it('reads a range handed over backwards as the days between', () => {
    // Somebody dragging a start date past the end should get those days, not
    // an empty screen that looks like the app lost their messages.
    expect(filterBounds({ kind: 'range', from: '2026-09-20', to: '2026-09-14' }, NOW)).toEqual({
      from: '2026-09-14',
      to: '2026-09-20',
    });
  });

  it('keeps what is inside the window and drops what is outside', () => {
    const rows = [row({ occurredOn: '2026-09-12' }), row({ occurredOn: '2026-06-01' })];
    const week: SmsDateFilter = { kind: 'window', days: 7 };
    expect(shown(rows, { date: week })).toHaveLength(1);
    expect(shown(rows, { date: { kind: 'window', days: 0 } })).toHaveLength(2);
  });
});

describe('the month stepper', () => {
  const rows = [
    row({ occurredOn: '2026-09-12' }),
    row({ occurredOn: '2026-08-03' }),
    row({ occurredOn: '2026-06-30' }),
  ];

  it('offers only months that actually hold something', () => {
    // A stepper that can land on an empty month is one people press twice and
    // then stop trusting. July is simply not on the list.
    expect(monthsPresent(rows)).toEqual(['2026-09', '2026-08', '2026-06']);
  });

  it('steps over the gap rather than into it', () => {
    const months = monthsPresent(rows);
    expect(stepMonth(months, '2026-08', 'older')).toBe('2026-06');
    expect(stepMonth(months, '2026-06', 'newer')).toBe('2026-08');
  });

  it('stops at either end', () => {
    const months = monthsPresent(rows);
    expect(stepMonth(months, '2026-09', 'newer')).toBeNull();
    expect(stepMonth(months, '2026-06', 'older')).toBeNull();
  });
});

describe('searching', () => {
  const swiggy = row({ merchant: 'SWIGGYLIMITED', amount: '25000' });
  const amazon = row({ merchant: 'AMZN*MKTP', amount: '90000', sender: 'VM-ICICIB' });

  it('matches the middle of a word, not only the start', () => {
    // Banks write SWIGGYLIMITED and AMZN*MKTP; people type the middle.
    expect(matchesQuery(swiggy, 'wiggy')).toBe(true);
    expect(matchesQuery(amazon, 'mktp')).toBe(true);
  });

  it('narrows with every word, in any order', () => {
    expect(matchesQuery(swiggy, 'swiggy 25000')).toBe(true);
    expect(matchesQuery(swiggy, '25000 swiggy')).toBe(true);
    expect(matchesQuery(swiggy, 'swiggy 90000')).toBe(false);
  });

  it('finds a row by the bank that sent it', () => {
    expect(matchesQuery(amazon, 'icici')).toBe(true);
  });

  it('never matches against the message itself', () => {
    // The body is on the row — it is on this device — but a search over it
    // would quietly become a substring match across every one-time password
    // the bank ever sent. Deliberately out.
    const odd = row({ merchant: null, body: 'Rs.250 debited at CURIOUSPHRASE' });
    expect(matchesQuery(odd, 'curiousphrase')).toBe(false);
  });

  it('shows everything for an empty query', () => {
    expect(matchesQuery(swiggy, '   ')).toBe(true);
  });
});

describe('which rows a tab shows', () => {
  const rows = [
    row({ kind: SmsKind.Expense }),
    row({ kind: SmsKind.Income, merchant: null }),
    row({ kind: SmsKind.Other }),
  ];

  it('keeps to its own pile', () => {
    expect(shown(rows, { kind: SmsKind.Expense })).toHaveLength(1);
    expect(shown(rows, { kind: SmsKind.Income })).toHaveLength(1);
    expect(shown(rows, { kind: SmsKind.Other })).toHaveLength(1);
  });

  it('empties as it is worked through', () => {
    const done = [row({ settledAs: SmsSettlement.Placed }), row()];
    expect(shown(done)).toHaveLength(1);
    expect(shown(done, { includeSettled: true })).toHaveLength(2);
  });

  it('orders by the day the money moved, not the day it was read', () => {
    // After a backfill these differ by up to ninety days, and ordering by the
    // second drops a whole quarter into one lump under "today".
    const spread = [
      row({ occurredOn: '2026-09-01', readAt: '2026-09-13T09:00:00.000Z', amount: '100' }),
      row({ occurredOn: '2026-09-12', readAt: '2026-09-13T09:00:01.000Z', amount: '200' }),
    ];
    expect(shown(spread, { date: { kind: 'window', days: 0 } }).map((each) => each.amount)).toEqual(
      ['200', '100'],
    );
  });
});

describe('counting what is waiting', () => {
  const rows = [
    row({ kind: SmsKind.Expense }),
    row({ kind: SmsKind.Expense, settledAs: SmsSettlement.Placed }),
    row({ kind: SmsKind.Income }),
    row({ kind: SmsKind.Other }),
    row({ kind: SmsKind.Other, settledAs: SmsSettlement.Dismissed }),
  ];

  it('counts only what has not been answered', () => {
    const counts = waitingCounts(rows);
    expect(counts[SmsKind.Expense]).toBe(1);
    expect(counts[SmsKind.Income]).toBe(1);
    expect(counts[SmsKind.Other]).toBe(1);
    expect(totalWaiting(rows)).toBe(3);
  });

  it('ignores the date filter — a badge is about the whole pile', () => {
    // The badge on the entry row answers "is there anything for me here", and
    // a badge that changed when somebody moved a chip would be meaningless.
    expect(totalWaiting(rows)).toBe(3);
  });
});

describe('which rows Review already has', () => {
  it('says so for a confident expense', () => {
    expect(reachedReview(row())).toBe(true);
  });

  it('and not for one whose day was guessed', () => {
    expect(reachedReview(row({ dateInferred: true }))).toBe(false);
  });

  it('and not for one the parser half understood', () => {
    expect(reachedReview(row({ confidence: 0.6 }))).toBe(false);
  });

  it('and never for income or anything else', () => {
    expect(reachedReview(row({ kind: SmsKind.Income }))).toBe(false);
    expect(reachedReview(row({ kind: SmsKind.Other }))).toBe(false);
  });
});

describe('ticking rows', () => {
  const visible = [row({ dedupeKey: 'a' }), row({ dedupeKey: 'b' }), row({ dedupeKey: 'c' })];

  it('toggles one at a time, into a new set each time', () => {
    const once = toggleSelected(new Set(), 'a');
    expect([...once]).toEqual(['a']);
    expect([...toggleSelected(once, 'a')]).toEqual([]);
  });

  it('has one control that selects all and then clears', () => {
    const all = toggleAll(visible, new Set());
    expect(all.size).toBe(3);
    expect(allSelected(visible, all)).toBe(true);
    expect(toggleAll(visible, all).size).toBe(0);
  });

  it('never ticks a row the search has hidden', () => {
    // The one mistake on this screen that costs real money: a bulk action over
    // rows nobody looked at.
    const onScreen = [visible[0]!];
    const ticked = toggleAll(onScreen, new Set());
    expect([...ticked]).toEqual(['a']);
  });

  it('does not clear ticks on rows the search is hiding right now', () => {
    // Selecting all of a filtered view, then clearing it, must not also clear
    // a row ticked before the filter was applied.
    const held = new Set(['b']);
    const cleared = toggleAll([visible[0]!], toggleAll([visible[0]!], held));
    expect([...cleared]).toEqual(['b']);
  });
});

describe('what the ticked rows come to', () => {
  it('adds up one currency', () => {
    const total = sumOf([row({ amount: '25000' }), row({ amount: '75000' })]);
    expect(total).toEqual({ count: 2, total: 100000n, currency: 'INR' });
  });

  it('refuses to add up two', () => {
    // ₹400 + $12 is a number true of nothing. The count still is true.
    const total = sumOf([row({ amount: '40000' }), row({ amount: '1200', currency: 'USD' })]);
    expect(total.count).toBe(2);
    expect(total.total).toBeNull();
  });

  it('does not fall over on an amount the ledger could not take', () => {
    const total = sumOf([row({ amount: 'not-a-number' })]);
    expect(total.count).toBe(1);
    expect(total.total).toBeNull();
  });

  it('is nothing for nothing', () => {
    expect(sumOf([])).toEqual({ count: 0, total: null, currency: '' });
  });
});
