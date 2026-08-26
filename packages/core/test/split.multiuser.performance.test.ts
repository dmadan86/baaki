import { describe, expect, it } from 'vitest';

import { balanceOf, balanceSums, computeNetBalances } from '../src/balances/balances.js';
import type { ExpenseSnapshot } from '../src/balances/types.js';
import { computeShares, sumShares } from '../src/split/computeShares.js';
import type { MemberId, ShareMap, SplitParams } from '../src/split/types.js';

const INR = 'INR';
const SEED = 'multi-user-expense';

/** Builds stable member ids so expected maps stay readable in failure output. */
function members(count: number): MemberId[] {
  return Array.from(
    { length: count },
    (_, index) => `member-${(index + 1).toString().padStart(2, '0')}`,
  );
}

/** Zips member ids to numeric split inputs such as basis points or weights. */
function mapValues(ids: readonly MemberId[], values: readonly number[]): Record<MemberId, number> {
  return Object.fromEntries(ids.map((id, index) => [id, values[index] ?? 0]));
}

/** Converts the core ShareMap into the plain record shape consumed by balances. */
function recordShares(shares: ShareMap): Record<MemberId, bigint> {
  return Object.fromEntries(shares);
}

/** Simulates the user action of one payer adding an expense with server-computed shares. */
function addExpense(input: {
  id: string;
  amount: bigint;
  payer: MemberId;
  participants: readonly MemberId[];
  params: SplitParams;
}): ExpenseSnapshot {
  const shareMap = computeShares({
    amount: input.amount,
    currency: INR,
    params: input.params,
    participants: input.participants,
    seed: `${SEED}:${input.id}`,
  });
  return {
    id: input.id,
    amount: input.amount,
    currency: INR,
    payers: { [input.payer]: input.amount },
    shares: recordShares(shareMap),
    date: '2026-08-26',
  };
}

/** Verifies the ledger stays balanced and every participant's net equals paid minus owed. */
function assertExpenseLedger(expense: ExpenseSnapshot, participants: readonly MemberId[]): void {
  const shareMap = new Map(Object.entries(expense.shares));
  expect(sumShares(shareMap)).toBe(expense.amount);
  expect(Object.keys(expense.shares).sort()).toEqual([...participants].sort());

  const balances = computeNetBalances([expense], []);
  expect(balanceSums(balances).get(INR)).toBe(0n);
  for (const member of participants) {
    const paid = expense.payers[member] ?? 0n;
    const owed = expense.shares[member] ?? 0n;
    expect(balanceOf(balances, member, INR)).toBe(paid - owed);
  }
}

describe('multi-user split scenarios', () => {
  it('adds a paid expense for 4 users across equal, percentage and share splits', () => {
    const participants = members(4);
    const [payer] = participants;
    if (!payer) throw new Error('test needs a payer');

    const scenarios = [
      {
        id: 'equal-4',
        amount: 10_000n,
        params: { kind: 'equal' as const },
        expected: [2_500n, 2_500n, 2_500n, 2_500n],
      },
      {
        id: 'percent-4',
        amount: 10_000n,
        params: {
          kind: 'percent' as const,
          basisPoints: mapValues(participants, [4000, 3000, 2000, 1000]),
        },
        expected: [4_000n, 3_000n, 2_000n, 1_000n],
      },
      {
        id: 'shares-4',
        amount: 10_000n,
        params: { kind: 'shares' as const, weights: mapValues(participants, [4, 3, 2, 1]) },
        expected: [4_000n, 3_000n, 2_000n, 1_000n],
      },
    ];

    for (const scenario of scenarios) {
      const expense = addExpense({
        id: scenario.id,
        amount: scenario.amount,
        payer,
        participants,
        params: scenario.params,
      });
      expect(expense.shares).toEqual(
        Object.fromEntries(
          participants.map((member, index) => [member, scenario.expected[index] ?? 0n]),
        ),
      );
      assertExpenseLedger(expense, participants);
    }
  });

  it('scales the same user action to 50 participants without losing money', () => {
    const participants = members(50);
    const [payer] = participants;
    if (!payer) throw new Error('test needs a payer');

    const equalExpense = addExpense({
      id: 'equal-50',
      amount: 123_456n,
      payer,
      participants,
      params: { kind: 'equal' },
    });
    assertExpenseLedger(equalExpense, participants);
    const equalShares = Object.values(equalExpense.shares);
    expect(max(equalShares) - min(equalShares)).toBeLessThanOrEqual(1n);

    const percentExpense = addExpense({
      id: 'percent-50',
      amount: 50_000n,
      payer,
      participants,
      params: {
        kind: 'percent',
        basisPoints: mapValues(
          participants,
          participants.map(() => 200),
        ),
      },
    });
    assertExpenseLedger(percentExpense, participants);
    expect(new Set(Object.values(percentExpense.shares))).toEqual(new Set([1_000n]));

    const weights = participants.map((_, index) => index + 1);
    const shareExpense = addExpense({
      id: 'shares-50',
      amount: 987_654n,
      payer,
      participants,
      params: { kind: 'shares', weights: mapValues(participants, weights) },
    });
    assertExpenseLedger(shareExpense, participants);
    assertProportionalBounds(shareExpense.shares, shareExpense.amount, participants, weights);
  });
});

describe('split throughput at scale', () => {
  it('replays 3,000 fifty-user splits and never loses money', () => {
    const participants = members(50);
    const amount = 987_654_321n;
    const percent = {
      kind: 'percent' as const,
      basisPoints: mapValues(
        participants,
        participants.map(() => 200),
      ),
    };
    const shares = {
      kind: 'shares' as const,
      weights: mapValues(
        participants,
        participants.map((_, index) => index + 1),
      ),
    };
    const cases: SplitParams[] = [{ kind: 'equal' }, percent, shares];

    // Warm the JIT before timing; the measured loop approximates a heavy group
    // importing or replaying 3,000 expense writes on one device/server worker.
    for (const params of cases) {
      computeShares({ amount, currency: INR, params, participants, seed: `${SEED}:warmup` });
    }

    // A throughput exercise, not a timed benchmark: replay 3,000 fifty-user
    // splits (roughly a heavy group importing or a worker replaying its writes)
    // and assert every one still conserves money. A wall-clock ceiling was
    // deliberately NOT used here — absolute timings are a flaky gate on a shared
    // CI worker, failing spuriously under load with no real regression. The real
    // guard is that all 3,000 operations produce shares that sum to the total.
    const iterations = 1_000;
    let completed = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (const params of cases) {
        const result = computeShares({
          amount,
          currency: INR,
          params,
          participants,
          seed: `${SEED}:bench:${iteration}`,
        });
        expect(sumShares(result)).toBe(amount);
        completed += 1;
      }
    }
    expect(completed).toBe(iterations * cases.length);
  });
});

/** Ensures proportional integer allocation only differs from the exact floor by remainder units. */
function assertProportionalBounds(
  shares: Readonly<Record<MemberId, bigint>>,
  amount: bigint,
  participants: readonly MemberId[],
  weights: readonly number[],
): void {
  const totalWeight = BigInt(weights.reduce((sum, weight) => sum + weight, 0));
  for (const [index, member] of participants.entries()) {
    const floor = (amount * BigInt(weights[index] ?? 0)) / totalWeight;
    const share = shares[member] ?? 0n;
    expect(share).toBeGreaterThanOrEqual(floor);
    expect(share).toBeLessThanOrEqual(floor + 1n);
  }
}

/** Returns the largest bigint in a non-empty list, defaulting to zero for defensive test setup. */
function max(values: readonly bigint[]): bigint {
  return values.reduce((highest, value) => (value > highest ? value : highest), values[0] ?? 0n);
}

/** Returns the smallest bigint in a non-empty list, defaulting to zero for defensive test setup. */
function min(values: readonly bigint[]): bigint {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest), values[0] ?? 0n);
}
