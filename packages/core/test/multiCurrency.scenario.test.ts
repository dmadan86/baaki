/**
 * A hand-built, hand-computed acceptance scenario for the balance engine:
 * four members, six expenses across three currencies (INR/USD/EUR), a mix of
 * split types (equal, exact, percent, multi-payer, partial-participant), then
 * settlements — confirmed, initiated and cross-currency — plus a soft-delete.
 *
 * The property test (balances.property.test.ts) proves the invariants hold for
 * random ledgers; this proves the engine gets a *specific, worked* ledger
 * exactly right, so a regression that still "sums to zero" but computes the
 * wrong split is caught. Every expected number below is derived by hand in the
 * comments.
 *
 * ADR-004: currencies never mix — each is its own independent ledger.
 */

import { describe, expect, it } from 'vitest';

import {
  balanceOf,
  balanceSums,
  computeNetBalances,
  computePairwiseBalances,
  netFromPairwise,
} from '../src/balances/balances.js';
import { SettlementStatus } from '../src/balances/types.js';
import type { ExpenseSnapshot, NetBalances, SettlementSnapshot } from '../src/balances/types.js';
import { computeShares, sumShares } from '../src/split/computeShares.js';
import type { MemberId, SplitParams } from '../src/split/types.js';
import { totalsByCurrency } from '../src/balances/totals.js';

// Four members.
const A = 'asha';
const R = 'ravi';
const M = 'meera';
const D = 'dev';

/**
 * Build one internally consistent expense: shares come from the real split
 * engine, and the test asserts Σpayers === amount === Σshares before it is used,
 * so a bad payer map can never quietly skew a balance.
 */
function expense(input: {
  id: string;
  currency: string;
  amount: bigint;
  payers: Record<MemberId, bigint>;
  params: SplitParams;
  participants: readonly MemberId[];
  date?: string;
  deletedAt?: string | null;
}): ExpenseSnapshot {
  const shareMap = computeShares({
    amount: input.amount,
    currency: input.currency,
    params: input.params,
    participants: input.participants,
    seed: input.id,
  });
  const shares = Object.fromEntries(shareMap);
  const paid = Object.values(input.payers).reduce((sum, value) => sum + value, 0n);
  // Guard the fixture itself: an expense whose payers or shares do not add up to
  // the total is a broken test, not a finding about the engine.
  expect(paid).toBe(input.amount);
  expect(sumShares(shareMap)).toBe(input.amount);
  return {
    id: input.id,
    currency: input.currency,
    amount: input.amount,
    payers: input.payers,
    shares,
    date: input.date ?? '2026-08-01',
    deletedAt: input.deletedAt ?? null,
  };
}

// ── The ledger ────────────────────────────────────────────────────────────
// INR (paise), amounts chosen to divide exactly so equal shares are clean.
//
// E1 dinner ₹4000, A paid, equal A/R/M/D → each owes 1000.
//    A +3000  R -1000  M -1000  D -1000
// E2 cab ₹1200, R paid, equal A/R/M (D out) → each owes 400.
//    A -400   R +800   M -400   D  0
// E3 groceries ₹900, M paid, exact A=300 R=200 M=100 D=300.
//    A -300   R -200   M +800   D -300
// INR net: A +2300  R -400  M -600  D -1300   (Σ 0)
const inrExpenses: readonly ExpenseSnapshot[] = [
  expense({
    id: 'inr-dinner',
    currency: 'INR',
    amount: 400_000n,
    payers: { [A]: 400_000n },
    params: { kind: 'equal' },
    participants: [A, R, M, D],
  }),
  expense({
    id: 'inr-cab',
    currency: 'INR',
    amount: 120_000n,
    payers: { [R]: 120_000n },
    params: { kind: 'equal' },
    participants: [A, R, M],
  }),
  expense({
    id: 'inr-groceries',
    currency: 'INR',
    amount: 90_000n,
    payers: { [M]: 90_000n },
    params: { kind: 'exact', amounts: { [A]: 30_000n, [R]: 20_000n, [M]: 10_000n, [D]: 30_000n } },
    participants: [A, R, M, D],
  }),
];

// USD (cents).
// E4 hotel $500, multi-payer A=$300 R=$200, equal A/R/M/D → each owes 125.
//    A +300-125=+175  R +200-125=+75  M -125  D -125
// E5 tour $120, D paid, percent A 50% / D 50% (participants A,D) → each owes 60.
//    A -60  D +120-60=+60
// USD net: A +115  R +75  M -125  D -65   (Σ 0)
const usdExpenses: readonly ExpenseSnapshot[] = [
  expense({
    id: 'usd-hotel',
    currency: 'USD',
    amount: 50_000n,
    payers: { [A]: 30_000n, [R]: 20_000n },
    params: { kind: 'equal' },
    participants: [A, R, M, D],
  }),
  expense({
    id: 'usd-tour',
    currency: 'USD',
    amount: 12_000n,
    payers: { [D]: 12_000n },
    params: { kind: 'percent', basisPoints: { [A]: 5_000, [D]: 5_000 } },
    participants: [A, D],
  }),
];

// EUR (cents).
// E6 museum €80, M paid, equal A/M → each owes 40.
//    A -40  M +80-40=+40
// EUR net: A -40  M +40   (Σ 0)
const eurExpenses: readonly ExpenseSnapshot[] = [
  expense({
    id: 'eur-museum',
    currency: 'EUR',
    amount: 8_000n,
    payers: { [M]: 8_000n },
    params: { kind: 'equal' },
    participants: [A, M],
  }),
];

const allExpenses: readonly ExpenseSnapshot[] = [...inrExpenses, ...usdExpenses, ...eurExpenses];

/** balanceOf for every member in one currency, as a plain object for asserting. */
function snapshot(balances: NetBalances, currency: string): Record<MemberId, bigint> {
  return {
    [A]: balanceOf(balances, A, currency),
    [R]: balanceOf(balances, R, currency),
    [M]: balanceOf(balances, M, currency),
    [D]: balanceOf(balances, D, currency),
  };
}

describe('multi-user × multi-expense × multi-currency scenario', () => {
  it('computes each currency ledger to the exact hand-derived net', () => {
    const net = computeNetBalances(allExpenses, []);

    expect(snapshot(net, 'INR')).toEqual({
      [A]: 230_000n,
      [R]: -40_000n,
      [M]: -60_000n,
      [D]: -130_000n,
    });
    expect(snapshot(net, 'USD')).toEqual({
      [A]: 11_500n,
      [R]: 7_500n,
      [M]: -12_500n,
      [D]: -6_500n,
    });
    expect(snapshot(net, 'EUR')).toEqual({ [A]: -4_000n, [R]: 0n, [M]: 4_000n, [D]: 0n });
  });

  it('every currency ledger sums to zero (ADR-004 / ADR-014)', () => {
    const sums = balanceSums(computeNetBalances(allExpenses, []));
    expect(sums.get('INR')).toBe(0n);
    expect(sums.get('USD')).toBe(0n);
    expect(sums.get('EUR')).toBe(0n);
  });

  it('keeps currencies independent — no cross-currency bleed', () => {
    const net = computeNetBalances(allExpenses, []);
    // Exactly three ledgers, no phantom fourth from a mixed sum.
    expect([...net.keys()].sort()).toEqual(['EUR', 'INR', 'USD']);
    // A member absent from a currency has no position in it, not a zero-sum
    // artefact leaking across: R and D never touched EUR.
    expect(net.get('EUR')?.has(R)).toBe(false);
    expect(net.get('EUR')?.has(D)).toBe(false);
  });

  it('reconciles the pairwise ledger with the net ledger (ADR-009)', () => {
    const edges = computePairwiseBalances(allExpenses, []);
    const reconstructed = netFromPairwise(edges);
    for (const currency of ['INR', 'USD', 'EUR']) {
      expect(snapshot(reconstructed, currency)).toEqual(
        snapshot(computeNetBalances(allExpenses, []), currency),
      );
    }
    // Pairwise edges never cross currencies.
    for (const edge of edges) expect(['INR', 'USD', 'EUR']).toContain(edge.currency);
  });

  it('applies confirmed settlements per currency and holds the zero-sum', () => {
    const settlements: readonly SettlementSnapshot[] = [
      // Ravi clears his INR debt to Asha.
      {
        id: 's-inr',
        from: R,
        to: A,
        currency: 'INR',
        amount: 40_000n,
        status: SettlementStatus.Confirmed,
        at: '2026-08-10T00:00:00Z',
      },
      // Dev clears his USD debt to Asha — a different currency, same night.
      {
        id: 's-usd',
        from: D,
        to: A,
        currency: 'USD',
        amount: 6_500n,
        status: SettlementStatus.AutoConfirmed,
        at: '2026-08-10T00:00:00Z',
      },
    ];
    const net = computeNetBalances(allExpenses, settlements);

    // INR: Ravi 0, Asha down by what he paid; Meera/Dev untouched.
    expect(snapshot(net, 'INR')).toEqual({ [A]: 190_000n, [R]: 0n, [M]: -60_000n, [D]: -130_000n });
    // USD: Dev 0, Asha down by 6500; the INR settlement did not touch USD.
    expect(snapshot(net, 'USD')).toEqual({ [A]: 5_000n, [R]: 7_500n, [M]: -12_500n, [D]: 0n });
    // EUR untouched by either settlement.
    expect(snapshot(net, 'EUR')).toEqual({ [A]: -4_000n, [R]: 0n, [M]: 4_000n, [D]: 0n });

    const sums = balanceSums(net);
    expect(sums.get('INR')).toBe(0n);
    expect(sums.get('USD')).toBe(0n);
    expect(sums.get('EUR')).toBe(0n);
  });

  it('excludes an initiated settlement from the headline but shows it in the preview', () => {
    const pending: readonly SettlementSnapshot[] = [
      {
        id: 's-eur-pending',
        from: A,
        to: M,
        currency: 'EUR',
        amount: 4_000n,
        status: SettlementStatus.Initiated,
        at: '2026-08-11T00:00:00Z',
      },
    ];

    // Headline: initiated does not move the ledger (TDR §3.3).
    const headline = computeNetBalances(eurExpenses, pending);
    expect(snapshot(headline, 'EUR')).toEqual({ [A]: -4_000n, [R]: 0n, [M]: 4_000n, [D]: 0n });

    // Preview: counted "as if confirmed" — Asha's EUR debt clears.
    const preview = computeNetBalances(eurExpenses, pending, { includePending: true });
    expect(balanceOf(preview, A, 'EUR')).toBe(0n);
    expect(balanceOf(preview, M, 'EUR')).toBe(0n);
  });

  it('drops a soft-deleted expense from balances (ADR-004)', () => {
    const withDeletedDinner = allExpenses.map((e) =>
      e.id === 'inr-dinner' ? { ...e, deletedAt: '2026-08-12T00:00:00Z' } : e,
    );
    const net = computeNetBalances(withDeletedDinner, []);

    // Remove E1's effect (A +3000, R/M/D -1000 each) from the INR net:
    // A 2300-3000=-700  R -400+1000=+600  M -600+1000=+400  D -1300+1000=-300
    expect(snapshot(net, 'INR')).toEqual({
      [A]: -70_000n,
      [R]: 60_000n,
      [M]: 40_000n,
      [D]: -30_000n,
    });
    expect(balanceSums(net).get('INR')).toBe(0n);
    // Other currencies are unaffected by an INR deletion.
    expect(snapshot(net, 'USD')).toEqual({
      [A]: 11_500n,
      [R]: 7_500n,
      [M]: -12_500n,
      [D]: -6_500n,
    });
  });

  it('rolls up one member across currencies without ever summing them (dashboard headline)', () => {
    const net = computeNetBalances(allExpenses, []);
    // Asha's position in each currency, fed to the dashboard's per-currency roll-up.
    const totals = totalsByCurrency([
      ['INR', balanceOf(net, A, 'INR')], // +2300
      ['USD', balanceOf(net, A, 'USD')], // +115
      ['EUR', balanceOf(net, A, 'EUR')], // -40
    ]);

    // One row per currency — never a single blended number.
    expect(totals).toHaveLength(3);
    const byCurrency = Object.fromEntries(totals.map((t) => [t.currency, t]));
    expect(byCurrency.INR).toMatchObject({ net: 230_000n, owed: 230_000n, owing: 0n });
    expect(byCurrency.USD).toMatchObject({ net: 11_500n, owed: 11_500n, owing: 0n });
    expect(byCurrency.EUR).toMatchObject({ net: -4_000n, owed: 0n, owing: 4_000n });

    // Ordered by magnitude: INR (2300) leads, then USD (115), then EUR (40).
    expect(totals.map((t) => t.currency)).toEqual(['INR', 'USD', 'EUR']);
  });
});
