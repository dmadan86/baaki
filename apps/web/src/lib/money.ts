'use client';

import { format, type CurrencyCode } from '@baaki/core';

/**
 * Money is formatted by @baaki/core, not by this app.
 *
 * A second formatter is a second set of rounding rules, and the first time
 * they disagree is a person seeing ₹416.67 on their phone and ₹416.66 in a
 * browser and deciding one of us is stealing from them (ADR-003).
 */
export function money(minor: bigint, currency: string, locale = 'en-IN'): string {
  return format({ minor, currency: currency as CurrencyCode }, { locale });
}

/**
 * "you are owed" / "you owe", said out loud for a screen reader (TDR §11).
 *
 * The words come from the caller's `WebStrings.group` so the announcement is
 * in the page's language, not English underneath a Hindi number.
 */
export function balanceLabel(
  minor: bigint,
  currency: string,
  words: { isSettledUp: string; isOwed: string; owes: string },
  locale = 'en-IN',
): string {
  if (minor === 0n) return words.isSettledUp;
  const amount = money(minor < 0n ? -minor : minor, currency, locale);
  return minor > 0n ? `${words.isOwed} ${amount}` : `${words.owes} ${amount}`;
}
