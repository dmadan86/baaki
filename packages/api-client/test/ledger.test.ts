/**
 * Rows into balances, in a browser.
 *
 * The risk this covers is not arithmetic — that is @waves/core's, and it is
 * property-tested there. It is the conversion on the way in. PostgREST hands
 * minor units back as decimal strings, and every one of them has to become a
 * bigint before anything touches it. A single `Number()` slipping in would
 * produce balances that look right, agree with themselves, and quietly differ
 * from the app's by a paisa — which is the version of this bug nobody catches.
 */

import { describe, expect, it } from 'vitest';

import { computeLedger, toExpenseSnapshot, type Expense, type Settlement } from '../src/index';

function expense(over: Partial<Expense['currentVersion']> = {}, id = 'e-1'): Expense {
  return {
    id,
    group_id: 'g-1',
    deleted_at: null,
    created_at: '2026-08-06T10:00:00.000Z',
    currentVersion: {
      id: `${id}-v1`,
      version_no: 1,
      description: 'Dinner',
      category: null,
      expense_date: '2026-08-04',
      currency: 'INR',
      amount: '45000',
      split_type: 'equal',
      split_params: { kind: 'equal' },
      payers: [{ member_id: 'asha', amount: '45000' }],
      shares: [
        { member_id: 'asha', amount: '22500' },
        { member_id: 'ravi', amount: '22500' },
      ],
      ...over,
    } as Expense['currentVersion'],
  };
}

describe('reading amounts off the wire', () => {
  it('turns every string into a bigint', () => {
    const snapshot = toExpenseSnapshot(expense());
    expect(snapshot?.amount).toBe(45000n);
    expect(snapshot?.payers.asha).toBe(22500n * 2n);
    expect(snapshot?.shares.ravi).toBe(22500n);
  });

  it('holds an amount a double would round', () => {
    // 2^53 + 1. A Number here would come back one unit light and every balance
    // downstream would be quietly wrong.
    const snapshot = toExpenseSnapshot(
      expense({
        amount: '9007199254740993',
        payers: [{ member_id: 'asha', amount: '9007199254740993' }],
        shares: [{ member_id: 'asha', amount: '9007199254740993' }],
      }),
    );
    expect(snapshot?.amount).toBe(9007199254740993n);
  });

  it('has nothing to say about an expense with no version', () => {
    expect(toExpenseSnapshot({ ...expense(), currentVersion: null })).toBeNull();
  });
});

describe('what a guest sees', () => {
  it('says who is owed and who owes', () => {
    const ledger = computeLedger([expense()], [], 'INR');
    expect(ledger.balances.get('asha')).toBe(22500n);
    expect(ledger.balances.get('ravi')).toBe(-22500n);
  });

  it('adds up to zero', () => {
    // Every rupee somebody is owed is a rupee somebody else owes. If this ever
    // failed, money would have been created.
    const ledger = computeLedger([expense(), expense({}, 'e-2')], [], 'INR');
    const total = [...ledger.balances.values()].reduce((sum, value) => sum + value, 0n);
    expect(total).toBe(0n);
  });

  it('leaves a deleted expense out', () => {
    const deleted = { ...expense(), deleted_at: '2026-08-05T00:00:00.000Z' };
    expect(computeLedger([deleted], [], 'INR').balances.size).toBe(0);
  });

  it('counts a confirmed settlement and ignores a pending one', () => {
    // ADR-004: only a confirmed settlement moves the headline balance. Counting
    // a claim would tell somebody they had been paid when they had not.
    const settlement = (status: string): Settlement => ({
      id: `s-${status}`,
      group_id: 'g-1',
      from_member_id: 'ravi',
      to_member_id: 'asha',
      currency: 'INR',
      amount: '22500',
      status,
      initiated_at: '2026-08-05T00:00:00.000Z',
      confirmed_at: status === 'confirmed' ? '2026-08-05T01:00:00.000Z' : null,
    });

    expect(computeLedger([expense()], [settlement('pending')], 'INR').balances.get('ravi')).toBe(
      -22500n,
    );
    expect(computeLedger([expense()], [settlement('confirmed')], 'INR').balances.get('ravi')).toBe(
      0n,
    );
  });

  it('never mixes two currencies into one figure', () => {
    // A trip abroad has both. Adding them would need a rate nobody chose.
    const euro = expense(
      {
        currency: 'EUR',
        amount: '4000',
        payers: [{ member_id: 'ravi', amount: '4000' }],
        shares: [
          { member_id: 'asha', amount: '2000' },
          { member_id: 'ravi', amount: '2000' },
        ],
      },
      'e-eur',
    );
    const ledger = computeLedger([expense(), euro], [], 'INR');
    expect(ledger.balances.get('asha')).toBe(22500n);
    // The euro side is still in the transfers, in euros, not folded into INR.
    expect(ledger.transfers.some((transfer) => transfer.currency === 'EUR')).toBe(true);
  });

  it('has nothing to show a browser that is not a member', () => {
    // RLS returns no rows rather than an error; that must read as "settled up
    // with nobody", not as a crash.
    expect(computeLedger([], [], 'INR').balances.size).toBe(0);
  });
});
