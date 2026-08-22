/**
 * The currency a new expense, group or IOU should start on for the person
 * holding the phone.
 *
 * Signed in, this is their account currency — `profiles.default_currency`, set
 * from the country they chose on "Your account" (see `currencyForCountry`). So
 * a user in Dubai gets AED everywhere without setting it per group, and one who
 * moves and changes their country moves the default with them. Before there is
 * a profile (a guest, or the split second before it loads) it falls back to the
 * phone's own region — the same guess `deviceDefaultCurrency` has always made.
 *
 * Always a default, never a lock: every group and every expense can still be
 * counted in something else.
 */

import type { CurrencyCode } from '@waves/core';
import { currencyForCountry } from '@waves/core';

import { deviceDefaultCurrency } from '@/i18n';
import { useAuth } from '@/lib/auth';

export function useDefaultCurrency(): CurrencyCode {
  const { profile } = useAuth();
  if (profile) {
    // `default_currency` is set from the country and always present, but guard
    // an unexpected empty string, and cross-check the country in case an older
    // row never had its currency written.
    return (
      (profile.default_currency as CurrencyCode) ||
      currencyForCountry(profile.country_code) ||
      deviceDefaultCurrency()
    );
  }
  return deviceDefaultCurrency();
}
