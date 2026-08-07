/**
 * The price list, and what to do with an answer the server did not give.
 */

import { describe, expect, it } from 'vitest';

import {
  FREE_ENTITLEMENT,
  FREE_MONTHLY_SCANS,
  PLUS_MONTHLY_SCANS,
  PRICED_COUNTRIES,
  priceFor,
  readEntitlement,
} from '../src/billing/plans';
import { isCurrencyCode } from '../src/money/currency';
import { currencyForCountry } from '../src/money/region';

describe('prices', () => {
  it('charges each market what it will bear rather than converting one number', () => {
    // ₹79 is about $0.95. Charging that in the United States leaves most of the
    // revenue on the floor; charging $4.99 in India sells nothing. That is the
    // whole reason this is a table and not an exchange rate.
    expect(priceFor('IN', 'monthly')).toEqual({ minor: 7900n, currency: 'INR' });
    expect(priceFor('US', 'monthly')).toEqual({ minor: 499n, currency: 'USD' });
    expect(priceFor('AU', 'monthly')).toEqual({ minor: 799n, currency: 'AUD' });
  });

  it('prices every period in every market it names', () => {
    for (const country of PRICED_COUNTRIES) {
      for (const period of ['monthly', 'yearly', 'lifetime', 'trip_pass'] as const) {
        const price = priceFor(country, period);
        expect(price.minor, `${country} ${period}`).toBeGreaterThan(0n);
        expect(isCurrencyCode(price.currency), `${country} ${period}`).toBe(true);
      }
    }
  });

  it('prices a market in the currency that market actually uses', () => {
    // A dirham price tagged AED and a country that counts in something else is
    // a store product nobody can buy.
    for (const country of PRICED_COUNTRIES) {
      const expected = currencyForCountry(country);
      if (!expected) continue;
      expect(priceFor(country, 'monthly').currency, country).toBe(expected);
    }
  });

  it('makes a year cheaper than twelve months everywhere', () => {
    // If it is not, the yearly plan is a worse deal than the thing it is meant
    // to convert people away from.
    for (const country of PRICED_COUNTRIES) {
      const monthly = priceFor(country, 'monthly').minor;
      const yearly = priceFor(country, 'yearly').minor;
      expect(yearly, country).toBeLessThan(monthly * 12n);
    }
  });

  it('keeps the trip pass under a year and over a month', () => {
    // Cheap enough that one person covers a group without thinking, dear
    // enough that it does not undercut the subscription it feeds.
    for (const country of PRICED_COUNTRIES) {
      const pass = priceFor(country, 'trip_pass').minor;
      expect(pass, country).toBeGreaterThan(priceFor(country, 'monthly').minor);
      expect(pass, country).toBeLessThan(priceFor(country, 'yearly').minor);
    }
  });

  it('falls back rather than returning nothing for a country with no row', () => {
    expect(priceFor('ZZ', 'monthly')).toEqual(priceFor('US', 'monthly'));
    expect(priceFor(null, 'yearly')).toEqual(priceFor('US', 'yearly'));
    expect(priceFor(' in ', 'monthly').currency).toBe('INR');
  });
});

describe('reading what the server said', () => {
  it('takes a plain answer at its word', () => {
    expect(
      readEntitlement({
        tier: 'plus',
        until: '2027-01-01T00:00:00Z',
        source: 'subscription',
        scanLimit: 300,
      }),
    ).toEqual({
      tier: 'plus',
      until: '2027-01-01T00:00:00Z',
      source: 'subscription',
      scanLimit: 300,
    });
  });

  it('never guesses upward', () => {
    // The failure mode of guessing the other way is giving away what somebody
    // else paid for. This one is a paywall that clears on the next good call.
    for (const bad of [null, undefined, 'plus', 42, {}, { tier: 'PLUS' }, { tier: 'premium' }]) {
      expect(readEntitlement(bad), JSON.stringify(bad)).toEqual(FREE_ENTITLEMENT);
    }
  });

  it('fills in a sensible limit when the server did not send one', () => {
    expect(readEntitlement({ tier: 'plus' }).scanLimit).toBe(PLUS_MONTHLY_SCANS);
    expect(readEntitlement({ tier: 'free' }).scanLimit).toBe(FREE_MONTHLY_SCANS);
    expect(readEntitlement({ tier: 'plus', scanLimit: -5 }).scanLimit).toBe(PLUS_MONTHLY_SCANS);
    expect(readEntitlement({ tier: 'plus', scanLimit: '90' }).scanLimit).toBe(90);
  });

  it('does not let a source contradict the tier', () => {
    // A row that says free-but-lifetime has been edited by hand. Trust the
    // tier, which is the thing that gates, and let the source be cosmetic.
    expect(readEntitlement({ tier: 'free', source: 'lifetime' }).source).toBe('free');
    expect(readEntitlement({ tier: 'plus', source: 'free' }).source).toBe('subscription');
  });
});
