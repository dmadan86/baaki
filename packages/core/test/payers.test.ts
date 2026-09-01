/**
 * The payer side of a split: several people putting money into one bill.
 *
 * Three layers here, because the failure modes are different at each:
 *
 *   1. Properties — the invariants that must hold for every input, checked with
 *      fast-check. Σ payers = amount is the one the SQL trigger and both edge
 *      functions enforce, so a client that can violate it is a client that ships
 *      PAYER_MISMATCH errors to real people.
 *   2. Behaviour — what the form actually does when somebody types, retypes,
 *      adds a payer, removes one, or changes the total afterwards. These are the
 *      gestures that break naive implementations.
 *   3. Scenarios — whole expenses run end to end through computeShares and
 *      computeNetBalances, so "Asha got the taxi, I got the tickets" comes out
 *      of the ledger as the right net position and not merely as a row that
 *      happens to add up.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  computeShares,
  payerTotal,
  PayerProblemCode,
  rebalancePayers,
  serialisePayers,
  splitPaidEqually,
  validatePayers,
  type MemberId,
  type PayerMap,
} from '../src/split/index.js';
import { computeNetBalances, balanceOf, balanceSums } from '../src/balances/balances.js';
import type { ExpenseSnapshot } from '../src/balances/types.js';
import { amounts, memberIds, positiveAmounts, seeds } from './arbitraries.js';

const map = (entries: Record<string, bigint>): PayerMap => new Map(Object.entries(entries));
const lock = (...ids: string[]): ReadonlySet<MemberId> => new Set(ids);

// ─────────────────────────────────────────────────────────── properties ──

describe('splitPaidEqually', () => {
  it('always adds up to the bill, whoever pays it', () => {
    fc.assert(
      fc.property(amounts(), memberIds(1, 8), seeds(), (amount, ids, seed) => {
        const paid = splitPaidEqually(amount, ids, seed);
        expect(payerTotal(paid)).toBe(amount);
        expect(paid.size).toBe(ids.length);
      }),
    );
  });

  it('never spreads two payers more than one minor unit apart', () => {
    fc.assert(
      fc.property(amounts(), memberIds(1, 8), seeds(), (amount, ids, seed) => {
        const values = [...splitPaidEqually(amount, ids, seed).values()];
        const high = values.reduce((a, b) => (a > b ? a : b));
        const low = values.reduce((a, b) => (a < b ? a : b));
        expect(high - low <= 1n).toBe(true);
      }),
    );
  });

  it('is deterministic — two devices computing the same bill agree', () => {
    fc.assert(
      fc.property(amounts(), memberIds(1, 8), seeds(), (amount, ids, seed) => {
        const first = splitPaidEqually(amount, ids, seed);
        // Same members, opposite order: the stable-order rule must erase it.
        const second = splitPaidEqually(amount, [...ids].reverse(), seed);
        expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
      }),
    );
  });

  it('gives an empty map rather than throwing when nobody is selected', () => {
    expect(splitPaidEqually(1000n, [], 'seed').size).toBe(0);
  });

  it('hands the whole bill to a lone payer', () => {
    fc.assert(
      fc.property(amounts(), seeds(), (amount, seed) => {
        expect(splitPaidEqually(amount, ['solo'], seed).get('solo')).toBe(amount);
      }),
    );
  });
});

describe('validatePayers', () => {
  it('accepts exactly the payer sets the server accepts', () => {
    fc.assert(
      fc.property(
        amounts(),
        memberIds(1, 6),
        fc.array(fc.bigInt({ min: -5000n, max: 5000n }), { minLength: 1, maxLength: 6 }),
        (amount, ids, raw) => {
          const payers = new Map<MemberId, bigint>();
          ids.forEach((id, index) => payers.set(id, raw[index % raw.length] ?? 0n));

          const problem = validatePayers(amount, payers);
          // The server's rule, written out independently of the implementation.
          const serverWouldAccept =
            payers.size > 0 &&
            [...payers.values()].every((value) => value >= 0n) &&
            payerTotal(payers) === amount;
          expect(problem === null).toBe(serverWouldAccept);
        },
      ),
    );
  });

  it('reports the shortfall as a signed delta the UI can print', () => {
    expect(validatePayers(10_000n, map({ a: 6000n }))).toEqual({
      code: PayerProblemCode.Short,
      delta: 4000n,
    });
    expect(validatePayers(10_000n, map({ a: 6000n, b: 6000n }))).toEqual({
      code: PayerProblemCode.Over,
      delta: -2000n,
    });
  });

  it('refuses an empty payer list', () => {
    expect(validatePayers(10_000n, new Map())).toEqual({
      code: PayerProblemCode.NoPayers,
      delta: 10_000n,
    });
  });

  it('names a negative payer, and names the same one every time', () => {
    const problem = validatePayers(0n, map({ zeta: -100n, alpha: -100n, m: 200n }));
    expect(problem?.code).toBe(PayerProblemCode.Negative);
    expect(problem?.member).toBe('alpha');
    // Σ is 0 here, so "adds up" is not enough on its own — the sign check has to
    // come first or a bill can balance out of two impossible halves.
    expect(payerTotal(map({ zeta: -100n, alpha: -100n, m: 200n }))).toBe(0n);
  });

  it('accepts a zero-total bill with a zero payer (Σ0 = 0)', () => {
    expect(validatePayers(0n, map({ a: 0n }))).toBeNull();
  });
});

describe('rebalancePayers', () => {
  it('always lands on the exact total when somebody is free to absorb it', () => {
    fc.assert(
      fc.property(
        positiveAmounts(),
        memberIds(1, 6),
        fc.nat({ max: 5 }),
        seeds(),
        (amount, ids, lockCount, seed) => {
          // Lock a prefix and give the locked members figures that cannot alone
          // exceed the bill, so at least one unlocked payer remains free.
          const lockedIds = ids.slice(0, Math.min(lockCount, ids.length - 1));
          const current = new Map<MemberId, bigint>(
            lockedIds.map((id) => [id, amount / BigInt(ids.length + 1)]),
          );
          const next = rebalancePayers({
            amount,
            selected: ids,
            current,
            locked: new Set(lockedIds),
            seed,
          });
          expect(payerTotal(next)).toBe(amount);
          expect(validatePayers(amount, next)).toBeNull();
        },
      ),
    );
  });

  it('never drives anybody negative, whatever the locked figures are', () => {
    fc.assert(
      fc.property(
        amounts(),
        memberIds(2, 6),
        fc.bigInt({ min: 0n, max: 50_000_000n }),
        seeds(),
        (amount, ids, lockedValue, seed) => {
          const [first, ...rest] = ids as [MemberId, ...MemberId[]];
          const next = rebalancePayers({
            amount,
            selected: ids,
            current: map({ [first]: lockedValue }),
            locked: lock(first),
            seed,
          });
          for (const paid of next.values()) expect(paid >= 0n).toBe(true);
          // The locked figure survives verbatim even when it breaks the total —
          // it is a fact somebody typed, not a variable to solve for.
          expect(next.get(first)).toBe(lockedValue);
          if (lockedValue > amount) {
            for (const id of rest) expect(next.get(id)).toBe(0n);
            expect(validatePayers(amount, next)?.code).toBe(PayerProblemCode.Over);
          }
        },
      ),
    );
  });

  it('only ever returns the selected payers', () => {
    fc.assert(
      fc.property(amounts(), memberIds(1, 5), memberIds(1, 5), seeds(), (amount, keep, drop, s) => {
        const stale = new Map<MemberId, bigint>([...keep, ...drop].map((id) => [id, 100n]));
        const next = rebalancePayers({
          amount,
          selected: keep,
          current: stale,
          locked: new Set(),
          seed: s,
        });
        for (const id of next.keys()) expect(keep).toContain(id);
        for (const id of drop) if (!keep.includes(id)) expect(next.has(id)).toBe(false);
      }),
    );
  });

  it('is idempotent — rebalancing an already-balanced set changes nothing', () => {
    fc.assert(
      fc.property(positiveAmounts(), memberIds(1, 6), seeds(), (amount, ids, seed) => {
        const once = rebalancePayers({
          amount,
          selected: ids,
          current: new Map(),
          locked: new Set(),
          seed,
        });
        const twice = rebalancePayers({
          amount,
          selected: ids,
          current: once,
          locked: new Set(),
          seed,
        });
        expect([...twice.entries()]).toEqual([...once.entries()]);
      }),
    );
  });
});

// ───────────────────────────────────────────────────────────── gestures ──

describe('the gestures a person actually makes', () => {
  const seed = 'exp-1';

  it('one payer carries the whole bill', () => {
    const next = rebalancePayers({
      amount: 100_000n,
      selected: ['asha'],
      current: new Map(),
      locked: new Set(),
      seed,
    });
    expect(next.get('asha')).toBe(100_000n);
  });

  it('adding a second payer splits the paying in half', () => {
    const next = rebalancePayers({
      amount: 100_000n,
      selected: ['asha', 'ravi'],
      current: map({ asha: 100_000n }),
      locked: new Set(),
      seed,
    });
    expect(next.get('asha')).toBe(50_000n);
    expect(next.get('ravi')).toBe(50_000n);
  });

  it('typing one figure moves the other, not the total', () => {
    const next = rebalancePayers({
      amount: 100_000n,
      selected: ['asha', 'ravi'],
      current: map({ asha: 60_000n, ravi: 50_000n }),
      locked: lock('asha'),
      seed,
    });
    expect(next.get('asha')).toBe(60_000n);
    expect(next.get('ravi')).toBe(40_000n);
    expect(payerTotal(next)).toBe(100_000n);
  });

  it('two typed figures leave the third to make up the difference', () => {
    const next = rebalancePayers({
      amount: 100_000n,
      selected: ['asha', 'ravi', 'mo'],
      current: map({ asha: 60_000n, ravi: 25_000n }),
      locked: lock('asha', 'ravi'),
      seed,
    });
    expect(next.get('mo')).toBe(15_000n);
  });

  it('raising the total after the fact goes to whoever was not typed in', () => {
    const next = rebalancePayers({
      amount: 120_000n,
      selected: ['asha', 'ravi'],
      current: map({ asha: 60_000n, ravi: 40_000n }),
      locked: lock('asha'),
      seed,
    });
    expect(next.get('asha')).toBe(60_000n);
    expect(next.get('ravi')).toBe(60_000n);
  });

  it('typed figures that overshoot the bill are kept and reported, not trimmed', () => {
    const next = rebalancePayers({
      amount: 100_000n,
      selected: ['asha', 'ravi'],
      current: map({ asha: 90_000n, ravi: 40_000n }),
      locked: lock('asha', 'ravi'),
      seed,
    });
    expect(next.get('asha')).toBe(90_000n);
    expect(next.get('ravi')).toBe(40_000n);
    expect(validatePayers(100_000n, next)).toEqual({
      code: PayerProblemCode.Over,
      delta: -30_000n,
    });
  });

  it('dropping a payer hands their money back to the others', () => {
    const next = rebalancePayers({
      amount: 90_000n,
      selected: ['asha', 'ravi'],
      current: map({ asha: 30_000n, ravi: 30_000n, mo: 30_000n }),
      locked: new Set(),
      seed,
    });
    expect(next.has('mo')).toBe(false);
    expect(next.get('asha')).toBe(45_000n);
    expect(next.get('ravi')).toBe(45_000n);
  });

  it('dropping every payer but one leaves that one holding the bill', () => {
    const next = rebalancePayers({
      amount: 90_000n,
      selected: ['asha'],
      current: map({ asha: 30_000n, ravi: 60_000n }),
      locked: new Set(),
      seed,
    });
    expect([...next.entries()]).toEqual([['asha', 90_000n]]);
  });

  it('splits an odd amount without losing or inventing a paisa', () => {
    const next = rebalancePayers({
      amount: 100_001n,
      selected: ['a', 'b', 'c'],
      current: new Map(),
      locked: new Set(),
      seed,
    });
    expect(payerTotal(next)).toBe(100_001n);
    expect([...next.values()].filter((v) => v === 33_334n)).toHaveLength(2);
    expect([...next.values()].filter((v) => v === 33_333n)).toHaveLength(1);
  });

  it('works in a currency with no minor unit (JPY: nothing to round to)', () => {
    const next = rebalancePayers({
      amount: 10_000n,
      selected: ['a', 'b', 'c'],
      current: new Map(),
      locked: new Set(),
      seed,
    });
    expect(payerTotal(next)).toBe(10_000n);
    expect([...next.values()].sort()).toEqual([3333n, 3333n, 3334n]);
  });
});

describe('serialisePayers', () => {
  it('drops the people who put nothing in', () => {
    expect(serialisePayers(map({ asha: 60_000n, ravi: 0n }))).toEqual({ asha: '60000' });
  });

  it('emits decimal strings, because JSON has no bigint', () => {
    const wire = serialisePayers(map({ asha: 9_007_199_254_740_993n }));
    expect(wire.asha).toBe('9007199254740993');
  });

  it('round-trips back to the same total the server will check', () => {
    fc.assert(
      fc.property(amounts(), memberIds(1, 6), seeds(), (amount, ids, seed) => {
        const paid = splitPaidEqually(amount, ids, seed);
        const wire = serialisePayers(paid);
        const back = new Map(Object.entries(wire).map(([id, v]) => [id, BigInt(v)]));
        expect(payerTotal(back)).toBe(amount);
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────── scenarios ──

/** Build the snapshot the balance engine reads, the way a real write would. */
function expenseOf(
  id: string,
  amount: bigint,
  payers: Record<MemberId, bigint>,
  participants: readonly MemberId[],
): ExpenseSnapshot {
  const shares = computeShares({
    amount,
    currency: 'INR',
    params: { kind: 'equal' },
    participants,
    seed: id,
  });
  return {
    id,
    currency: 'INR',
    amount,
    payers,
    shares: Object.fromEntries(shares),
    date: '2026-09-01',
  };
}

describe('a multi-payer bill, end to end through the ledger', () => {
  it('"she got the taxi, I got the tickets" nets out correctly', () => {
    // ₹1000 dinner, split four ways (₹250 each). Asha put in ₹600, Ravi ₹400.
    const expense = expenseOf('exp-dinner', 100_000n, { asha: 60_000n, ravi: 40_000n }, [
      'asha',
      'ravi',
      'mo',
      'sam',
    ]);
    expect(validatePayers(expense.amount, map(expense.payers))).toBeNull();

    const balances = computeNetBalances([expense], []);
    expect(balanceOf(balances, 'asha', 'INR')).toBe(35_000n); // paid 600, owes 250
    expect(balanceOf(balances, 'ravi', 'INR')).toBe(15_000n); // paid 400, owes 250
    expect(balanceOf(balances, 'mo', 'INR')).toBe(-25_000n);
    expect(balanceOf(balances, 'sam', 'INR')).toBe(-25_000n);
    expect(balanceSums(balances).get('INR')).toBe(0n);
  });

  it('a payer who owes nothing is a creditor, not a participant', () => {
    // Dad pays half the bill but is not on the split at all.
    const expense = expenseOf('exp-gift', 60_000n, { dad: 30_000n, asha: 30_000n }, [
      'asha',
      'ravi',
    ]);
    const balances = computeNetBalances([expense], []);
    expect(balanceOf(balances, 'dad', 'INR')).toBe(30_000n);
    expect(balanceOf(balances, 'asha', 'INR')).toBe(0n); // paid 300, owes 300
    expect(balanceOf(balances, 'ravi', 'INR')).toBe(-30_000n);
    expect(balanceSums(balances).get('INR')).toBe(0n);
  });

  it('two payers on an odd total still leave the group summing to zero', () => {
    fc.assert(
      fc.property(positiveAmounts(1_000_000n), memberIds(2, 6), seeds(), (amount, ids, seed) => {
        const payerIds = ids.slice(0, 2);
        const payers = Object.fromEntries(splitPaidEqually(amount, payerIds, seed));
        const expense = expenseOf(seed, amount, payers, ids);
        expect(balanceSums(computeNetBalances([expense], [])).get('INR')).toBe(0n);
      }),
    );
  });

  it('splitting one bill between two payers is not the same as two bills', () => {
    // The fact this feature exists to record: one ₹1000 dinner paid by two
    // people, split four ways, is not two ₹500 dinners split four ways — the
    // nets happen to match here, but the ledger holds one row, one date, one
    // description, and one thing to edit or delete later.
    const one = expenseOf('exp-one', 100_000n, { asha: 60_000n, ravi: 40_000n }, [
      'asha',
      'ravi',
      'mo',
      'sam',
    ]);
    const split = [
      expenseOf('exp-a', 60_000n, { asha: 60_000n }, ['asha', 'ravi', 'mo', 'sam']),
      expenseOf('exp-b', 40_000n, { ravi: 40_000n }, ['asha', 'ravi', 'mo', 'sam']),
    ];
    const oneBalances = computeNetBalances([one], []);
    const twoBalances = computeNetBalances(split, []);
    for (const member of ['asha', 'ravi', 'mo', 'sam']) {
      expect(balanceOf(oneBalances, member, 'INR')).toBe(balanceOf(twoBalances, member, 'INR'));
    }

    // Same nets, different ledger. Deleting "the dinner" is one act on the
    // multi-payer row and clears the whole thing; on the two-expense workaround
    // it deletes half a dinner and leaves the other half standing — which is
    // exactly the bug people hit when they enter it as two rows.
    const oneDeleted = computeNetBalances([{ ...one, deletedAt: '2026-09-02' }], []);
    // Nothing left to net at all — a deleted expense contributes no rows, so the
    // currency never even appears in the balance map.
    expect(balanceSums(oneDeleted).get('INR')).toBeUndefined();
    for (const member of ['asha', 'ravi', 'mo', 'sam']) {
      expect(balanceOf(oneDeleted, member, 'INR')).toBe(0n);
    }

    const halfDeleted = computeNetBalances(
      [{ ...(split[0] as ExpenseSnapshot), deletedAt: '2026-09-02' }, split[1] as ExpenseSnapshot],
      [],
    );
    expect(balanceOf(halfDeleted, 'ravi', 'INR')).toBe(30_000n);
    expect(balanceOf(halfDeleted, 'asha', 'INR')).toBe(-10_000n);
  });

  it('editing a multi-payer bill down to one payer moves the money, not the total', () => {
    const before = expenseOf('exp-1', 100_000n, { asha: 60_000n, ravi: 40_000n }, ['asha', 'ravi']);
    // The edit: Ravi actually paid the whole thing.
    const after = { ...before, payers: { ravi: 100_000n } };
    expect(validatePayers(after.amount, map(after.payers))).toBeNull();

    const balances = computeNetBalances([after], []);
    expect(balanceOf(balances, 'asha', 'INR')).toBe(-50_000n);
    expect(balanceOf(balances, 'ravi', 'INR')).toBe(50_000n);
    expect(balanceSums(balances).get('INR')).toBe(0n);
  });

  it('a bill paid by everyone who is on it leaves nobody owing anybody', () => {
    fc.assert(
      fc.property(positiveAmounts(1_000_000n), memberIds(2, 6), (amount, ids) => {
        // Everyone pays their own equal share: the split and the paying are the
        // same map, so every net position is exactly zero.
        const shares = computeShares({
          amount,
          currency: 'INR',
          params: { kind: 'equal' },
          participants: ids,
          seed: 'exp-even',
        });
        const expense: ExpenseSnapshot = {
          id: 'exp-even',
          currency: 'INR',
          amount,
          payers: Object.fromEntries(shares),
          shares: Object.fromEntries(shares),
          date: '2026-09-01',
        };
        expect(validatePayers(amount, map(expense.payers))).toBeNull();
        const balances = computeNetBalances([expense], []);
        for (const id of ids) expect(balanceOf(balances, id, 'INR')).toBe(0n);
      }),
    );
  });
});
