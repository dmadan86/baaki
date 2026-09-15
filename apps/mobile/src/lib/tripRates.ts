/**
 * The trip's own exchange rates, as the screens need them (ADR-003, extended).
 *
 * The engine — which tier wins, how a stored rate is labelled, how a rate is
 * turned around so a person can read it — lives in `@waves/core`
 * (`money/fxPolicy`). This is the thin layer between that and a screen: the
 * group's pinned rates arrive from the mirror as rows, and a rate has to be
 * written as a sentence somebody can check against what they already know.
 *
 * Kept out of the component file so it can be tested without React Native.
 */

import {
  type CurrencyCode,
  currencySymbol,
  displayRate,
  fxRate,
  type FxRate,
  invertRate,
  isCurrencyCode,
  rateFromDecimal,
  rateToDecimal,
} from '@waves/core';

/**
 * A currency's mark, or nothing.
 *
 * `currencySymbol` falls back to the code when a currency has no symbol of its
 * own, which put "AED AED" and "SGD SGD" on the chips — a label that says the
 * same word twice reads as a bug even when it is only a fallback showing
 * through. Empty means the code can stand alone.
 */
export function currencyMark(code: string): string {
  const mark = currencySymbol(code);
  return mark === code ? '' : mark;
}

/**
 * A currency's name in the reader's own language — "Vietnamese dong" — or null
 * where the platform has no currency display names (older JSC builds, and a
 * locale ICU was trimmed for). Null means the code is all there is to show,
 * which is what the picker fell back to before it could show names at all.
 */
export function currencyName(code: string, locale: string): string | null {
  try {
    const names = Intl.DisplayNames as typeof Intl.DisplayNames | undefined;
    if (typeof names !== 'function') return null;
    const name = new names([locale], { type: 'currency' }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/** One pinned rate as `useGroupFxRates` hands it over. */
export interface TripRateRow {
  readonly from: string;
  readonly num: bigint;
  readonly den: bigint;
  /** When the rate was captured. Absent on a row written before it was kept. */
  readonly ts?: string;
  readonly source: string;
}

/**
 * The trip's rate for one pair, or null when the group has not pinned one.
 *
 * `to` is never stored per row — a pinned rate always converts into the group's
 * own settle currency — so it is supplied by the caller and written onto the
 * rate that comes back. A row for a different currency is not a worse answer
 * than none, it is a wrong one, so nothing else is offered as a substitute.
 */
export function tripRateFor(rows: readonly TripRateRow[], from: string, to: string): FxRate | null {
  if (from === to || !isCurrencyCode(from) || !isCurrencyCode(to)) return null;
  const row = rows.find((candidate) => candidate.from === from);
  if (!row) return null;
  try {
    return fxRate({
      num: row.num,
      den: row.den,
      from: from as CurrencyCode,
      to: to as CurrencyCode,
      ts: row.ts ?? new Date(0).toISOString(),
      source: row.source,
    });
  } catch {
    // A malformed row is a rate the group does not have, never a crash on the
    // screen that has to draw the rest of the settings anyway.
    return null;
  }
}

/**
 * How many decimal places a rate wants.
 *
 * "1 ₹ = ₫312.4400" is noise and "1 $ = ₹91" has thrown away the paise that
 * make the answer right, so the places follow the size of the number: a big
 * rate carries none, a small one carries enough to still be a rate at all.
 */
export function ratePlaces(value: number): number {
  if (!Number.isFinite(value)) return 2;
  if (value >= 100) return 0;
  if (value >= 10) return 2;
  return 4;
}

/**
 * A rate as one readable line: `1 ₹ = ₫312`.
 *
 * Turned around whenever the currency paid in is worth less than the currency
 * settled in, because "1 ₫ = ₹0.0032" is arithmetically fine and humanly
 * useless — nobody carries four leading zeros around. `displayRate` decides
 * which way round that is; this only writes it out.
 */
export function rateLine(rate: FxRate): string {
  const shown = displayRate(rate).rate;
  const places = ratePlaces(Number(shown.num) / Number(shown.den));
  return `1 ${currencySymbol(shown.from)} = ${currencySymbol(shown.to)}${rateToDecimal(shown, places)}`;
}

/**
 * The rate a typed number means, given which way round the person is typing.
 *
 * People hold a rate in whichever direction gives them a number bigger than
 * one — "312 dong to the rupee", "91 rupees to the dollar" — and which of those
 * it is depends on the pair, not on the app. So the editor offers both and this
 * turns either into the one shape storage accepts: paid-in currency to the
 * group's settle currency.
 */
export function rateFromTyped(
  value: string,
  foreign: CurrencyCode,
  home: CurrencyCode,
  homeFirst: boolean,
): FxRate | null {
  const text = value.trim();
  if (!text) return null;
  try {
    return homeFirst
      ? invertRate(rateFromDecimal(text, home, foreign))
      : rateFromDecimal(text, foreign, home);
  } catch {
    return null;
  }
}

/**
 * Which way round to open the editor on an existing rate: the direction that
 * puts the bigger number in the input, which is the one the person typed in the
 * first place.
 */
export function homeFirstFor(rate: FxRate): boolean {
  return displayRate(rate).inverted;
}

/**
 * The same rate written out for whichever way the input is pointing — the
 * number that belongs in the field, at a sensible number of places.
 *
 * A rate is one fact and the field states half of it; turning the field around
 * must not change the fact, so this reads off the stored rational rather than
 * re-parsing whatever text was there a moment ago.
 */
export function shownText(rate: FxRate, homeFirst: boolean): string {
  const num = homeFirst ? rate.den : rate.num;
  const den = homeFirst ? rate.num : rate.den;
  return rateToDecimal(
    {
      ...rate,
      num,
      den,
      from: homeFirst ? rate.to : rate.from,
      to: homeFirst ? rate.from : rate.to,
    },
    ratePlaces(Number(num) / Number(den)),
  );
}
