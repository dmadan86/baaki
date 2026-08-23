/**
 * Reading where a spend happened, in the browser (A43).
 *
 * Unlike the phone, the web has no on-device reverse-geocoder, and calling an
 * external one would send the point to a third party — against the on-device
 * privacy stance the mobile app holds. So the web stores coordinates only
 * (`name: null`); the expense detail shows the point and a maps link, and if the
 * same expense is opened on the phone its name can be filled there. Permission is
 * the browser's own just-in-time prompt, asked only when the person clicks.
 */

import type { ExpenseLocation } from '@waves/core';

export const geolocationSupported = typeof navigator !== 'undefined' && 'geolocation' in navigator;

export enum LocationFailure {
  /** No Geolocation API — an old browser, or an insecure (non-HTTPS) origin. */
  Unsupported = 'unsupported',
  /** They said no, which is an answer. */
  Denied = 'denied',
  /** Permission is there but no fix came back — no signal, a desktop with none. */
  Unavailable = 'unavailable',
}

export type LocationResult =
  | { readonly ok: true; readonly location: ExpenseLocation }
  | { readonly ok: false; readonly why: LocationFailure };

/**
 * Ask (once, just-in-time via the browser) and read the current fix. Never
 * throws: a refusal comes back as `denied`, any other trouble as `unavailable`,
 * so the caller shows a message rather than catching. Coordinates only — the
 * name is left null (see the module note).
 */
export function captureLocation(): Promise<LocationResult> {
  if (!geolocationSupported) {
    return Promise.resolve({ ok: false, why: LocationFailure.Unsupported });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          resolve({ ok: false, why: LocationFailure.Unavailable });
          return;
        }
        resolve({ ok: true, location: { lat: latitude, lng: longitude, name: null } });
      },
      (error) => {
        resolve({
          ok: false,
          why:
            error.code === error.PERMISSION_DENIED
              ? LocationFailure.Denied
              : LocationFailure.Unavailable,
        });
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  });
}

/** A link that opens the point in Google Maps in a new tab. */
export function mapsUrl(location: ExpenseLocation): string {
  return `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;
}

/** What to show for a coordinate pair with no name: a trimmed lat/lng. */
export function coordLabel(location: ExpenseLocation): string {
  return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`;
}
