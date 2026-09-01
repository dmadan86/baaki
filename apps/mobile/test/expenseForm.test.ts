/**
 * The expense form's decisions.
 *
 * These are the parts of the add/edit route that quietly rewrite saved facts
 * when they are wrong: the day an expense is filed under, and which of several
 * payers' figures survive a tap. The route renders none of this in a test —
 * mobile's vitest has no renderer by design — so the decisions live in
 * src/lib/expenseForm.ts as plain functions and are checked here.
 */

import { describe, expect, it } from 'vitest';
import { rebalancePayers, type PayerMap } from '@waves/core';

import {
  expenseDateFor,
  planCollapseToOne,
  planEvenly,
  planToggle,
  planTypedAmount,
  todayIso,
} from '@/lib/expenseForm';

const TODAY = '2026-09-01';
const map = (rows: Record<string, bigint>): PayerMap => new Map(Object.entries(rows));

/** What the route does with a plan: hand it to core and read the figures back. */
const settle = (
  plan: { selected: readonly string[]; current: PayerMap; locked: ReadonlySet<string> },
  amount: bigint,
): Record<string, string> =>
  Object.fromEntries(
    [
      ...rebalancePayers({
        amount,
        selected: plan.selected,
        current: plan.current,
        locked: plan.locked,
        seed: 'expense-1',
      }),
    ].map(([id, paid]) => [id, paid.toString()]),
  );

describe('expenseDateFor', () => {
  it('keeps the day a saved expense already has', () => {
    // The regression this exists for: editing a description used to re-file the
    // expense under today, moving it between months and writing a date change
    // into its history that nobody made.
    expect(expenseDateFor({ captureDate: null, savedDate: '2026-08-11', today: TODAY })).toBe(
      '2026-08-11',
    );
  });

  it('files a genuinely new expense under today', () => {
    expect(expenseDateFor({ captureDate: null, savedDate: null, today: TODAY })).toBe(TODAY);
    expect(expenseDateFor({ captureDate: undefined, savedDate: undefined, today: TODAY })).toBe(
      TODAY,
    );
  });

  it('gives a capture the day it was caught, over both', () => {
    expect(
      expenseDateFor({ captureDate: '2026-07-04', savedDate: '2026-08-11', today: TODAY }),
    ).toBe('2026-07-04');
  });

  it('writes a plain UTC day, never a timestamp', () => {
    expect(todayIso(new Date('2026-09-01T22:45:00.000Z'))).toBe('2026-09-01');
  });
});

describe('planToggle', () => {
  const three = map({ a: 4000n, b: 3000n, c: 3000n });

  it('replaces the payer in one-payer mode and hands over the whole bill', () => {
    const plan = planToggle({
      many: false,
      payers: map({ a: 10000n }),
      locked: new Set(),
      amount: 10000n,
      memberId: 'b',
    });
    expect(settle(plan!, 10000n)).toEqual({ b: '10000' });
  });

  it('adds a payer in several-payer mode and re-divides what is unlocked', () => {
    const plan = planToggle({
      many: true,
      payers: map({ a: 10000n }),
      locked: new Set(),
      amount: 10000n,
      memberId: 'b',
    });
    expect(plan!.selected).toEqual(['a', 'b']);
    expect(settle(plan!, 10000n)).toEqual({ a: '5000', b: '5000' });
  });

  it('removes a payer, and drops the lock that went with them', () => {
    const plan = planToggle({
      many: true,
      payers: three,
      locked: new Set(['a', 'c']),
      amount: 10000n,
      memberId: 'c',
    });
    expect(plan!.selected).toEqual(['a', 'b']);
    // c's lock is gone with c; a's is kept, so a's stated 4000 survives and b
    // absorbs the rest. Keeping c's lock would have held a figure for a row
    // that is no longer there and left the bill short by it.
    expect(plan!.locked).toEqual(new Set(['a']));
    expect(settle(plan!, 10000n)).toEqual({ a: '4000', b: '6000' });
  });

  it('refuses to remove the last payer', () => {
    expect(
      planToggle({
        many: true,
        payers: map({ a: 10000n }),
        locked: new Set(),
        amount: 10000n,
        memberId: 'a',
      }),
    ).toBeNull();
  });
});

describe('planCollapseToOne', () => {
  it('keeps whoever put in the most, and gives them the whole bill', () => {
    const plan = planCollapseToOne({
      payers: map({ a: 2000n, b: 5000n, c: 3000n }),
      amount: 10000n,
    });
    expect(settle(plan!, 10000n)).toEqual({ b: '10000' });
  });

  it('has nothing to do when one person is already paying', () => {
    expect(planCollapseToOne({ payers: map({ a: 10000n }), amount: 10000n })).toBeNull();
    expect(planCollapseToOne({ payers: map({}), amount: 10000n })).toBeNull();
  });
});

describe('planTypedAmount', () => {
  it('locks the figure that was typed and lets the others absorb', () => {
    const plan = planTypedAmount({
      payers: map({ a: 5000n, b: 5000n }),
      locked: new Set(),
      memberId: 'a',
      text: '30',
      currency: 'INR',
    });
    expect(plan.locked).toEqual(new Set(['a']));
    expect(plan.typed).toEqual({ member: 'a', text: '30' });
    expect(settle(plan, 10000n)).toEqual({ a: '3000', b: '7000' });
  });

  it('keeps a half-typed figure exactly as it was typed', () => {
    // "12." must not snap back to "12.00" under the thumb mid-keystroke.
    const plan = planTypedAmount({
      payers: map({ a: 5000n, b: 5000n }),
      locked: new Set(),
      memberId: 'a',
      text: '12.',
      currency: 'INR',
    });
    expect(plan.typed?.text).toBe('12.');
    expect(plan.current.get('a')).toBe(1200n);
  });

  it('reads the typed characters in the field currency, not in paise always', () => {
    const yen = planTypedAmount({
      payers: map({ a: 0n, b: 0n }),
      locked: new Set(),
      memberId: 'a',
      text: '100',
      currency: 'JPY',
    });
    expect(yen.current.get('a')).toBe(100n);
  });

  it('holds every stated figure, so an over-assigned bill is reported not rescaled', () => {
    const plan = planTypedAmount({
      payers: map({ a: 8000n, b: 5000n }),
      locked: new Set(['b']),
      memberId: 'a',
      text: '80',
      currency: 'INR',
    });
    // Both are locked now and they sum past the total. Nothing is quietly
    // scaled down — the figures stand and the form says the bill is over.
    expect(settle(plan, 10000n)).toEqual({ a: '8000', b: '5000' });
  });
});

describe('planEvenly', () => {
  it('drops every lock and splits the paying', () => {
    const plan = planEvenly(map({ a: 9000n, b: 500n, c: 500n }));
    expect(plan.locked.size).toBe(0);
    // 10000 across three is 3333.34 short of even; core's rotation places the
    // odd paisa, and the total is exact.
    const settled = settle(plan, 10000n);
    expect(Object.values(settled).reduce((sum, v) => sum + BigInt(v), 0n)).toBe(10000n);
  });
});
