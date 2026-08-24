/**
 * Categorising a *merchant string*, as it appears on a card statement or a
 * booking email — not the free-text a person typed.
 *
 * `guessCategory` (categories.ts) already reads a human description well: whole
 * tokens, Indian-first vocabulary, deterministic, null when it has nothing to
 * say. This module does not replace it — it feeds it. A statement line is a
 * different, noisier thing than "beach shack dinner":
 *
 *   * it is a brand, not a noun — "MAKEMYTRIP", "AGODA", "EMIRATES", "MARRIOTT".
 *     None of those are in the keyword catalog, and adding every airline and
 *     hotel chain to a ten-category chart's keyword lists would bloat them for
 *     a use they were not built for. So a supplemental **brand table** lives
 *     here, weighted toward the brands a *traveller* meets — airlines, OTAs,
 *     hotels, ride-hail, fuel — and is consulted first;
 *   * it carries gateway noise — "POS ", "UPI-", "IB/", trailing store numbers,
 *     "*ORDER1234". `normaliseMerchant` strips that so the brand underneath is
 *     what gets matched.
 *
 * When the brand table has nothing, it falls back to `guessCategory` over the
 * cleaned string, so anything the catalog already knew still works. The result
 * is `CategoryId | null`; null means "no opinion", never "Other" — the caller
 * leaves the chip alone rather than asserting a category nobody chose, exactly
 * as `guessCategory` does. Pure and deterministic: same string, same answer,
 * every device (ADR-009).
 */

import { CategoryId, guessCategory } from './categories';

/**
 * Gateway and rail noise that wraps a real merchant name on a statement. These
 * are stripped as whole tokens before matching so the brand underneath is what
 * the tables see; none of them is itself a category keyword, so removing them
 * only ever helps.
 */
const GATEWAY_NOISE = new Set<string>([
  'pos',
  'upi',
  'ib',
  'imps',
  'neft',
  'ach',
  'ecom',
  'ecommerce',
  'purchase',
  'payment',
  'pmt',
  'txn',
  'ref',
  'vps',
  'vpa',
  'paytm',
  'razorpay',
  'razp',
  'bharatpe',
  'phonepe',
  'gpay',
  'billdesk',
  'ccavenue',
  'pg',
  'in',
  'india',
  'pvt',
  'ltd',
  'llp',
  'inc',
  'co',
  'com',
]);

/**
 * Brands a card statement names that the ten-category keyword catalog does not
 * carry — the travel surface especially. Each maps a normalised whole token to
 * a built-in category. Kept lowercase; matched against normalised tokens, never
 * as substrings, so "air" in "airtel" is not read as an airline.
 */
const BRAND_CATEGORY: ReadonlyArray<readonly [string, CategoryId]> = [
  // Airlines
  ['emirates', CategoryId.Travel],
  ['etihad', CategoryId.Travel],
  ['qatar', CategoryId.Travel],
  ['lufthansa', CategoryId.Travel],
  ['klm', CategoryId.Travel],
  ['ryanair', CategoryId.Travel],
  ['easyjet', CategoryId.Travel],
  ['airasia', CategoryId.Travel],
  ['spicejet', CategoryId.Travel],
  ['goair', CategoryId.Travel],
  ['airindia', CategoryId.Travel],
  ['singaporeair', CategoryId.Travel],
  ['thai', CategoryId.Travel],
  ['cathay', CategoryId.Travel],
  ['jetblue', CategoryId.Travel],
  ['delta', CategoryId.Travel],
  ['united', CategoryId.Travel],
  // Online travel agents / rail / bus / transfers
  ['makemytrip', CategoryId.Travel],
  ['goibibo', CategoryId.Travel],
  ['cleartrip', CategoryId.Travel],
  ['ixigo', CategoryId.Travel],
  ['easemytrip', CategoryId.Travel],
  ['redbus', CategoryId.Travel],
  ['abhibus', CategoryId.Travel],
  ['grab', CategoryId.Travel],
  ['gojek', CategoryId.Travel],
  ['lyft', CategoryId.Travel],
  ['bolt', CategoryId.Travel],
  ['blablacar', CategoryId.Travel],
  ['shell', CategoryId.Travel],
  ['bpcl', CategoryId.Travel],
  ['hpcl', CategoryId.Travel],
  ['ioc', CategoryId.Travel],
  ['indianoil', CategoryId.Travel],
  ['zoomcar', CategoryId.Travel],
  ['revv', CategoryId.Travel],
  // Stays / hotels / OTAs weighted to lodging
  ['booking', CategoryId.Stay],
  ['agoda', CategoryId.Stay],
  ['expedia', CategoryId.Stay],
  ['trivago', CategoryId.Stay],
  ['hostelworld', CategoryId.Stay],
  ['marriott', CategoryId.Stay],
  ['hilton', CategoryId.Stay],
  ['hyatt', CategoryId.Stay],
  ['radisson', CategoryId.Stay],
  ['novotel', CategoryId.Stay],
  ['ibis', CategoryId.Stay],
  ['taj', CategoryId.Stay],
  ['itc', CategoryId.Stay],
  ['leela', CategoryId.Stay],
  ['zostel', CategoryId.Stay],
  ['fabhotels', CategoryId.Stay],
  ['lemontree', CategoryId.Stay],
  // Food delivery / cafes not already in the catalog
  ['ubereats', CategoryId.Food],
  ['deliveroo', CategoryId.Food],
  ['grabfood', CategoryId.Food],
  ['foodpanda', CategoryId.Food],
  ['costa', CategoryId.Food],
  ['barista', CategoryId.Food],
  ['ccd', CategoryId.Food],
  // Shopping / marketplaces
  ['aliexpress', CategoryId.Shopping],
  ['shein', CategoryId.Shopping],
  ['zara', CategoryId.Shopping],
  ['uniqlo', CategoryId.Shopping],
  ['lifestyle', CategoryId.Shopping],
  ['shoppersstop', CategoryId.Shopping],
  ['croma', CategoryId.Shopping],
  ['reliancedigital', CategoryId.Shopping],
  // Entertainment / activities
  ['getyourguide', CategoryId.Entertainment],
  ['viator', CategoryId.Entertainment],
  ['klook', CategoryId.Entertainment],
  ['ticketmaster', CategoryId.Entertainment],
  ['districtbyzomato', CategoryId.Entertainment],
];

const BRAND_MAP = new Map<string, CategoryId>(BRAND_CATEGORY);

/**
 * Split a merchant string into lowercase whole tokens, Unicode-aware, dropping
 * gateway noise and pure-digit runs (store numbers, terminal ids). Mirrors the
 * tokeniser `guessCategory` uses so the two agree on what a "word" is.
 */
export function merchantTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !/^\d+$/.test(token) && !GATEWAY_NOISE.has(token));
}

/**
 * A cleaned merchant string: gateway noise and digit runs removed, collapsed to
 * single spaces. Useful both for matching and for showing the person a tidier
 * name than "POS UPI SWIGGY*ORDER 8842".
 */
export function normaliseMerchant(raw: string): string {
  return merchantTokens(raw).join(' ');
}

/**
 * The category for a merchant string, or null when nothing is recognised.
 *
 * The brand table wins first (a traveller's airlines and hotels the catalog
 * does not carry); then `guessCategory` over the cleaned string catches
 * everything the catalog already knew. `countryCode` is passed straight through
 * to add that market's vocabulary, exactly as `guessCategory` documents.
 */
export function categoriseMerchant(
  text: string | null | undefined,
  countryCode?: string | null,
): CategoryId | null {
  if (!text) return null;
  const tokens = merchantTokens(text);
  if (tokens.length === 0) return null;

  // Brand table first. Scan tokens in order; the earliest brand hit wins, which
  // keeps the answer stable regardless of how many brands a noisy line names.
  for (const token of tokens) {
    const brand = BRAND_MAP.get(token);
    if (brand) return brand;
  }

  return guessCategory(tokens.join(' '), countryCode);
}
