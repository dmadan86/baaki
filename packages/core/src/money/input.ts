/**
 * Turning what somebody types into money, and back.
 *
 * Every money field in the app faces the same three problems: a keystroke can
 * be junk ("1..2", "₹", "abc"), a half-typed number is legitimate ("12." is
 * somebody on their way to "12.50"), and the currency decides how many decimal
 * places exist at all — JPY has none, so a dot in a yen field is not a
 * separator, it is a mistake.
 *
 * This lived privately inside the amount field until a bill could be paid by
 * several people, at which point the same parsing had to happen in a row of
 * per-payer fields too. Two copies of "how many decimal places does this
 * currency have" is how a ₹10.5 becomes 105 paise on one screen and 1050 on
 * another, so there is one copy, here, and it is integer-only: the value handed
 * back is minor units and never passes through a float.
 */

import { minorUnitExponent, minorUnitScale, type CurrencyCode } from './currency';

/**
 * Clean one keystroke's worth of text: digits, and at most one decimal point in
 * a currency that has decimal places at all. Trailing digits past the
 * currency's precision are dropped rather than rounded — rounding what is still
 * being typed moves the caret out from under somebody's thumb.
 *
 * Returns text, not a number, because the field has to be able to show "12."
 * while it waits for the rest.
 */
export function sanitiseMinorInput(raw: string, currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  let cleaned = raw.replace(/[^0-9.]/g, '');

  if (exponent === 0) {
    return cleaned.replace(/\./g, '').replace(/^0+(?=\d)/, '');
  }

  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }
  // Drop a leading zero once real digits follow, but keep the "0" of "0.50".
  cleaned = cleaned.replace(/^0+(?=\d)/, '');

  const [, fraction = ''] = cleaned.split('.');
  if (fraction.length > exponent) {
    cleaned = cleaned.slice(0, cleaned.length - (fraction.length - exponent));
  }
  return cleaned;
}

/**
 * Typed text as minor units. An empty field, or a lone dot, is zero rather than
 * an error: it is somebody who has not finished, and a form mid-edit is not a
 * validation failure. Assumes the text has been through `sanitiseMinorInput`;
 * anything non-numeric that survives is ignored rather than becoming NaN.
 */
export function parseMinorInput(text: string, currency: CurrencyCode): bigint {
  const cleaned = sanitiseMinorInput(text, currency);
  if (cleaned === '' || cleaned === '.') return 0n;
  const exponent = minorUnitExponent(currency);
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const padded = fraction.slice(0, exponent).padEnd(exponent, '0');
  return BigInt(whole || '0') * minorUnitScale(currency) + BigInt(padded === '' ? '0' : padded);
}

/**
 * Minor units as the text a field should show. Zero comes back empty so the
 * placeholder shows through instead of a literal "0" somebody has to delete
 * before typing. Negative input is rendered by magnitude — no money field in
 * this app can express a negative, and printing a minus that cannot be typed
 * back would make the field un-round-trippable.
 */
export function formatMinorInput(minor: bigint, currency: CurrencyCode): string {
  if (minor === 0n) return '';
  const exponent = minorUnitExponent(currency);
  const scale = minorUnitScale(currency);
  const abs = minor < 0n ? -minor : minor;
  const whole = (abs / scale).toString();
  if (exponent === 0) return whole;
  return `${whole}.${(abs % scale).toString().padStart(exponent, '0')}`;
}
