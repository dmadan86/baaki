/**
 * The home screen's headline figure.
 *
 * This existed as an inline loop inside `useHomeSummary` that added every
 * group's balance together and handed the result to a `MoneyText` hardcoded to
 * `currency="INR"`. On a phone with one group in USD the screen said ₹132.50 in
 * the headline and $132.50 in the row underneath it — the same number, twice,
 * under two currencies. With groups in two currencies it added dollars to
 * rupees and put a rupee sign on the answer.
 *
 * ADR-004 keeps per-currency balances and states the zero-sum invariant per
 * currency; the TDR says currencies are never summed or converted. The loop was
 * untested because it lived inside a hook, so the rule was broken in the one
 * place nothing could reach.
 */

import { describe, expect, it } from 'vitest';

import { totalsByCurrency } from '../src/data/totals';

/** `[currency, balance]` pairs, as the hook collects them per group. */
const pairs = (...entries: [string, bigint][]): [string, bigint][] => entries;

describe('totalsByCurrency', () => {
  it('never adds one currency to another', () => {
    const totals = totalsByCurrency(pairs(['USD', 13250n], ['INR', 50000n]));

    expect(totals).toHaveLength(2);
    // The bug: a single total of 63250 labelled with whichever symbol was hardcoded.
    expect(totals.map((total) => total.net)).not.toContain(63250n);
    expect(totals.find((total) => total.currency === 'USD')?.net).toBe(13250n);
    expect(totals.find((total) => total.currency === 'INR')?.net).toBe(50000n);
  });

  it('adds balances that really are the same currency', () => {
    const totals = totalsByCurrency(pairs(['INR', 1000n], ['INR', 2500n]));

    expect(totals).toHaveLength(1);
    expect(totals[0]?.currency).toBe('INR');
    expect(totals[0]?.net).toBe(3500n);
    expect(totals[0]?.owed).toBe(3500n);
    expect(totals[0]?.owing).toBe(0n);
  });

  it('keeps owed and owing apart within a currency', () => {
    const totals = totalsByCurrency(pairs(['INR', 4000n], ['INR', -1500n]));

    expect(totals[0]?.owed).toBe(4000n);
    expect(totals[0]?.owing).toBe(1500n);
    expect(totals[0]?.net).toBe(2500n);
  });

  it('does not net a debt in one currency against credit in another', () => {
    // Owed $100, owe ₹100. Neither cancels the other, and a person who is up in
    // dollars and down in rupees is not "all settled".
    const totals = totalsByCurrency(pairs(['USD', 10000n], ['INR', -10000n]));

    expect(totals.find((total) => total.currency === 'USD')?.net).toBe(10000n);
    expect(totals.find((total) => total.currency === 'INR')?.net).toBe(-10000n);
    expect(totals.every((total) => total.net !== 0n)).toBe(true);
  });

  it('leads with the currency holding the most, so the headline is the one that matters', () => {
    const totals = totalsByCurrency(pairs(['INR', 100n], ['USD', 90000n], ['EUR', -500n]));

    expect(totals.map((total) => total.currency)).toEqual(['USD', 'EUR', 'INR']);
  });

  it('ranks by size of the debt, not by its sign', () => {
    // Owing a lot is as much "what matters" as being owed a lot.
    const totals = totalsByCurrency(pairs(['INR', 100n], ['USD', -90000n]));

    expect(totals[0]?.currency).toBe('USD');
  });

  it('orders ties by name rather than by whichever group synced first', () => {
    const forwards = totalsByCurrency(pairs(['USD', 500n], ['INR', 500n]));
    const backwards = totalsByCurrency(pairs(['INR', 500n], ['USD', 500n]));

    expect(forwards.map((total) => total.currency)).toEqual(['INR', 'USD']);
    expect(backwards.map((total) => total.currency)).toEqual(['INR', 'USD']);
  });

  it('reports a settled currency as settled rather than dropping it', () => {
    // Zero is a fact worth showing: it is the difference between "you are square
    // with this group" and "this group is not on your phone".
    const totals = totalsByCurrency(pairs(['INR', 2000n], ['INR', -2000n]));

    expect(totals).toHaveLength(1);
    expect(totals[0]?.net).toBe(0n);
  });

  it('has nothing to say about no groups', () => {
    expect(totalsByCurrency([])).toEqual([]);
  });
});
