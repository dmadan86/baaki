/**
 * FX conversion (ADR-003): every conversion stores the exact rational rate and
 * its provenance, so any conversion can be reproduced byte-for-byte later.
 */

import { MoneyError, minorUnitExponent, type CurrencyCode } from './currency.js';
import { divideRoundHalfAwayFromZero, money, type Money } from './money.js';

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
    throw new MoneyError('INVALID_FX_RATE', 'FX rate numerator and denominator must be positive');
  }
  if (rate.from === rate.to) {
    throw new MoneyError('INVALID_FX_RATE', 'FX rate must convert between two different currencies');
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
      'CURRENCY_MISMATCH',
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
