/**
 * Exhaustive split combinations for the three split types a user picks by hand:
 * **percentage**, **fixed value** (`exact`) and **share** (`shares`).
 *
 * The property suite in `split.property.test.ts` proves the invariants hold for
 * randomly drawn inputs. This one is the opposite approach: a defined space,
 * walked completely, so the same numbers are checked on every run rather than
 * whichever ones fast-check happened to draw. The space is described in
 * `docs/split-scenarios.md`, and it is:
 *
 *   participants  2, 3, 4, 5
 *   amounts       0, 1, 7, 100, 333, 999, 1000, 100000, 123457 paise
 *   weights       every composition of 10 units across the participants
 *                 (11, 66, 286 and 1001 vectors for 2–5 people)
 *
 * That is 1364 weight vectors × 9 amounts × 2 weighted types, plus the fixed
 * value cases derived from each result — roughly 25k computations, all of them
 * checked against the same five rules.
 *
 * Every one of these runs on the server for real: the edge functions recompute
 * shares from `split_params` with this exact function and reject a client whose
 * numbers differ (TDR §4).
 */

import { describe, expect, it } from 'vitest';

import { computeShares, sumShares } from '../src/split/computeShares.js';
import { verifyClientShares } from '../src/split/verify.js';
import { SplitError, SplitErrorCode, type MemberId, type ShareMap } from '../src/split/types.js';

/**
 * Assert on the machine-readable code rather than the prose. The message is for
 * a person and may be reworded; the code is what the client branches on.
 */
function expectSplitError(run: () => unknown, code: SplitErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SplitError);
    expect((error as SplitError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a ${code} error, but the split succeeded`);
}

const INR = 'INR';
const SEED = 'expense-0001';

const PARTICIPANT_COUNTS = [2, 3, 4, 5] as const;

/** Chosen to cover every remainder class for 2–5 people, plus the edges. */
const AMOUNTS = [0n, 1n, 7n, 100n, 333n, 999n, 1000n, 100_000n, 123_457n];

/** Ten units to share out — the lattice the weight vectors are drawn from. */
const WEIGHT_UNITS = 10;

function members(count: number): MemberId[] {
  return Array.from({ length: count }, (_, index) => `m${index + 1}`);
}

/** Every way to split `total` into `parts` non-negative integers. */
function compositions(total: number, parts: number): number[][] {
  if (parts === 1) return [[total]];
  const result: number[][] = [];
  for (let head = 0; head <= total; head += 1) {
    for (const tail of compositions(total - head, parts - 1)) {
      result.push([head, ...tail]);
    }
  }
  return result;
}

function vector(ids: readonly MemberId[], weights: readonly number[]): Record<MemberId, number> {
  return Object.fromEntries(ids.map((id, index) => [id, weights[index] ?? 0]));
}

/**
 * The five rules every split must satisfy, whatever the type.
 *
 * The proportionality bound is the interesting one: each member gets the floor
 * of their exact share, and at most one extra minor unit from the remainder
 * pass. Anything outside that window means the money moved somewhere it should
 * not have.
 */
function assertWellFormed(
  shares: ShareMap,
  amount: bigint,
  ids: readonly MemberId[],
  weights?: readonly number[],
): void {
  expect(sumShares(shares)).toBe(amount);
  expect([...shares.keys()].sort()).toEqual([...ids].sort());

  for (const share of shares.values()) {
    if (amount >= 0n) expect(share).toBeGreaterThanOrEqual(0n);
    expect(share).toBeLessThanOrEqual(amount > 0n ? amount : 0n);
  }

  if (weights) {
    const totalWeight = BigInt(weights.reduce((sum, weight) => sum + weight, 0));
    if (totalWeight > 0n) {
      ids.forEach((id, index) => {
        const exactFloor = (amount * BigInt(weights[index] ?? 0)) / totalWeight;
        const share = shares.get(id) ?? 0n;
        expect(share).toBeGreaterThanOrEqual(exactFloor);
        expect(share).toBeLessThanOrEqual(exactFloor + 1n);
      });
      // Nobody with a zero weight pays anything.
      ids.forEach((id, index) => {
        if ((weights[index] ?? 0) === 0) expect(shares.get(id)).toBe(0n);
      });
    }
  }
}

describe('percentage splits — every composition of 100%', () => {
  for (const count of PARTICIPANT_COUNTS) {
    const ids = members(count);
    // Ten units of 1000 basis points each: exhaustive over whole percentages
    // that are multiples of 10%, which is the lattice the doc describes.
    const vectors = compositions(WEIGHT_UNITS, count);

    it(`holds for all ${vectors.length} vectors × ${AMOUNTS.length} amounts with ${count} people`, () => {
      for (const weights of vectors) {
        const basisPoints = vector(
          ids,
          weights.map((weight) => weight * 1000),
        );
        for (const amount of AMOUNTS) {
          const shares = computeShares({
            amount,
            currency: INR,
            params: { kind: 'percent', basisPoints },
            participants: ids,
            seed: SEED,
          });
          assertWellFormed(shares, amount, ids, weights);
        }
      }
    });
  }

  it('is deterministic and independent of the order participants are listed in', () => {
    const ids = members(4);
    for (const weights of compositions(WEIGHT_UNITS, 4)) {
      const basisPoints = vector(
        ids,
        weights.map((w) => w * 1000),
      );
      const forwards = computeShares({
        amount: 123_457n,
        currency: INR,
        params: { kind: 'percent', basisPoints },
        participants: ids,
        seed: SEED,
      });
      const backwards = computeShares({
        amount: 123_457n,
        currency: INR,
        params: { kind: 'percent', basisPoints },
        participants: [...ids].reverse(),
        seed: SEED,
      });
      expect([...backwards].sort()).toEqual([...forwards].sort());
    }
  });

  it('rejects percentages that do not add up to exactly 100%', () => {
    const ids = members(3);
    for (const total of [0, 1, 9999, 10001, 20000]) {
      const basisPoints = { m1: total, m2: 0, m3: 0 };
      expectSplitError(
        () =>
          computeShares({
            amount: 1000n,
            currency: INR,
            params: { kind: 'percent', basisPoints },
            participants: ids,
            seed: SEED,
          }),
        SplitErrorCode.PercentSumMismatch,
      );
    }
  });

  it('rejects negative and fractional basis points', () => {
    const ids = members(2);
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectSplitError(
        () =>
          computeShares({
            amount: 1000n,
            currency: INR,
            params: { kind: 'percent', basisPoints: { m1: bad, m2: 10000 } },
            participants: ids,
            seed: SEED,
          }),
        SplitErrorCode.InvalidWeight,
      );
    }
  });
});

describe('share splits — every composition of ten shares', () => {
  for (const count of PARTICIPANT_COUNTS) {
    const ids = members(count);
    const vectors = compositions(WEIGHT_UNITS, count).filter((weights) =>
      weights.some((weight) => weight > 0),
    );

    it(`holds for all ${vectors.length} vectors × ${AMOUNTS.length} amounts with ${count} people`, () => {
      for (const weights of vectors) {
        for (const amount of AMOUNTS) {
          const shares = computeShares({
            amount,
            currency: INR,
            params: { kind: 'shares', weights: vector(ids, weights) },
            participants: ids,
            seed: SEED,
          });
          assertWellFormed(shares, amount, ids, weights);
        }
      }
    });
  }

  it('matches the equivalent percentage split whenever the ratio is the same', () => {
    const ids = members(4);
    for (const weights of compositions(WEIGHT_UNITS, 4)) {
      if (!weights.some((weight) => weight > 0)) continue;
      const bySh = computeShares({
        amount: 123_457n,
        currency: INR,
        params: { kind: 'shares', weights: vector(ids, weights) },
        participants: ids,
        seed: SEED,
      });
      const byPct = computeShares({
        amount: 123_457n,
        currency: INR,
        params: {
          kind: 'percent',
          basisPoints: vector(
            ids,
            weights.map((w) => w * 1000),
          ),
        },
        participants: ids,
        seed: SEED,
      });
      // 3:1 and 75%:25% are the same instruction, so they must be the same
      // money — including which person absorbs the leftover paisa.
      expect([...bySh].sort()).toEqual([...byPct].sort());
    }
  });

  it('treats a uniform share split as an equal split', () => {
    for (const count of PARTICIPANT_COUNTS) {
      const ids = members(count);
      for (const amount of AMOUNTS) {
        const byShares = computeShares({
          amount,
          currency: INR,
          params: {
            kind: 'shares',
            weights: vector(
              ids,
              ids.map(() => 1),
            ),
          },
          participants: ids,
          seed: SEED,
        });
        const byEqual = computeShares({
          amount,
          currency: INR,
          params: { kind: 'equal' },
          participants: ids,
          seed: SEED,
        });
        expect([...byShares].sort()).toEqual([...byEqual].sort());
      }
    }
  });

  it('refuses a split where nobody has a positive share', () => {
    const ids = members(3);
    expectSplitError(
      () =>
        computeShares({
          amount: 1000n,
          currency: INR,
          params: { kind: 'shares', weights: { m1: 0, m2: 0, m3: 0 } },
          participants: ids,
          seed: SEED,
        }),
      SplitErrorCode.NoPositiveWeight,
    );
  });

  it('rejects negative and fractional weights', () => {
    const ids = members(2);
    for (const bad of [-1, 1.5, Number.NaN]) {
      expectSplitError(
        () =>
          computeShares({
            amount: 1000n,
            currency: INR,
            params: { kind: 'shares', weights: { m1: bad, m2: 1 } },
            participants: ids,
            seed: SEED,
          }),
        SplitErrorCode.InvalidWeight,
      );
    }
  });
});

describe('fixed value splits — exact amounts per person', () => {
  it('accepts any set of amounts that adds up, across every combination tested above', () => {
    // Every percentage and share result is, by definition, a valid fixed-value
    // split of the same expense. Feeding each one back in proves the two ways
    // of describing the same money agree.
    for (const count of PARTICIPANT_COUNTS) {
      const ids = members(count);
      for (const weights of compositions(WEIGHT_UNITS, count)) {
        if (!weights.some((weight) => weight > 0)) continue;
        for (const amount of AMOUNTS) {
          const weighted = computeShares({
            amount,
            currency: INR,
            params: { kind: 'shares', weights: vector(ids, weights) },
            participants: ids,
            seed: SEED,
          });
          const asExact = computeShares({
            amount,
            currency: INR,
            params: { kind: 'exact', amounts: Object.fromEntries(weighted) },
            participants: ids,
            seed: SEED,
          });
          expect([...asExact].sort()).toEqual([...weighted].sort());
        }
      }
    }
  });

  it('rejects amounts that are a single paisa out, in either direction', () => {
    const ids = members(3);
    for (const drift of [-1n, 1n]) {
      expectSplitError(
        () =>
          computeShares({
            amount: 1000n,
            currency: INR,
            params: { kind: 'exact', amounts: { m1: 400n, m2: 300n, m3: 300n + drift } },
            participants: ids,
            seed: SEED,
          }),
        SplitErrorCode.ExactSumMismatch,
      );
    }
  });

  it('lets one person carry the whole expense, and lets others carry nothing', () => {
    const ids = members(3);
    const shares = computeShares({
      amount: 1000n,
      currency: INR,
      params: { kind: 'exact', amounts: { m1: 1000n } },
      participants: ids,
      seed: SEED,
    });
    // Members with no entry still appear, at zero, so the UI and the
    // expense_shares table agree on the row set.
    expect(shares.get('m1')).toBe(1000n);
    expect(shares.get('m2')).toBe(0n);
    expect(shares.get('m3')).toBe(0n);
  });

  it('allows a negative share only as part of a set that still sums correctly', () => {
    // Someone was credited back — the total is still the total.
    const shares = computeShares({
      amount: 1000n,
      currency: INR,
      params: { kind: 'exact', amounts: { m1: 1200n, m2: -200n } },
      participants: members(2),
      seed: SEED,
    });
    expect(sumShares(shares)).toBe(1000n);
  });
});

describe('rules that apply to every split type', () => {
  const each = [
    { name: 'percent', params: { kind: 'percent' as const, basisPoints: { m1: 5000, m2: 5000 } } },
    { name: 'shares', params: { kind: 'shares' as const, weights: { m1: 1, m2: 1 } } },
    { name: 'exact', params: { kind: 'exact' as const, amounts: { m1: 500n, m2: 500n } } },
  ];

  for (const { name, params } of each) {
    it(`${name}: refuses an expense with no participants`, () => {
      expectSplitError(
        () => computeShares({ amount: 1000n, currency: INR, params, participants: [], seed: SEED }),
        SplitErrorCode.EmptyParticipants,
      );
    });

    it(`${name}: refuses a duplicated participant`, () => {
      expectSplitError(
        () =>
          computeShares({
            amount: 1000n,
            currency: INR,
            params,
            participants: ['m1', 'm2', 'm1'],
            seed: SEED,
          }),
        SplitErrorCode.DuplicateParticipant,
      );
    });

    it(`${name}: refuses a negative expense total`, () => {
      expectSplitError(
        () =>
          computeShares({
            amount: -1000n,
            currency: INR,
            params,
            participants: ['m1', 'm2'],
            seed: SEED,
          }),
        SplitErrorCode.NegativeTotal,
      );
    });
  }

  it('refuses to give a share to somebody who is not in the split', () => {
    const outsider = [
      { kind: 'percent' as const, basisPoints: { m1: 5000, m2: 4000, mallory: 1000 } },
      { kind: 'shares' as const, weights: { m1: 1, m2: 1, mallory: 1 } },
      { kind: 'exact' as const, amounts: { m1: 500n, m2: 400n, mallory: 100n } },
    ];
    for (const params of outsider) {
      expectSplitError(
        () =>
          computeShares({
            amount: 1000n,
            currency: INR,
            params,
            participants: ['m1', 'm2'],
            seed: SEED,
          }),
        SplitErrorCode.UnknownMember,
      );
    }
  });

  it('gives the same answer every time it is asked', () => {
    const ids = members(5);
    for (const weights of compositions(WEIGHT_UNITS, 5).slice(0, 200)) {
      if (!weights.some((weight) => weight > 0)) continue;
      const once = computeShares({
        amount: 123_457n,
        currency: INR,
        params: { kind: 'shares', weights: vector(ids, weights) },
        participants: ids,
        seed: SEED,
      });
      const twice = computeShares({
        amount: 123_457n,
        currency: INR,
        params: { kind: 'shares', weights: vector(ids, weights) },
        participants: ids,
        seed: SEED,
      });
      expect([...twice]).toEqual([...once]);
    }
  });

  it('moves the leftover paisa around as the expense changes, not always onto one person', () => {
    // ADR-009: the remainder rotates by a hash of the expense id, so the same
    // person is not quietly overcharged on every bill.
    const ids = members(3);
    const absorbers = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      const shares = computeShares({
        amount: 1000n, // 1000 / 3 = 333 remainder 1
        currency: INR,
        params: { kind: 'equal' },
        participants: ids,
        seed: `expense-${index}`,
      });
      for (const [member, share] of shares) if (share === 334n) absorbers.add(member);
    }
    expect(absorbers.size).toBe(3);
  });
});

describe('the server is the one that decides (TDR §4)', () => {
  const ids = members(3);
  const params = { kind: 'percent' as const, basisPoints: { m1: 5000, m2: 3000, m3: 2000 } };
  const authoritative = computeShares({
    amount: 1000n,
    currency: INR,
    params,
    participants: ids,
    seed: SEED,
  });

  it('accepts a client that agrees exactly', () => {
    const claimed = Object.fromEntries([...authoritative].map(([id, s]) => [id, s.toString()]));
    expect(() => verifyClientShares(authoritative, claimed)).not.toThrow();
  });

  it('accepts a client that claims nothing at all', () => {
    // An offline client that has not recomputed simply takes the server's word.
    expect(() => verifyClientShares(authoritative, undefined)).not.toThrow();
  });

  it('rejects a client that is one paisa out', () => {
    const claimed = Object.fromEntries([...authoritative].map(([id, s]) => [id, s.toString()]));
    claimed.m1 = (BigInt(claimed.m1 ?? '0') + 1n).toString();
    expectSplitError(() => verifyClientShares(authoritative, claimed), SplitErrorCode.ShareMismatch);
  });

  it('rejects a client that omits somebody', () => {
    const claimed = Object.fromEntries([...authoritative].map(([id, s]) => [id, s.toString()]));
    delete claimed.m3;
    expectSplitError(() => verifyClientShares(authoritative, claimed), SplitErrorCode.ShareMismatch);
  });

  it('rejects a client that invents somebody', () => {
    // Every share the server computed matches; the client has simply added a
    // person of its own. A per-member loop over the server's map alone would
    // wave this through.
    const claimed = Object.fromEntries([...authoritative].map(([id, s]) => [id, s.toString()]));
    claimed.mallory = '0';
    expectSplitError(() => verifyClientShares(authoritative, claimed), SplitErrorCode.ShareMismatch);
  });

  it('rejects a client that sends something that is not a number', () => {
    const claimed = Object.fromEntries([...authoritative].map(([id, s]) => [id, s.toString()]));
    claimed.m1 = 'five hundred';
    expectSplitError(() => verifyClientShares(authoritative, claimed), SplitErrorCode.ShareMismatch);
  });

  it('cannot be told what a share should be — it is a function of the inputs only', () => {
    // There is no channel for a caller to supply a share: the only inputs are
    // the total, the parameters, the participants and the seed. This is what
    // makes "the calculation happens in the backend" structural rather than a
    // matter of discipline.
    const smuggled = {
      kind: 'percent' as const,
      basisPoints: { m1: 5000, m2: 3000, m3: 2000 },
      // A client adding fields to split_params changes nothing.
      shares: { m1: 999999n },
    } as unknown as typeof params;

    const recomputed = computeShares({
      amount: 1000n,
      currency: INR,
      params: smuggled,
      participants: ids,
      seed: SEED,
    });
    expect([...recomputed]).toEqual([...authoritative]);
  });
});
