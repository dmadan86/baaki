/**
 * What is free, what is paid, and what it costs where.
 *
 * ADR-011 is a constitutional rule and this file lives inside it: **manual
 * expense entry, groups, every split type, balances, settlement recording and
 * export are unlimited and free, forever.** No daily cap on the core loop, no
 * ads in a money flow. What is monetised is convenience — scan volume beyond
 * the free quota, depth in the analytics, auto-import, themes — and this list
 * is where that boundary is written down rather than remembered.
 *
 * Two things are *not* decided here.
 *
 * **The scan limit is enforced in SQL**, by `baaki_receipt_scan_quota()`. The
 * numbers below are the same numbers, kept here so a screen can say "300 scans"
 * without a round trip — but a client that disagreed with the database would
 * simply be wrong, and the database is what refuses the scan. A limit enforced
 * where the person can edit it is not a limit.
 *
 * **Prices are the store's**, not ours. Google Play and the App Store hold the
 * real price for every country, and they are what the person is charged. These
 * are the figures those products are configured with, used for display before
 * the store sheet opens; where they disagree, the store is right.
 */

import type { CurrencyCode } from '../money/currency';

export enum PlanTier {
  Free = 'free',
  Plus = 'plus',
}

export enum BillingPeriod {
  Monthly = 'monthly',
  Yearly = 'yearly',
  /** Bought once. India converts on one-time purchases where it will not on subscriptions. */
  Lifetime = 'lifetime',
  /**
   * One group, thirty days, bought by one person and enjoyed by everyone in it.
   *
   * The one that fits how Baaki is actually used: a Goa trip, a wedding, a
   * flatshare month. Asking somebody to subscribe annually for four trips a
   * year loses; ₹149 that also covers the five people they are travelling with
   * makes the buyer generous rather than out of pocket, and puts the paid
   * features in front of five people who did not buy.
   */
  TripPass = 'trip_pass',
}

export interface Price {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

/** Scans a month. The database enforces these; see the note at the top. */
export const FREE_MONTHLY_SCANS = 20;
export const PLUS_MONTHLY_SCANS = 300;

/**
 * Prices per country, in minor units.
 *
 * Not a conversion of one number — each market is priced at what it will bear.
 * ₹79 is about $0.95, and charging that in the United States would leave most
 * of the revenue on the floor; charging $4.99 in India would sell nothing.
 * That is the whole reason this is a table rather than an exchange rate.
 */
const PRICES: Readonly<Record<string, Readonly<Record<BillingPeriod, Price>>>> = {
  IN: {
    [BillingPeriod.Monthly]: { minor: 7900n, currency: 'INR' },
    [BillingPeriod.Yearly]: { minor: 69900n, currency: 'INR' },
    [BillingPeriod.Lifetime]: { minor: 199900n, currency: 'INR' },
    [BillingPeriod.TripPass]: { minor: 14900n, currency: 'INR' },
  },
  AE: {
    [BillingPeriod.Monthly]: { minor: 1499n, currency: 'AED' },
    [BillingPeriod.Yearly]: { minor: 12900n, currency: 'AED' },
    [BillingPeriod.Lifetime]: { minor: 34900n, currency: 'AED' },
    [BillingPeriod.TripPass]: { minor: 2900n, currency: 'AED' },
  },
  SA: {
    [BillingPeriod.Monthly]: { minor: 1499n, currency: 'SAR' },
    [BillingPeriod.Yearly]: { minor: 12900n, currency: 'SAR' },
    [BillingPeriod.Lifetime]: { minor: 34900n, currency: 'SAR' },
    [BillingPeriod.TripPass]: { minor: 2900n, currency: 'SAR' },
  },
  US: {
    [BillingPeriod.Monthly]: { minor: 499n, currency: 'USD' },
    [BillingPeriod.Yearly]: { minor: 3999n, currency: 'USD' },
    [BillingPeriod.Lifetime]: { minor: 9999n, currency: 'USD' },
    [BillingPeriod.TripPass]: { minor: 799n, currency: 'USD' },
  },
  CA: {
    [BillingPeriod.Monthly]: { minor: 699n, currency: 'CAD' },
    [BillingPeriod.Yearly]: { minor: 5499n, currency: 'CAD' },
    [BillingPeriod.Lifetime]: { minor: 13999n, currency: 'CAD' },
    [BillingPeriod.TripPass]: { minor: 1099n, currency: 'CAD' },
  },
  AU: {
    [BillingPeriod.Monthly]: { minor: 799n, currency: 'AUD' },
    [BillingPeriod.Yearly]: { minor: 5999n, currency: 'AUD' },
    [BillingPeriod.Lifetime]: { minor: 14999n, currency: 'AUD' },
    [BillingPeriod.TripPass]: { minor: 1199n, currency: 'AUD' },
  },
  BR: {
    [BillingPeriod.Monthly]: { minor: 1490n, currency: 'BRL' },
    [BillingPeriod.Yearly]: { minor: 12900n, currency: 'BRL' },
    [BillingPeriod.Lifetime]: { minor: 29900n, currency: 'BRL' },
    [BillingPeriod.TripPass]: { minor: 2490n, currency: 'BRL' },
  },
  GB: {
    [BillingPeriod.Monthly]: { minor: 399n, currency: 'GBP' },
    [BillingPeriod.Yearly]: { minor: 2999n, currency: 'GBP' },
    [BillingPeriod.Lifetime]: { minor: 7999n, currency: 'GBP' },
    [BillingPeriod.TripPass]: { minor: 599n, currency: 'GBP' },
  },
};

/**
 * The fallback for a country with no row of its own.
 *
 * US dollars, because that is what the stores default an unpriced country to —
 * not because an unrecognised country is American. Adding a market means adding
 * a row above and configuring the store, in that order.
 */
const DEFAULT_COUNTRY = 'US';

export function priceFor(countryCode: string | null | undefined, period: BillingPeriod): Price {
  const country = (countryCode ?? '').trim().toUpperCase();
  const table = PRICES[country] ?? PRICES[DEFAULT_COUNTRY]!;
  return table[period];
}

/** Every country priced by hand, for a test that checks none is half-filled. */
export const PRICED_COUNTRIES: readonly string[] = Object.keys(PRICES);

/**
 * What the person is actually entitled to, as the database resolved it.
 *
 * Comes from `baaki_my_plan()` and is never computed on the device. A client
 * that decided its own tier would be a client somebody could edit — the same
 * mistake as a policy that trusts a row to say who it belongs to.
 */
export interface Entitlement {
  readonly tier: PlanTier;
  /** ISO timestamp the entitlement lapses, or null for lifetime and free. */
  readonly until: string | null;
  /** How it was earned: their own purchase, or somebody's pass on this group. */
  readonly source: 'free' | 'subscription' | 'lifetime' | 'trip_pass';
  readonly scanLimit: number;
}

export const FREE_ENTITLEMENT: Entitlement = {
  tier: PlanTier.Free,
  until: null,
  source: 'free',
  scanLimit: FREE_MONTHLY_SCANS,
};

/**
 * Read what the database returned, and fall back to free on anything unexpected.
 *
 * Never throws and never guesses upward. A malformed reply, an offline launch,
 * a version of the app older than the column — all of them mean free, because
 * the failure mode of guessing the other way is giving away what somebody else
 * paid for, and the failure mode of this one is a paywall that clears itself on
 * the next successful call.
 */
export function readEntitlement(value: unknown): Entitlement {
  if (typeof value !== 'object' || value === null) return FREE_ENTITLEMENT;
  const row = value as Record<string, unknown>;

  const tier = row.tier === 'plus' ? PlanTier.Plus : PlanTier.Free;
  const source =
    row.source === 'subscription' || row.source === 'lifetime' || row.source === 'trip_pass'
      ? row.source
      : 'free';

  const limit = Number(row.scanLimit);
  return {
    tier,
    until: typeof row.until === 'string' ? row.until : null,
    // A free tier with a paid source, or the reverse, is a database that has
    // been edited by hand. Trust the tier and let the source be cosmetic.
    source: tier === PlanTier.Free ? 'free' : source === 'free' ? 'subscription' : source,
    scanLimit:
      Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : tier === PlanTier.Plus
          ? PLUS_MONTHLY_SCANS
          : FREE_MONTHLY_SCANS,
  };
}
