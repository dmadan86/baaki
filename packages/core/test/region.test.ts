import { describe, expect, it } from 'vitest';

import {
  COUNTRIES,
  countryFlag,
  countryName,
  currencyForCountry,
  isCountryCode,
  dialingCodeForCountry,
  splitDialCode,
} from '../src/money/region';
import { isCurrencyCode, minorUnitExponent } from '../src/money/currency';

describe('what a country counts in', () => {
  it('knows the markets Waves is going to', () => {
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

describe('taking a typed number apart', () => {
  it('splits a number into the country and the digits after it', () => {
    expect(splitDialCode('+919876543210')).toEqual({
      country: 'IN',
      dialCode: '+91',
      national: '9876543210',
    });
  });

  it('ignores the spaces and brackets people type', () => {
    expect(splitDialCode('+44 (0)20 7946 0958')?.national).toBe('02079460958');
  });

  it('settles a shared code the same way every time', () => {
    // +1 is the United States and Canada both. Either answer is defensible;
    // an answer that changed between identical inputs is not.
    expect(splitDialCode('+14155550123')?.country).toBe('US');
    expect(splitDialCode('+14155550123')?.country).toBe('US');
  });

  it('prefers the longest code, not the first one that matches', () => {
    // +9 is nobody, but +91 and +971 both start with it, and +971 must not be
    // read as India with a stray 1.
    expect(splitDialCode('+971501234567')).toEqual({
      country: 'AE',
      dialCode: '+971',
      national: '501234567',
    });
  });

  it('has no opinion about a number it cannot place', () => {
    // No plus at all: a bare national number, which the caller keeps as digits.
    expect(splitDialCode('9876543210')).toBeNull();
    // A real code, but for a country this app does not stock.
    expect(splitDialCode('+2376912345')).toBeNull();
    expect(splitDialCode('')).toBeNull();
    expect(splitDialCode(null)).toBeNull();
  });

  it('round-trips every country it lists', () => {
    for (const entry of COUNTRIES) {
      const dialCode = dialingCodeForCountry(entry.code);
      if (!dialCode) continue;
      const split = splitDialCode(`${dialCode}5551234567`);
      expect(split, entry.code).not.toBeNull();
      // Not necessarily the same country — +1 is shared — but always the same
      // code, which is the half that decides where the message is sent.
      expect(split?.dialCode, entry.code).toBe(dialCode);
      expect(split?.national, entry.code).toBe('5551234567');
    }
  });
});
