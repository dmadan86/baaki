import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { minorUnitExponent, MoneyError } from '../src/money/currency.js';
import {
  format,
  formatParts,
  balanceDirection,
  moneyAccessibilityLabel,
  BalanceDirection,
} from '../src/money/format.js';
import { convert, fxRate, fromFxRecord, invertRate, toFxRecord } from '../src/money/fx.js';
import {
  add,
  divideRoundHalfAwayFromZero,
  money,
  parseMajor,
  subtract,
  sum,
  toMajorString,
} from '../src/money/money.js';
import { copyFor } from '../src/notifications/copy.js';

describe('currency', () => {
  it('knows the exponents that are not 2', () => {
    expect(minorUnitExponent('INR')).toBe(2);
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('ZZZ')).toBe(2); // unknown but well-formed
  });

  it('rejects anything that is not an ISO-4217 alpha-3 code', () => {
    expect(() => money(1n, 'rupees')).toThrowError(MoneyError);
  });
});

describe('parse and render', () => {
  it('round-trips major-unit strings exactly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (minor) => {
        const amount = money(minor, 'INR');
        expect(parseMajor(toMajorString(amount), 'INR').minor).toBe(minor);
      }),
    );
  });

  it('handles zero-decimal and three-decimal currencies', () => {
    expect(toMajorString(money(4200n, 'JPY'))).toBe('4200');
    expect(toMajorString(money(4200n, 'KWD'))).toBe('4.200');
    expect(parseMajor('4.200', 'KWD').minor).toBe(4200n);
  });

  it('refuses more precision than the currency has', () => {
    expect(() => parseMajor('420.555', 'INR')).toThrowError(/decimal places/);
  });

  it('formats for the locale without ever touching float arithmetic', () => {
    const formatted = format(money(42050n, 'INR'), { locale: 'en-IN' });
    expect(formatted).toContain('420.50');
    expect(format(money(42000n, 'INR'), { locale: 'en-IN', compactFraction: true })).not.toContain(
      '.00',
    );
  });

  it('splits an amount at the decimal point the locale actually uses', () => {
    const rupees = formatParts(money(151753n, 'INR'), { locale: 'en-IN' });
    expect(rupees.lead).toBe('₹1,517');
    expect(rupees.fraction).toBe('.53');
    expect(rupees.trail).toBe('');

    // A locale that puts the symbol last and separates with a comma: splitting
    // the rendered string on '.' would hand back the whole thing.
    const euros = formatParts(money(151753n, 'EUR'), { locale: 'de-DE' });
    expect(euros.fraction).toBe(',53');
    expect(euros.trail).toContain('€');
  });

  it('leaves nothing to fade when the amount is whole or the currency has no minor unit', () => {
    expect(
      formatParts(money(42000n, 'INR'), { locale: 'en-IN', compactFraction: true }).fraction,
    ).toBe('');
    expect(formatParts(money(4200n, 'JPY'), { locale: 'en-IN' }).fraction).toBe('');
  });

  it('always joins back to exactly what format() renders', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 10n), max: 10n ** 10n }),
        fc.constantFrom('en-IN', 'ta-IN', 'de-DE'),
        fc.constantFrom('INR', 'USD', 'JPY', 'KWD' as const),
        fc.boolean(),
        (minor, locale, currency, compactFraction) => {
          const amount = money(minor, currency as 'INR');
          const options = { locale, compactFraction };
          expect(formatParts(amount, options).text).toBe(format(amount, options));
        },
      ),
    );
  });

  it('labels money for screen readers (TDR §11)', () => {
    const strings = copyFor('en').money;
    const label = moneyAccessibilityLabel(money(42000n, 'INR'), BalanceDirection.OwedToYou, strings, {
      locale: 'en-IN',
      compactFraction: true,
    });
    expect(label).toMatch(/^You are owed/);
    expect(balanceDirection(-1n)).toBe('you_owe');
    expect(balanceDirection(0n)).toBe('settled');
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly, and refuses to mix currencies', () => {
    expect(add(money(1n, 'INR'), money(2n, 'INR')).minor).toBe(3n);
    expect(subtract(money(1n, 'INR'), money(2n, 'INR')).minor).toBe(-1n);
    expect(() => add(money(1n, 'INR'), money(2n, 'USD'))).toThrowError(/CURRENCY|USD/);
    expect(sum([money(10n, 'INR'), money(5n, 'INR')], 'INR').minor).toBe(15n);
  });

  it('rounds halves away from zero, symmetrically', () => {
    expect(divideRoundHalfAwayFromZero(5n, 2n)).toBe(3n);
    expect(divideRoundHalfAwayFromZero(-5n, 2n)).toBe(-3n);
    expect(divideRoundHalfAwayFromZero(4n, 2n)).toBe(2n);
    expect(() => divideRoundHalfAwayFromZero(1n, 0n)).toThrowError(MoneyError);
  });
});

describe('fx', () => {
  const usdToInr = fxRate({
    num: 8412n,
    den: 100n,
    from: 'USD',
    to: 'INR',
    ts: '2026-03-01T00:00:00Z',
    source: 'test',
  });

  it('is reproducible: the same rate always yields the same minor units', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 10n }), (minor) => {
        const amount = money(minor, 'USD');
        expect(convert(amount, usdToInr).minor).toBe(convert(amount, usdToInr).minor);
      }),
    );
  });

  it('survives a JSON round-trip unchanged', () => {
    const restored = fromFxRecord(JSON.parse(JSON.stringify(toFxRecord(usdToInr))));
    expect(restored).toEqual(usdToInr);
    expect(convert(money(10000n, 'USD'), restored).minor).toBe(
      convert(money(10000n, 'USD'), usdToInr).minor,
    );
  });

  it('handles differing minor-unit exponents', () => {
    const inrToJpy = fxRate({
      num: 18n,
      den: 10n,
      from: 'INR',
      to: 'JPY',
      ts: '2026-03-01T00:00:00Z',
      source: 'test',
    });
    // ₹100.00 → 10000 paise → ¥180
    expect(convert(money(10000n, 'INR'), inrToJpy).minor).toBe(180n);
  });

  it('inverts back to within a minor unit', () => {
    const there = convert(money(10000n, 'USD'), usdToInr);
    const back = convert(there, invertRate(usdToInr));
    expect(back.minor >= 9999n && back.minor <= 10001n).toBe(true);
  });

  it('rejects a rate applied to the wrong currency', () => {
    expect(() => convert(money(1n, 'INR'), usdToInr)).toThrowError(/USD/);
  });
});
