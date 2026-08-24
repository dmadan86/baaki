/**
 * Exposure is the trip's honest answer to "what did I pay" when the answer is
 * three currencies, not one. These pin that it never mixes them and never
 * invents a total: it filters, orders, and hands each currency back whole.
 */

import { describe, expect, it } from 'vitest';

import { currencyExposure } from '../src/money/exposure';

describe('currencyExposure', () => {
  it('orders currencies by nominal amount, largest first', () => {
    const out = currencyExposure({ INR: 1240000n, EUR: 9000n, THB: 210000n });
    expect(out).toEqual([
      { currency: 'INR', amountMinor: 1240000n },
      { currency: 'THB', amountMinor: 210000n },
      { currency: 'EUR', amountMinor: 9000n },
    ]);
  });

  it('drops currencies with zero or negative exposure', () => {
    const out = currencyExposure({ INR: 5000n, USD: 0n, GBP: -100n });
    expect(out).toEqual([{ currency: 'INR', amountMinor: 5000n }]);
  });

  it('normalises the currency code and breaks ties by code', () => {
    const out = currencyExposure({ eur: 1000n, usd: 1000n });
    expect(out).toEqual([
      { currency: 'EUR', amountMinor: 1000n },
      { currency: 'USD', amountMinor: 1000n },
    ]);
  });

  it('is empty when nothing was paid', () => {
    expect(currencyExposure({})).toEqual([]);
  });
});
