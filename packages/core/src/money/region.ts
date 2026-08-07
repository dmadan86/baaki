/**
 * What a country spends.
 *
 * A group created in Dubai defaulting to rupees is the sort of small wrongness
 * that makes an app feel like it was written for somewhere else — which, until
 * now, it was. The currency is only ever a *default*: every group can change
 * it, every expense can override it, and nothing here decides what anything is
 * worth. It decides what the picker starts on.
 *
 * Not a complete list of the world. It covers the markets Baaki is going to and
 * the ones its users travel between, and everything else falls back to the
 * caller's own default rather than to a guess. A wrong currency is worse than
 * no opinion: `INR` on a group in Berlin gets typed over once, but a plausible
 * wrong guess gets missed.
 */

import type { CurrencyCode } from './currency';

const CURRENCY_BY_COUNTRY: Readonly<Record<string, CurrencyCode>> = {
  // India, and the markets it exports people to.
  IN: 'INR',
  AE: 'AED',
  SA: 'SAR',
  QA: 'QAR',
  KW: 'KWD',
  BH: 'BHD',
  OM: 'OMR',

  // Where the rails already fit.
  BR: 'BRL',
  SG: 'SGD',
  ID: 'IDR',
  TH: 'THB',
  MY: 'MYR',
  PH: 'PHP',
  VN: 'VND',

  // Where people travel from and to.
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AU: 'AUD',
  NZ: 'NZD',
  JP: 'JPY',
  CH: 'CHF',
  LK: 'LKR',
  NP: 'NPR',
  BD: 'BDT',
  PK: 'PKR',

  // The euro, spelled out per country rather than inferred — there is no rule
  // that maps a country to a currency, only a list, and pretending otherwise
  // puts euros in Poland.
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  IE: 'EUR',
  AT: 'EUR',
  BE: 'EUR',
  GR: 'EUR',
  FI: 'EUR',
};

/**
 * The currency a group in this country most likely counts in, or null.
 *
 * Null means "no opinion" and the caller should keep whatever default it
 * already had. It is deliberately not a fallback to USD: an unrecognised
 * country is not an American one.
 */
export function currencyForCountry(countryCode: string | null | undefined): CurrencyCode | null {
  const country = (countryCode ?? '').trim().toUpperCase();
  return CURRENCY_BY_COUNTRY[country] ?? null;
}

/** Whether this looks like an ISO-3166 alpha-2 code at all. */
export function isCountryCode(value: string | null | undefined): boolean {
  return /^[A-Za-z]{2}$/.test((value ?? '').trim());
}

/**
 * The countries worth showing in a picker, most relevant first.
 *
 * Ordered rather than alphabetical: somebody in the Gulf should not scroll past
 * forty countries to find theirs, and the app knows which markets it is for.
 */
export const COUNTRIES: readonly { code: string; name: string }[] = [
  { code: 'IN', name: 'India' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'QA', name: 'Qatar' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'BH', name: 'Bahrain' },
  { code: 'OM', name: 'Oman' },
  { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'TH', name: 'Thailand' },
  { code: 'PH', name: 'Philippines' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'NP', name: 'Nepal' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'BR', name: 'Brazil' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'PT', name: 'Portugal' },
  { code: 'IE', name: 'Ireland' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'JP', name: 'Japan' },
];

export function countryName(countryCode: string | null | undefined): string | null {
  const country = (countryCode ?? '').trim().toUpperCase();
  return COUNTRIES.find((entry) => entry.code === country)?.name ?? null;
}
