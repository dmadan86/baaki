import { describe, expect, it } from 'vitest';

import {
  COUNTRIES,
  countryFlag,
  countryName,
  currencyForCountry,
  isCountryCode,
} from '../src/money/region';
import { isCurrencyCode, minorUnitExponent } from '../src/money/currency';

describe('what a country counts in', () => {
  it('knows the markets Baaki is going to', () => {
    expect(currencyForCountry('IN')).toBe('INR');
    expect(currencyForCountry('AE')).toBe('AED');
    expect(currencyForCountry('SA')).toBe('SAR');
    expect(currencyForCountry('BR')).toBe('BRL');
    expect(currencyForCountry('SG')).toBe('SGD');
  });

  it('says nothing rather than guessing', () => {
    // A wrong currency is worse than no opinion: INR on a group in Berlin gets
    // typed over once, but a plausible wrong guess gets missed. And an
    // unrecognised country is not an American one.
    expect(currencyForCountry('ZZ')).toBeNull();
    expect(currencyForCountry('')).toBeNull();
    expect(currencyForCountry(null)).toBeNull();
    expect(currencyForCountry(undefined)).toBeNull();
  });

  it('reads a code case- and space-insensitively', () => {
    expect(currencyForCountry(' ae ')).toBe('AED');
    expect(currencyForCountry('ae')).toBe('AED');
  });

  it('spells the euro out per country instead of inferring it', () => {
    for (const country of ['DE', 'FR', 'ES', 'IT', 'NL', 'PT', 'IE', 'AT', 'BE', 'GR', 'FI']) {
      expect(currencyForCountry(country), country).toBe('EUR');
    }
    // There is no rule that maps a country to a currency, only a list —
    // inferring one puts euros in Poland.
    expect(currencyForCountry('PL')).not.toBe('EUR');
  });

  it('only names currencies the money layer will accept', () => {
    // Catches a typo — 'AEDD' would sail through everything else and only
    // surface as a wrong amount on somebody's screen.
    for (const country of COUNTRIES) {
      const currency = currencyForCountry(country.code);
      if (!currency) continue;
      expect(isCurrencyCode(currency), `${country.code} → ${currency}`).toBe(true);
    }
  });

  it('gets the three-decimal Gulf currencies right', () => {
    // The one this list could quietly break. `minorUnitExponent` defaults to 2
    // for anything it does not know, so a missing entry does not throw — it
    // divides a Kuwaiti dinar by 100 instead of 1000 and loses a factor of ten
    // on every amount.
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('BHD')).toBe(3);
    expect(minorUnitExponent('OMR')).toBe(3);
    expect(minorUnitExponent('AED')).toBe(2);
    expect(minorUnitExponent('INR')).toBe(2);
  });
});

describe('the country list', () => {
  it('leads with the markets this app is for', () => {
    // Ordered by market, not alphabetically: somebody in the Gulf should not
    // scroll past forty countries to find theirs.
    expect(COUNTRIES[0]?.code).toBe('IN');
    expect(COUNTRIES.slice(0, 7).map((entry) => entry.code)).toEqual([
      'IN',
      'AE',
      'SA',
      'QA',
      'KW',
      'BH',
      'OM',
    ]);
  });

  it('has no duplicates and names everything it lists', () => {
    const codes = COUNTRIES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of COUNTRIES) {
      expect(entry.name, entry.code).not.toBe('');
      expect(countryName(entry.code)).toBe(entry.name);
    }
  });

  it('does not name a country it has never heard of', () => {
    expect(countryName('ZZ')).toBeNull();
    expect(countryName(null)).toBeNull();
  });

  it('recognises the shape of a country code', () => {
    expect(isCountryCode('AE')).toBe(true);
    expect(isCountryCode('ae')).toBe(true);
    expect(isCountryCode('en-AE')).toBe(false);
    expect(isCountryCode('UAE')).toBe(false);
    expect(isCountryCode('')).toBe(false);
    expect(isCountryCode(null)).toBe(false);
  });

  it('builds a flag from regional indicators, and refuses a bad code', () => {
    // 🇮🇳 is U+1F1EE U+1F1F3 — the two regional indicators for I and N.
    expect(countryFlag('IN')).toBe('\u{1F1EE}\u{1F1F3}');
    expect(countryFlag('us')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(countryFlag(null)).toBeNull();
    expect(countryFlag('')).toBeNull();
    expect(countryFlag('USA')).toBeNull();
    expect(countryFlag('1N')).toBeNull();
  });

  it('has a flag for every country it lists', () => {
    for (const entry of COUNTRIES) {
      expect(countryFlag(entry.code), entry.code).not.toBeNull();
    }
  });
});
