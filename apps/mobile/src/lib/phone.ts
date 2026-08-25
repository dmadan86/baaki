/**
 * Reading a phone number the way the phone's own messaging apps do.
 *
 * The core rule (`normalisePhone`) refuses a number with no country code — the
 * right call for a sign-in field, where a silent `+91` on a friend's foreign
 * number would send the invite to a stranger. But adding a friend by their
 * local number is the everyday case, and every messaging app on the device
 * already solves it the same way: the number is read in *your* region, not
 * guessed. This is the mobile side of that — it turns the account or device
 * country into a dialing code and hands it to the pure core helper, so nothing
 * with a bare, unroutable number is ever queued for the server to refuse.
 *
 * There is still no blind default: when neither the account nor the device
 * names a region, `regionDialCode` returns null and the core helper falls back
 * to its honest refusal, which the caller turns into a friendly ask for the
 * country code rather than a raw internal error.
 */

import { dialingCodeForCountry, IdentityError, normalisePhoneInRegion } from '@waves/core';

import { deviceCountry } from '@/i18n';

/**
 * The dialing code to read a bare national number in, or null.
 *
 * The account country (set on "Your account") is preferred over the device's
 * region — someone travelling keeps their home region — and the device is the
 * fallback. Null means neither could be determined, i.e. no region to borrow a
 * country code from; the caller must then require an explicit one.
 */
export function regionDialCode(accountCountry?: string | null): string | null {
  return dialingCodeForCountry(accountCountry ?? deviceCountry());
}

/**
 * An optional contact phone, normalised to E.164 in the caller's region.
 *
 * Empty stays empty (a contact may be an email only). A number with its own
 * country code is kept as typed; a bare national number is read in the resolved
 * region. Throws `IdentityError` when there is no region and no country code, or
 * when the result is not a valid number — the caller decides how to say so.
 */
export function normaliseContactPhone(
  phone: string | null | undefined,
  accountCountry?: string | null,
): string | null {
  const raw = phone?.trim();
  if (!raw) return null;
  return normalisePhoneInRegion(raw, regionDialCode(accountCountry));
}

/**
 * Whether an error — a thrown `IdentityError` at entry, or a server refusal
 * folded into the sync queue — is the "this number needs a country code / is
 * not a valid number" case, so a screen can show the one friendly, localized
 * sentence that helps rather than a raw internal code.
 */
export function isPhoneCountryError(caught: unknown): boolean {
  if (caught instanceof IdentityError) {
    return caught.code === 'PHONE_NEEDS_COUNTRY_CODE' || caught.code === 'PHONE_NOT_VALID';
  }
  const parts = caught as { code?: unknown; message?: unknown } | null;
  const haystack = `${typeof parts?.code === 'string' ? parts.code : ''} ${
    typeof parts?.message === 'string' ? parts.message : ''
  }`;
  return /PHONE_NEEDS_COUNTRY_CODE|PHONE_NOT_VALID/.test(haystack);
}
