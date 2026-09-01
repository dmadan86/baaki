/**
 * What a money field does with what somebody types.
 *
 * These are the rules the amount hero and the per-payer fields both run on, so
 * a break here is a break in every money input in the app at once.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  formatMinorInput,
  parseMinorInput,
  sanitiseMinorInput,
  type CurrencyCode,
} from '../src/money/index.js';

const CURRENCIES: CurrencyCode[] = ['INR', 'USD', 'EUR', 'JPY'];

describe('sanitiseMinorInput', () => {
  it('strips anything that is not a digit or a separator', () => {
    expect(sanitiseMinorInput('₹1,2 3abc', 'INR')).toBe('123');
  });

  it('keeps only the first decimal point', () => {
    expect(sanitiseMinorInput('1.2.3', 'INR')).toBe('1.23');
  });

  it('lets a half-typed number stand', () => {
    expect(sanitiseMinorInput('12.', 'INR')).toBe('12.');
    expect(sanitiseMinorInput('0.', 'INR')).toBe('0.');
  });

  it('drops a leading zero once real digits follow, but keeps "0.50"', () => {
    expect(sanitiseMinorInput('0012', 'INR')).toBe('12');
    expect(sanitiseMinorInput('0.50', 'INR')).toBe('0.50');
  });

  it('refuses a decimal point in a currency that has no minor unit', () => {
    expect(sanitiseMinorInput('1.5', 'JPY')).toBe('15');
    expect(sanitiseMinorInput('1000', 'JPY')).toBe('1000');
  });

  it('truncates past the currency precision rather than rounding it', () => {
    // Rounding what is still being typed would move the caret under a thumb.
    expect(sanitiseMinorInput('1.999', 'INR')).toBe('1.99');
  });

  it('is idempotent — cleaning clean text changes nothing', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...CURRENCIES), (raw, currency) => {
        const once = sanitiseMinorInput(raw, currency);
        expect(sanitiseMinorInput(once, currency)).toBe(once);
      }),
    );
  });
});

describe('parseMinorInput', () => {
  it('reads rupees and paise', () => {
    expect(parseMinorInput('10', 'INR')).toBe(1000n);
    expect(parseMinorInput('10.5', 'INR')).toBe(1050n);
    expect(parseMinorInput('10.50', 'INR')).toBe(1050n);
    expect(parseMinorInput('0.07', 'INR')).toBe(7n);
  });

  it('reads a currency with no minor unit as whole units', () => {
    expect(parseMinorInput('1000', 'JPY')).toBe(1000n);
  });

  it('treats an unfinished field as zero, not as an error', () => {
    expect(parseMinorInput('', 'INR')).toBe(0n);
    expect(parseMinorInput('.', 'INR')).toBe(0n);
    expect(parseMinorInput('abc', 'INR')).toBe(0n);
  });

  it('never produces a negative — no money field can express one', () => {
    expect(parseMinorInput('-50', 'INR')).toBe(5000n);
  });

  it('holds a number far past what a float could', () => {
    expect(parseMinorInput('90071992547409.93', 'INR')).toBe(9_007_199_254_740_993n);
  });
});

describe('round trip', () => {
  it('format → parse returns the same minor units, in every currency', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.constantFrom(...CURRENCIES),
        (minor, currency) => {
          expect(parseMinorInput(formatMinorInput(minor, currency), currency)).toBe(minor);
        },
      ),
    );
  });

  it('parse → format is stable once it has been through both', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...CURRENCIES), (raw, currency) => {
        const settled = formatMinorInput(parseMinorInput(raw, currency), currency);
        expect(formatMinorInput(parseMinorInput(settled, currency), currency)).toBe(settled);
      }),
    );
  });

  it('shows an empty field for zero so the placeholder survives', () => {
    for (const currency of CURRENCIES) expect(formatMinorInput(0n, currency)).toBe('');
  });

  it('pads the minor part so ₹10.05 is not shown as ₹10.5', () => {
    expect(formatMinorInput(1005n, 'INR')).toBe('10.05');
    expect(formatMinorInput(1050n, 'INR')).toBe('10.50');
  });
});
