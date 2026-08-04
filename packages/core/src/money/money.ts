/**
 * Money value type: an integer count of minor units + a currency (ADR-003).
 * All arithmetic is bigint. There is no code path in this package that turns
 * an amount into a float — `format` is the only place a Number appears, and
 * only for display.
 */

import {
  assertCurrencyCode,
  MoneyError,
  minorUnitExponent,
  minorUnitScale,
  type CurrencyCode,
} from './currency.js';

export interface Money {
  /** Integer minor units. Negative means "owes". */
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export function money(minor: bigint | number, currency: CurrencyCode): Money {
  assertCurrencyCode(currency);
  if (typeof minor === 'number') {
    if (!Number.isSafeInteger(minor)) {
      throw new MoneyError('INVALID_AMOUNT', `Minor units must be a safe integer, got ${minor}`);
    }
    return { minor: BigInt(minor), currency };
  }
  return { minor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return money(0n, currency);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      'CURRENCY_MISMATCH',
      `Cannot combine ${a.currency} with ${b.currency}. Convert explicitly with an FX rate.`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { minor: -a.minor, currency: a.currency };
}

export function absolute(a: Money): Money {
  return { minor: a.minor < 0n ? -a.minor : a.minor, currency: a.currency };
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  let total = 0n;
  for (const item of items) {
    if (item.currency !== currency) {
      throw new MoneyError(
        'CURRENCY_MISMATCH',
        `Expected all amounts in ${currency}, found ${item.currency}`,
      );
    }
    total += item.minor;
  }
  return money(total, currency);
}

export function isZero(a: Money): boolean {
  return a.minor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/** Integer division rounding halves away from zero. Deterministic on negatives. */
export function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new MoneyError('INVALID_AMOUNT', 'Division by zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * "420.50" (major units) → 42050n minor units for INR.
 * Accepts an optional leading sign, digit grouping is NOT accepted — this is a
 * machine parser, locale input parsing belongs in the UI layer.
 */
export function parseMajor(input: string, currency: CurrencyCode): Money {
  const exponent = minorUnitExponent(currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) {
    throw new MoneyError('INVALID_AMOUNT', `Cannot parse "${input}" as a ${currency} amount`);
  }
  const [, sign, whole = '0', fractionRaw = ''] = match;
  if (fractionRaw.length > exponent) {
    throw new MoneyError(
      'INVALID_AMOUNT',
      `${currency} has ${exponent} decimal places, got "${input}"`,
    );
  }
  const fraction = fractionRaw.padEnd(exponent, '0');
  const minor = BigInt(whole) * minorUnitScale(currency) + BigInt(fraction === '' ? '0' : fraction);
  return money(sign === '-' ? -minor : minor, currency);
}

/** 42050n INR → "420.50". No grouping, no symbol — see `format` for display. */
export function toMajorString(amount: Money): string {
  const exponent = minorUnitExponent(amount.currency);
  const scale = minorUnitScale(amount.currency);
  const negative = amount.minor < 0n;
  const abs = negative ? -amount.minor : amount.minor;
  const whole = abs / scale;
  const sign = negative ? '-' : '';
  if (exponent === 0) return `${sign}${whole}`;
  const fraction = (abs % scale).toString().padStart(exponent, '0');
  return `${sign}${whole}.${fraction}`;
}
