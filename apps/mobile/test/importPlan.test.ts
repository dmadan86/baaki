/**
 * What an import turns into before it reaches the queue.
 *
 * The failure this guards against is not a crash. It is an import that
 * succeeds and is wrong: a share landing on the wrong member, a payer that
 * does not add up to the total, or a second copy of an expense somebody
 * already has. All three look fine on the screen that produced them.
 */

import { describe, expect, it } from 'vitest';

import type { ExpenseCandidate, ImportedExpense } from '@baaki/core';

import {
  planFromCsv,
  planFromSms,
  toMutationPayload,
  UnmappedPersonError,
} from '@/data/importPlan';

function candidate(over: Partial<ExpenseCandidate> = {}): ExpenseCandidate {
  return {
    amount: { minor: 45000n, currency: 'INR' },
    direction: 'debit',
    merchant: 'SWIGGY',
    accountTail: '4821',
    reference: '412345678901',
    occurredAt: '2026-08-04T00:00:00.000Z',
    confidence: 0.9,
    sender: 'AD-HDFCBK',
    at: '2026-08-04T00:00:00.000Z',
    dateInferred: false,
    dedupeKey: 'ref:412345678901',
    preselect: true,
    ...over,
  };
}

function imported(over: Partial<ImportedExpense> = {}): ImportedExpense {
  const shares = { Asha: 30000n, Ravi: 15000n };
  return {
    description: 'Dinner',
    category: 'Food',
    date: '2026-08-04',
    currency: 'INR',
    amount: 45000n,
    payers: { Asha: 45000n },
    shares,
    splitParams: { kind: 'exact', amounts: shares },
    ...over,
  };
}

describe('one bank message', () => {
  it('becomes an expense the payer covers in full', () => {
    const plan = planFromSms(candidate(), { payer: 'm-asha', participants: ['m-asha', 'm-ravi'] });

    expect(plan.amount).toBe(45000n);
    expect(plan.payers).toEqual({ 'm-asha': 45000n });
    expect(plan.splitParams).toEqual({ kind: 'equal' });
    expect(plan.participants).toEqual(['m-asha', 'm-ravi']);
  });

  it('files it on the day the bank said, not the day it was imported', () => {
    // A message that arrives late would otherwise land the expense on the
    // wrong day of a trip, which is exactly when the day matters.
    expect(planFromSms(candidate(), { payer: 'm', participants: ['m'] }).expenseDate).toBe(
      '2026-08-04',
    );
  });

  it('keeps the bank reference so the entry can be checked later', () => {
    const plan = planFromSms(candidate(), { payer: 'm', participants: ['m'] });
    expect(plan.notes).toContain('412345678901');
    expect(plan.notes).toContain('AD-HDFCBK');
  });

  it('says so when the date came from the message arriving', () => {
    const plan = planFromSms(candidate({ dateInferred: true }), {
      payer: 'm',
      participants: ['m'],
    });
    expect(plan.notes).toContain('date taken from when the message arrived');
  });

  it('falls back to a name when the message does not say where', () => {
    const plan = planFromSms(candidate({ merchant: null }), { payer: 'm', participants: ['m'] });
    expect(plan.description).toBe('Card payment');
  });

  it('refuses an expense with nobody to split it between', () => {
    expect(() => planFromSms(candidate(), { payer: 'm', participants: [] })).toThrow();
  });

  it('gives the same seed to the same message every time', () => {
    // This is what makes a second import a no-op rather than a second expense.
    const first = planFromSms(candidate(), { payer: 'm', participants: ['m'] });
    const second = planFromSms(candidate(), { payer: 'other', participants: ['other'] });
    expect(second.seed).toBe(first.seed);
  });
});

describe('one CSV row', () => {
  it('puts each person’s share on their member id', () => {
    const plan = planFromCsv(imported(), { Asha: 'm-asha', Ravi: 'm-ravi' }, 0);

    expect(plan.splitParams).toEqual({
      kind: 'exact',
      amounts: { 'm-asha': 30000n, 'm-ravi': 15000n },
    });
    expect(plan.payers).toEqual({ 'm-asha': 45000n });
    expect(plan.participants.sort()).toEqual(['m-asha', 'm-ravi']);
  });

  it('keeps shares summing to the total', () => {
    const plan = planFromCsv(imported(), { Asha: 'm-asha', Ravi: 'm-ravi' }, 0);
    const params = plan.splitParams as { kind: 'exact'; amounts: Record<string, bigint> };
    const total = Object.values(params.amounts).reduce((sum, value) => sum + value, 0n);
    expect(total).toBe(plan.amount);
  });

  it('adds two columns together when both point at one person', () => {
    // The same human listed under two spellings. Overwriting instead of adding
    // would make half their money vanish with nothing to show it happened.
    const shares = { Asha: 20000n, 'Asha K': 10000n, Ravi: 15000n };
    const plan = planFromCsv(
      imported({ shares, splitParams: { kind: 'exact', amounts: shares } }),
      { Asha: 'm-asha', 'Asha K': 'm-asha', Ravi: 'm-ravi' },
      0,
    );
    const params = plan.splitParams as { kind: 'exact'; amounts: Record<string, bigint> };
    expect(params.amounts['m-asha']).toBe(30000n);
  });

  it('refuses a name nobody was chosen for', () => {
    // Dropping them would leave a row whose shares no longer sum to its total.
    expect(() => planFromCsv(imported(), { Asha: 'm-asha' }, 0)).toThrow(UnmappedPersonError);
    expect(() => planFromCsv(imported(), { Asha: 'm-asha' }, 0)).toThrow(/Ravi/);
  });

  it('leaves out a payer who paid nothing', () => {
    const plan = planFromCsv(
      imported({ payers: { Asha: 45000n, Ravi: 0n } }),
      { Asha: 'm-asha', Ravi: 'm-ravi' },
      0,
    );
    expect(plan.payers).toEqual({ 'm-asha': 45000n });
  });

  it('tells two identical rows apart', () => {
    // The same coffee twice in one day is two expenses, and a file is allowed
    // to say so. Seeding on content alone would silently collapse them.
    const first = planFromCsv(imported(), { Asha: 'm-asha', Ravi: 'm-ravi' }, 0);
    const second = planFromCsv(imported(), { Asha: 'm-asha', Ravi: 'm-ravi' }, 1);
    expect(second.seed).not.toBe(first.seed);
  });

  it('gives the same seed to the same row of the same file', () => {
    const first = planFromCsv(imported(), { Asha: 'm-asha', Ravi: 'm-ravi' }, 3);
    const second = planFromCsv(imported(), { Asha: 'other', Ravi: 'other2' }, 3);
    expect(second.seed).toBe(first.seed);
  });
});

describe('the payload that goes on the queue', () => {
  it('survives JSON', () => {
    // The queue is written to disk as JSON. A bigint anywhere in here throws
    // on the way out, and the expense is lost rather than saved.
    const plan = planFromCsv(imported(), { Asha: 'm-asha', Ravi: 'm-ravi' }, 0);
    const payload = toMutationPayload(plan, { expenseId: 'e-1' });
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('carries minor units as strings, never numbers', () => {
    const plan = planFromCsv(imported(), { Asha: 'm-asha', Ravi: 'm-ravi' }, 0);
    const payload = toMutationPayload(plan, { expenseId: 'e-1' });

    expect(payload.amount).toBe('45000');
    expect(payload.payers).toEqual({ 'm-asha': '45000' });
    expect(payload.splitParams).toEqual({
      kind: 'exact',
      amounts: { 'm-asha': '30000', 'm-ravi': '15000' },
    });
  });

  it('leaves an equal split alone', () => {
    const plan = planFromSms(candidate(), { payer: 'm', participants: ['m'] });
    expect(toMutationPayload(plan, { expenseId: 'e-1' }).splitParams).toEqual({ kind: 'equal' });
  });
});
