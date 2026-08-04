/**
 * Display formatting. The ONLY place in this package where a Number is
 * produced from an amount, and it never feeds back into arithmetic.
 * TDR §11: all money/date formatting is locale-aware.
 */

import { minorUnitExponent, minorUnitScale, type CurrencyCode } from './currency.js';
import { toMajorString, type Money } from './money.js';

export type Locale = 'en-IN' | 'ta-IN' | 'hi-IN' | (string & {});

export interface FormatOptions {
  locale?: Locale;
  /** Drop the fraction when the amount is a whole unit (₹420 instead of ₹420.00). */
  compactFraction?: boolean;
  /** Render the sign explicitly (+₹420). Negatives always show their sign. */
  signDisplay?: 'auto' | 'always' | 'never';
}

const DEFAULT_LOCALE: Locale = 'en-IN';

export function format(amount: Money, options: FormatOptions = {}): string {
  const { locale = DEFAULT_LOCALE, compactFraction = false, signDisplay = 'auto' } = options;
  const exponent = minorUnitExponent(amount.currency);
  const isWhole = amount.minor % minorUnitScale(amount.currency) === 0n;
  const fractionDigits = compactFraction && isWhole ? 0 : exponent;

  const magnitude = signDisplay === 'never' && amount.minor < 0n ? -amount.minor : amount.minor;

  // Number() is safe here: a value large enough to lose precision (>9e15 minor
  // units ≈ ₹90 trillion) is not a real split, and display is not arithmetic.
  const asNumber = Number(toMajorString({ minor: magnitude, currency: amount.currency }));

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    signDisplay: signDisplay === 'never' ? 'auto' : signDisplay,
  }).format(asNumber);
}

/** Just the currency symbol for the locale ("₹", "$"). */
export function currencySymbol(currency: CurrencyCode, locale: Locale = DEFAULT_LOCALE): string {
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? currency;
}

export type BalanceDirection = 'owed_to_you' | 'you_owe' | 'settled';

export function balanceDirection(minor: bigint): BalanceDirection {
  if (minor > 0n) return 'owed_to_you';
  if (minor < 0n) return 'you_owe';
  return 'settled';
}

/**
 * TDR §11 accessibility: money values carry a spoken label, never a bare
 * number. Copy lives in notifications/copy.ts so it stays translatable.
 */
export function moneyAccessibilityLabel(
  amount: Money,
  direction: BalanceDirection,
  strings: { owedToYou: string; youOwe: string; settled: string },
  options: FormatOptions = {},
): string {
  const rendered = format({ minor: amount.minor < 0n ? -amount.minor : amount.minor, currency: amount.currency }, options);
  switch (direction) {
    case 'owed_to_you':
      return strings.owedToYou.replace('{amount}', rendered);
    case 'you_owe':
      return strings.youOwe.replace('{amount}', rendered);
    case 'settled':
      return strings.settled;
  }
}
