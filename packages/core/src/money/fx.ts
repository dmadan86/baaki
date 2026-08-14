/**
 * FX conversion (ADR-003): every conversion stores the exact rational rate and
 * its provenance, so any conversion can be reproduced byte-for-byte later.
 */

import { MoneyError, MoneyErrorCode, minorUnitExponent, type CurrencyCode } from './currency';
import { divideRoundHalfAwayFromZero, money, type Money } from './money';

export interface FxRate {
  /** Rate as an exact rational: 1 unit of `from` = num/den units of `to`. */
  readonly num: bigint;
  readonly den: bigint;
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** ISO-8601 instant the rate was captured. */
  readonly ts: string;
  /** Where the rate came from, e.g. "ecb", "manual". */
  readonly source: string;
}

export function fxRate(rate: FxRate): FxRate {
  if (rate.num <= 0n || rate.den <= 0n) {
    throw new MoneyError(
      MoneyErrorCode.InvalidFxRate,
      'FX rate numerator and denominator must be positive',
    );
  }
  if (rate.from === rate.to) {
    throw new MoneyError(
      MoneyErrorCode.InvalidFxRate,
      'FX rate must convert between two different currencies',
    );
  }
  return rate;
}

/**
 * Convert with exact rational math, then round half-away-from-zero once at the
 * end. Deterministic: same (amount, rate) always yields the same minor units on
 * every device and on the server.
 */
export function convert(amount: Money, rate: FxRate): Money {
  if (amount.currency !== rate.from) {
    throw new MoneyError(
      MoneyErrorCode.CurrencyMismatch,
      `Rate converts ${rate.from}→${rate.to}, but amount is ${amount.currency}`,
    );
  }
  const fromExponent = minorUnitExponent(rate.from);
  const toExponent = minorUnitExponent(rate.to);

  // minor_to = minor_from * num * 10^(to_exp) / (den * 10^(from_exp))
  const exponentDelta = toExponent - fromExponent;
  const scaleUp = exponentDelta > 0 ? 10n ** BigInt(exponentDelta) : 1n;
  const scaleDown = exponentDelta < 0 ? 10n ** BigInt(-exponentDelta) : 1n;

  const numerator = amount.minor * rate.num * scaleUp;
  const denominator = rate.den * scaleDown;

  return money(divideRoundHalfAwayFromZero(numerator, denominator), rate.to);
}

export function invertRate(rate: FxRate): FxRate {
  return fxRate({
    num: rate.den,
    den: rate.num,
    from: rate.to,
    to: rate.from,
    ts: rate.ts,
    source: rate.source,
  });
}

/** Serialised shape stored in `expense_versions.fx` (TDR §2). */
export interface FxRecord {
  num: string;
  den: string;
  from: CurrencyCode;
  to: CurrencyCode;
  ts: string;
  source: string;
}

export function toFxRecord(rate: FxRate): FxRecord {
  return {
    num: rate.num.toString(),
    den: rate.den.toString(),
    from: rate.from,
    to: rate.to,
    ts: rate.ts,
    source: rate.source,
  };
}

export function fromFxRecord(record: FxRecord): FxRate {
  return fxRate({
    num: BigInt(record.num),
    den: BigInt(record.den),
    from: record.from,
    to: record.to,
    ts: record.ts,
    source: record.source,
  });
}

/**
 * A rate typed as a decimal: "1 EUR = 91.25 INR" becomes 9125/100.
 *
 * Parsed as a string rather than a number because 91.25 is not representable in
 * binary floating point, and the whole point of storing a rational is that the
 * rate somebody typed is the rate that gets used a year later.
 */
export function rateFromDecimal(
  decimal: string,
  from: CurrencyCode,
  to: CurrencyCode,
  options: { ts?: string; source?: string } = {},
): FxRate {
  const trimmed = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(MoneyErrorCode.InvalidFxRate, `"${decimal}" is not a rate`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return fxRate({
    num: BigInt(whole + fraction),
    den: 10n ** BigInt(fraction.length),
    from,
    to,
    ts: options.ts ?? new Date().toISOString(),
    source: options.source ?? 'manual',
  });
}

/**
 * The rate implied by what you paid and what you were charged — "the meal was
 * €50 and my card statement says ₹4,562.50".
 *
 * This is the honest way to record a card transaction: the bank's rate already
 * includes its markup, so a mid-market rate fetched from anywhere would produce
 * a number that does not match anybody's statement. Deriving it from the two
 * amounts records what actually happened.
 */
export function rateFromAmounts(
  spent: Money,
  charged: Money,
  options: { ts?: string; source?: string } = {},
): FxRate {
  if (spent.minor <= 0n || charged.minor <= 0n) {
    throw new MoneyError(
      MoneyErrorCode.InvalidFxRate,
      'Both amounts must be positive to imply a rate',
    );
  }
  // Both sides are in minor units, so the exponents have to come back out or a
  // JPY↔INR rate would be wrong by a factor of a hundred.
  const spentExponent = minorUnitExponent(spent.currency);
  const chargedExponent = minorUnitExponent(charged.currency);
  const delta = spentExponent - chargedExponent;

  return fxRate({
    num: charged.minor * (delta > 0 ? 10n ** BigInt(delta) : 1n),
    den: spent.minor * (delta < 0 ? 10n ** BigInt(-delta) : 1n),
    from: spent.currency,
    to: charged.currency,
    ts: options.ts ?? new Date().toISOString(),
    source: options.source ?? 'implied',
  });
}

/** The rate as a decimal string, for showing back what was entered. */
export function rateToDecimal(rate: FxRate, places = 6): string {
  const scale = 10n ** BigInt(places);
  const scaled = divideRoundHalfAwayFromZero(rate.num * scale, rate.den);
  const text = scaled.toString().padStart(places + 1, '0');
  const whole = text.slice(0, text.length - places);
  const fraction = text.slice(text.length - places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Convert straight from what was stored on the expense. */
export function convertWithRecord(amount: Money, record: FxRecord): Money {
  return convert(amount, fromFxRecord(record));
}
