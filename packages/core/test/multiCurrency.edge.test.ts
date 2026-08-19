/**
 * Edge and adversarial cases around the multi-currency ledger — the things a
 * tester reaches for after the happy path: uneven remainders, a payer who is
 * not a participant, malformed splits that must be rejected, and settlement
 * statuses that must not move money. Companion to multiCurrency.scenario.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { balanceOf, balanceSums, computeNetBalances } from '../src/balances/balances.js';
import { SettlementStatus } from '../src/balances/types.js';
import type { ExpenseSnapshot, SettlementSnapshot } from '../src/balances/types.js';
import { computeShares, sumShares } from '../src/split/computeShares.js';
import { SplitError, SplitErrorCode } from '../src/split/types.js';
import type { MemberId, SplitParams } from '../src/split/types.js';

const A = 'asha';
const R = 'ravi';
const M = 'meera';

function expense(input: {
  id: string;
  currency: string;
  amount: bigint;
  payers: Record<MemberId, bigint>;
  params: SplitParams;
  participants: readonly MemberId[];
}): ExpenseSnapshot {
  const shareMap = computeShares({
    amount: input.amount,
    currency: input.currency,
    params: input.params,
    participants: input.participants,
    seed: input.id,
  });
  return {
    id: input.id,
    currency: input.currency,
    amount: input.amount,
    payers: input.payers,
    shares: Object.fromEntries(shareMap),
    date: '2026-08-01',
    deletedAt: null,
  };
}

describe('multi-currency edge cases', () => {
  it('splits an indivisible amount without losing or minting a unit', () => {
    // ₹10.00 (1000 paise) among three: cannot divide evenly.
    const shareMap = computeShares({
      amount: 1_000n,
      currency: 'INR',
      params: { kind: 'equal' },
      participants: [A, R, M],
      seed: 'odd-split',
    });
    const shares = [...shareMap.values()].sort();
    // Two get 333, one gets 334 — the extra paisa is rotated, never dropped.
    expect(shares).toEqual([333n, 333n, 334n]);
    expect(sumShares(shareMap)).toBe(1_000n);
  });

  it('is deterministic: the same expense id yields the same rounding every time', () => {
    const once = computeShares({
      amount: 1_000n,
      currency: 'INR',
      params: { kind: 'equal' },
      participants: [A, R, M],
      seed: 'stable-seed',
    });
    const twice = computeShares({
      amount: 1_000n,
      currency: 'INR',
      params: { kind: 'equal' },
      participants: [A, R, M],
      seed: 'stable-seed',
    });
    expect([...twice.entries()]).toEqual([...once.entries()]);
  });

  it('credits a payer who is not a participant in full', () => {
    // Asha pays the ₹300 cab but only Ravi and Meera rode it.
    const net = computeNetBalances(
      [
        expense({
          id: 'cab',
          currency: 'INR',
          amount: 30_000n,
          payers: { [A]: 30_000n },
          params: { kind: 'equal' },
          participants: [R, M],
        }),
      ],
      [],
    );
    expect(balanceOf(net, A, 'INR')).toBe(30_000n); // paid, owes nothing
    expect(balanceOf(net, R, 'INR')).toBe(-15_000n);
    expect(balanceOf(net, M, 'INR')).toBe(-15_000n);
    expect(balanceSums(net).get('INR')).toBe(0n);
  });

  it('rejects an exact split whose amounts do not sum to the total', () => {
    expect(() =>
      computeShares({
        amount: 10_000n,
        currency: 'USD',
        params: { kind: 'exact', amounts: { [A]: 4_000n, [R]: 4_000n } }, // 8000 ≠ 10000
        participants: [A, R],
        seed: 'bad-exact',
      }),
    ).toThrowError(
      expect.objectContaining({ code: SplitErrorCode.ExactSumMismatch }) as unknown as SplitError,
    );
  });

  it('rejects a percent split whose basis points do not sum to 10000', () => {
    expect(() =>
      computeShares({
        amount: 10_000n,
        currency: 'EUR',
        params: { kind: 'percent', basisPoints: { [A]: 6_000, [R]: 3_000 } }, // 9000 ≠ 10000
        participants: [A, R],
        seed: 'bad-percent',
      }),
    ).toThrowError(
      expect.objectContaining({ code: SplitErrorCode.PercentSumMismatch }) as unknown as SplitError,
    );
  });

  it('ignores disputed and cancelled settlements', () => {
    const expenses = [
      expense({
        id: 'lunch',
        currency: 'INR',
        amount: 20_000n,
        payers: { [A]: 20_000n },
        params: { kind: 'equal' },
        participants: [A, R],
      }),
    ];
    // Ravi owes Asha 10000. Neither a disputed nor a cancelled settlement clears it.
    const settlements: readonly SettlementSnapshot[] = [
      {
        id: 'disputed',
        from: R,
        to: A,
        currency: 'INR',
        amount: 10_000n,
        status: SettlementStatus.Disputed,
        at: '2026-08-05T00:00:00Z',
      },
      {
        id: 'cancelled',
        from: R,
        to: A,
        currency: 'INR',
        amount: 10_000n,
        status: SettlementStatus.Cancelled,
        at: '2026-08-06T00:00:00Z',
      },
    ];
    const net = computeNetBalances(expenses, settlements);
    expect(balanceOf(net, R, 'INR')).toBe(-10_000n); // still owes
    expect(balanceOf(net, A, 'INR')).toBe(10_000n);
  });

  it('holds the zero-sum even when a settlement names a currency with no expenses', () => {
    // A JPY settlement with no JPY expenses: it should not corrupt the invariant.
    const net = computeNetBalances(
      [],
      [
        {
          id: 'orphan',
          from: R,
          to: A,
          currency: 'JPY',
          amount: 500n,
          status: SettlementStatus.Confirmed,
          at: '2026-08-07T00:00:00Z',
        },
      ],
    );
    expect(balanceOf(net, R, 'JPY')).toBe(500n);
    expect(balanceOf(net, A, 'JPY')).toBe(-500n);
    expect(balanceSums(net).get('JPY')).toBe(0n);
  });
});
