/**
 * ISO-4217 currency handling. ADR-003: money is always integer minor units
 * (paise, cents) plus a currency code — never a float, anywhere.
 */

export type CurrencyCode = string;

/**
 * Minor-unit exponents for currencies we expect to see. Anything not listed
 * falls back to 2, which is correct for the overwhelming majority of ISO-4217.
 * Listed explicitly: every currency whose exponent is NOT 2, plus the ones
 * Waves cares about first (INR and the diaspora corridors).
 */
const EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  // exponent 0
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // exponent 3
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // exponent 2 — spelled out because these are the ones we actually ship with
  AED: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  LKR: 2,
  MYR: 2,
  NPR: 2,
  NZD: 2,
  SGD: 2,
  USD: 2,
});

export const DEFAULT_MINOR_UNIT_EXPONENT = 2;

const CURRENCY_RE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_RE.test(value);
}

export function assertCurrencyCode(value: string): asserts value is CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new MoneyError(
      MoneyErrorCode.InvalidCurrency,
      `Not an ISO-4217 alpha-3 code: "${value}"`,
    );
  }
}

/** Number of decimal places the currency's minor unit represents. */
export function minorUnitExponent(currency: CurrencyCode): number {
  assertCurrencyCode(currency);
  return EXPONENTS[currency] ?? DEFAULT_MINOR_UNIT_EXPONENT;
}

/** 10 ** exponent, as a bigint scale factor. */
export function minorUnitScale(currency: CurrencyCode): bigint {
  return 10n ** BigInt(minorUnitExponent(currency));
}

export enum MoneyErrorCode {
  InvalidCurrency = 'INVALID_CURRENCY',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InvalidAmount = 'INVALID_AMOUNT',
  NegativeAmount = 'NEGATIVE_AMOUNT',
  InvalidFxRate = 'INVALID_FX_RATE',
}

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}
