/**
 * ADR-003: a conversion has to be reproducible byte-for-byte, later, on a
 * different device, with no network.
 *
 * That is only true if the rate is stored as an exact rational and never as a
 * decimal number. These tests pin the two ways a person actually knows a rate —
 * typing one, or reading it off a card statement — and the round trip through
 * the JSON column that has to survive both.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  convert,
  convertWithRecord,
  fromFxRecord,
  fxRate,
  invertRate,
  money,
  MoneyError,
  rateFromAmounts,
  rateFromDecimal,
  rateToDecimal,
  toFxRecord,
} from '../src/index.js';

describe('a rate somebody typed', () => {
  it('keeps the decimal exactly, as a rational', () => {
    const rate = rateFromDecimal('91.25', 'EUR', 'INR');
    expect(rate.num).toBe(9125n);
    expect(rate.den).toBe(100n);
    expect(rate.source).toBe('manual');
  });

  it('converts without ever touching a float', () => {
    const rate = rateFromDecimal('91.25', 'EUR', 'INR');
    // €50.00 = 5000 minor. 5000 * 9125 / 100 = 456250 paise = ₹4,562.50
    expect(convert(money(5000n, 'EUR'), rate).minor).toBe(456250n);
  });

  it('handles a rate below one', () => {
    const rate = rateFromDecimal('0.0109', 'INR', 'EUR');
    expect(convert(money(456250n, 'INR'), rate).minor).toBe(4973n);
  });

  it('crosses currencies with different minor units', () => {
    // JPY has no minor unit: ¥1000 is 1000 minor, not 100000.
    const rate = rateFromDecimal('0.55', 'JPY', 'INR');
    // 1000 JPY * 0.55 = 550 INR = 55000 paise.
    expect(convert(money(1000n, 'JPY'), rate).minor).toBe(55000n);
  });

  it('refuses anything that is not a rate', () => {
    for (const bad of ['', '-1', '1e5', '91,25', 'abc', '1.2.3']) {
      expect(() => rateFromDecimal(bad, 'EUR', 'INR')).toThrow(MoneyError);
    }
  });
});

describe('a rate implied by a card statement', () => {
  it('derives the bank rate from what was spent and what was charged', () => {
    // €50.00 spent, ₹4,600 charged — the bank's rate, markup included.
    const rate = rateFromAmounts(money(5000n, 'EUR'), money(460000n, 'INR'));
    expect(convert(money(5000n, 'EUR'), rate).minor).toBe(460000n);
    expect(rate.source).toBe('implied');
  });

  it('is not the mid-market rate, and should not be', () => {
    // The whole point: the bank took a cut, and the ledger records what the
    // statement says rather than what an exchange would have given.
    const implied = rateFromAmounts(money(5000n, 'EUR'), money(460000n, 'INR'));
    const mid = rateFromDecimal('91.25', 'EUR', 'INR');
    expect(convert(money(5000n, 'EUR'), implied).minor).toBeGreaterThan(
      convert(money(5000n, 'EUR'), mid).minor,
    );
  });

  it('corrects for currencies with different minor units', () => {
    // ¥10,000 spent, ₹5,500 charged. Without the exponent correction this rate
    // would be out by a factor of a hundred.
    const rate = rateFromAmounts(money(10_000n, 'JPY'), money(550_000n, 'INR'));
    expect(convert(money(10_000n, 'JPY'), rate).minor).toBe(550_000n);
    expect(rateToDecimal(rate, 2)).toBe('0.55');
  });

  it('refuses to imply a rate from nothing', () => {
    expect(() => rateFromAmounts(money(0n, 'EUR'), money(100n, 'INR'))).toThrow(MoneyError);
    expect(() => rateFromAmounts(money(100n, 'EUR'), money(0n, 'INR'))).toThrow(MoneyError);
  });
});

describe('showing a rate back', () => {
  it('renders the decimal that was typed', () => {
    expect(rateToDecimal(rateFromDecimal('91.25', 'EUR', 'INR'), 6)).toBe('91.25');
    expect(rateToDecimal(rateFromDecimal('0.0109', 'INR', 'EUR'), 6)).toBe('0.0109');
    expect(rateToDecimal(rateFromDecimal('83', 'USD', 'INR'), 6)).toBe('83');
  });
});

describe('the rate stored on the expense', () => {
  it('survives the JSON column unchanged', () => {
    const rate = rateFromDecimal('91.257364', 'EUR', 'INR');
    const restored = fromFxRecord(toFxRecord(rate));
    expect(restored).toEqual(rate);
  });

  it('converts identically before and after storage', () => {
    const rate = rateFromDecimal('91.257364', 'EUR', 'INR');
    const amount = money(123_456n, 'EUR');
    expect(convertWithRecord(amount, toFxRecord(rate))).toEqual(convert(amount, rate));
  });

  it('reproduces the same minor units on every run (ADR-003)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        (minor, num, den) => {
          const rate = fxRate({
            num,
            den,
            from: 'EUR',
            to: 'INR',
            ts: '2026-08-05T00:00:00.000Z',
            source: 'ecb',
          });
          const amount = money(minor, 'EUR');
          const once = convert(amount, rate);
          const again = convertWithRecord(amount, toFxRecord(rate));
          expect(again).toEqual(once);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('round-trips through inversion without drifting', () => {
    // Converting back does not always land on the original minor unit — that is
    // rounding, not a bug — but the rate itself must invert exactly.
    const rate = rateFromDecimal('91.25', 'EUR', 'INR');
    expect(invertRate(invertRate(rate))).toEqual(rate);
  });

  it('refuses a rate that converts a currency to itself', () => {
    expect(() =>
      fxRate({ num: 1n, den: 1n, from: 'INR', to: 'INR', ts: '', source: 'manual' }),
    ).toThrow(MoneyError);
  });

  it('refuses to convert an amount the rate is not for', () => {
    const rate = rateFromDecimal('91.25', 'EUR', 'INR');
    expect(() => convert(money(100n, 'USD'), rate)).toThrow(MoneyError);
  });
});
