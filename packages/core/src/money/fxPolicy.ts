/**
 * Where an expense's rate comes from, and how it is shown to somebody.
 *
 * A rate has to be entered once, not once per bill. Three tiers hold one, most
 * specific first:
 *
 *   - **this bill** — a rate typed on the expense itself, for the meal the card
 *     happened to convert differently;
 *   - **your rate** — what this person's own card gives, private to them, used
 *     for the expenses they enter;
 *   - **the trip rate** — one number an admin pins on the group, so everybody's
 *     entries and the trip's budgets are counted the same way.
 *
 * Resolution happens once, when the expense is written, and the winner is stored
 * on the expense version (ADR-003). That is the whole reason changing a trip
 * rate next week cannot move last week's balances: the bill already carries the
 * rate it was written with, and nothing here ever rewrites one.
 */

import { type CurrencyCode } from './currency';
import { fxRate, type FxRate, type FxRecord, fromFxRecord } from './fx';

/** Which tier a rate came from. Ordered least to most specific. */
export enum FxTier {
  /** Pinned on the group by an admin; everybody sees it. */
  Trip = 'trip',
  /** This person's own default for this pair, private to their device. */
  Personal = 'personal',
  /** Typed on this bill alone. */
  Expense = 'expense',
}

/** A rate offered by each tier. Any of them may be absent. */
export interface FxTierRates {
  readonly trip?: FxRate | null;
  readonly personal?: FxRate | null;
  readonly expense?: FxRate | null;
}

/** The rate that wins, and which tier it came from. */
export interface ResolvedFx {
  readonly rate: FxRate;
  readonly tier: FxTier;
}

/**
 * The most specific rate that actually converts this pair.
 *
 * A tier holding a rate for a *different* pair is not a worse answer, it is a
 * wrong one — a trip rate for THB does not convert a bill paid in VND — so it
 * is skipped rather than used, and the next tier down gets its turn.
 */
export function resolveFxRate(
  tiers: FxTierRates,
  from: CurrencyCode,
  to: CurrencyCode,
): ResolvedFx | null {
  const ordered: readonly [FxTier, FxRate | null | undefined][] = [
    [FxTier.Expense, tiers.expense],
    [FxTier.Personal, tiers.personal],
    [FxTier.Trip, tiers.trip],
  ];
  for (const [tier, rate] of ordered) {
    if (rate && rate.from === from && rate.to === to) return { rate, tier };
  }
  return null;
}

/**
 * Two rates are the same rate when they convert identically — 9125/100 and
 * 18250/200 are one number written twice. Compared by cross-multiplication
 * rather than by decimal text, which would call them different at the sixth
 * place and is exactly the sort of thing that makes a label flicker.
 */
export function sameRate(a: FxRate, b: FxRate): boolean {
  return a.from === b.from && a.to === b.to && a.num * b.den === b.num * a.den;
}

/**
 * Which tier a *stored* rate should be labelled as, now.
 *
 * Derived by comparison rather than read from a stamp on the record, and that is
 * deliberate. A bill written at the trip rate, after an admin moves the trip
 * rate, is no longer at the trip rate — a stamp would keep insisting it was.
 * Comparing says the true thing: it matches the trip's number, or it does not
 * and is this bill's own.
 */
export function fxTierOf(stored: FxRate, tiers: FxTierRates): FxTier {
  if (tiers.trip && sameRate(stored, tiers.trip)) return FxTier.Trip;
  if (tiers.personal && sameRate(stored, tiers.personal)) return FxTier.Personal;
  return FxTier.Expense;
}

/**
 * The group's pinned rates as stored in `groups.fx_rates`: a map keyed by the
 * currency paid in, converting to the group's own `default_currency`.
 *
 * A map rather than a single rate because one trip crosses borders — Vietnam
 * then Cambodia is two rates on one group — and the same shape as the
 * `category_budgets` map already on that row.
 */
export type GroupFxRates = Readonly<Record<string, Omit<FxRecord, 'from' | 'to'>>>;

/**
 * The group's pinned rate for one pair, or null if it has none.
 *
 * `to` is not stored per entry — it is always the group's settle currency — so
 * it is supplied here and written onto the rate that comes back.
 */
export function groupFxRate(
  rates: GroupFxRates | null | undefined,
  from: CurrencyCode,
  to: CurrencyCode,
): FxRate | null {
  if (!rates || from === to) return null;
  const entry = rates[from];
  if (!entry) return null;
  try {
    return fromFxRecord({ ...entry, from, to });
  } catch {
    // A malformed entry is a rate we do not have, never a crash on the screen
    // that has to render the bill anyway.
    return null;
  }
}

/** One entry, ready to be written into the group's map under `rate.from`. */
export function toGroupFxEntry(rate: FxRate): Omit<FxRecord, 'from' | 'to'> {
  return { num: rate.num.toString(), den: rate.den.toString(), ts: rate.ts, source: rate.source };
}

/**
 * The rate stated the way somebody holds it in their head.
 *
 * "1 VND = 0.0032 INR" is arithmetically fine and humanly useless: nobody
 * carries four leading zeros around. The same fact as "1 ₹ = ₫312" is instantly
 * checkable against what they already know. So whenever a unit of the currency
 * paid in is worth less than a unit of the currency settled in, the rate is
 * turned around for display — and `inverted` says so, because the two ends have
 * to be labelled or the number is worse than no number.
 */
export function displayRate(rate: FxRate): { rate: FxRate; inverted: boolean } {
  const inverted = rate.num < rate.den;
  return {
    rate: inverted
      ? fxRate({
          num: rate.den,
          den: rate.num,
          from: rate.to,
          to: rate.from,
          ts: rate.ts,
          source: rate.source,
        })
      : rate,
    inverted,
  };
}
