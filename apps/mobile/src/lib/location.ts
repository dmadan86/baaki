/**
 * Attaching where a spend happened (A43).
 *
 * Three decisions, each easy to get wrong in a way nobody notices:
 *
 * **Permission is never asked for on launch, and never in the background.** A
 * money app that opens with "Waves would like to use your location" gets denied,
 * and on iOS a denial is close to permanent. So the prompt happens only when the
 * person taps "Add location", having read what it is for — the deferred model
 * `push.ts` uses. When-in-use only; nothing here ever tracks.
 *
 * **The native module is loaded lazily.** `expo-location` is a native module and
 * is absent on web (the repo's visual-check surface) and in a build that did not
 * link it. A static import would take the whole app down at launch; a `require`
 * behind a try means a missing module is simply "location unavailable", and the
 * expense saves without one exactly as before this feature existed.
 *
 * **Nothing here throws.** Reading a fix is a hardware call that fails for
 * reasons that have nothing to do with the person — airplane mode, no GPS lock,
 * a simulator with no location set. Failures come back as a reason the caller
 * can show, not as an unhandled rejection.
 */

import { Platform } from 'react-native';

import type { ExpenseLocation } from '@waves/core';

/** Whether this platform can read a location at all (native only, not web). */
export const locationSupported = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * The `expo-location` surface this module uses, loaded lazily so a build without
 * the native module — or web — degrades to "unavailable" instead of crashing at
 * launch (the native-module rule). Typed narrowly to what is called here.
 */
interface ExpoLocation {
  getForegroundPermissionsAsync(): Promise<{ status: string; canAskAgain: boolean }>;
  requestForegroundPermissionsAsync(): Promise<{ status: string; canAskAgain: boolean }>;
  getCurrentPositionAsync(options?: {
    accuracy?: number;
  }): Promise<{ coords: { latitude: number; longitude: number } }>;
  reverseGeocodeAsync(location: {
    latitude: number;
    longitude: number;
  }): Promise<LocationGeocodedAddress[]>;
  Accuracy: { Balanced: number };
}

interface LocationGeocodedAddress {
  name?: string | null;
  street?: string | null;
  district?: string | null;
  subregion?: string | null;
  city?: string | null;
  region?: string | null;
}

/**
 * Whether the `ExpoLocation` native module is linked into this binary.
 *
 * Expo modules register on the JSI host object (`globalThis.expo.modules`) as
 * the app starts. Reading it is a plain property lookup that cannot throw —
 * unlike `require('expo-location')`, which evaluates ExpoLocation.js and calls
 * `requireNativeModule('ExpoLocation')`, throwing on a binary that never linked
 * it (a stale dev client, most often). In dev that throw is surfaced as a redbox
 * even when caught, so a try around the require is not enough on its own; this
 * check keeps us from ever requiring the wrapper when the module is not there.
 * Kept dependency-free (no `expo-modules-core` import) for the same reason the
 * scanner is: nothing loaded here may fail.
 */
function locationModuleLinked(): boolean {
  const host = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo;
  return host?.modules?.ExpoLocation != null;
}

/**
 * Whether a location can actually be read on this device right now: a native
 * platform *and* the `ExpoLocation` module linked into this binary. The UI gates
 * on this (not `locationSupported`) so a stale build shows no add-location
 * button rather than one that taps to nothing — `captureLocation` would return
 * `Unsupported`, which the field deliberately swallows.
 */
export function locationAvailable(): boolean {
  return locationSupported && locationModuleLinked();
}

function loadLocation(): ExpoLocation | null {
  if (!locationSupported || !locationModuleLinked()) return null;
  try {
    // Lazy so a build that did not link the module fails soft, not at launch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-location') as ExpoLocation;
  } catch {
    return null;
  }
}

export enum LocationPermission {
  Granted = 'granted',
  Denied = 'denied',
  Undetermined = 'undetermined',
}

/** The current permission, without asking. `Denied` also covers "no module". */
export async function locationPermission(): Promise<LocationPermission> {
  const Location = loadLocation();
  if (!Location) return LocationPermission.Denied;
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    return status === 'granted'
      ? LocationPermission.Granted
      : status === 'undetermined'
        ? LocationPermission.Undetermined
        : LocationPermission.Denied;
  } catch {
    return LocationPermission.Denied;
  }
}

/** Why attaching a location did not happen. Only `denied` is the person's doing. */
export enum LocationFailure {
  /** Web, or a build with no location module — nothing to read. */
  Unsupported = 'unsupported',
  /** They said no, which is an answer. Route them to Settings if it stuck. */
  Denied = 'denied',
  /** Permission is there but no fix came back — no GPS lock, a bare simulator. */
  Unavailable = 'unavailable',
}

export type LocationResult =
  | { readonly ok: true; readonly location: ExpenseLocation }
  | { readonly ok: false; readonly why: LocationFailure };

/**
 * Build a short, human place name out of a reverse-geocode. A point-of-interest
 * name plus the city ("Third Wave Coffee, Indiranagar") reads better than a full
 * postal address, so this takes the most specific label and the locality and
 * drops the rest. Empty when the lookup gave nothing usable — the caller then
 * keeps the coordinates and shows them on a map.
 */
function placeName(address: LocationGeocodedAddress | undefined): string | null {
  if (!address) return null;
  const specific = address.name?.trim() || address.street?.trim() || '';
  const locality =
    address.district?.trim() ||
    address.city?.trim() ||
    address.subregion?.trim() ||
    address.region?.trim() ||
    '';
  // Dedupe when the specific label already is the locality (a plain area pin).
  const unique = [...new Set([specific, locality].filter(Boolean))];
  const name = unique.join(', ');
  return name.length > 0 ? name.slice(0, 120) : null;
}

/**
 * Ask (once, just-in-time), read the current fix, and name it.
 *
 * A refusal comes back as `denied` — an answer, not an error. Reverse-geocoding
 * is best-effort: if it fails or runs offline the coordinates still come back
 * with a null name, because a point on a map is worth more than nothing.
 */
export async function captureLocation(): Promise<LocationResult> {
  const Location = loadLocation();
  if (!Location) return { ok: false, why: LocationFailure.Unsupported };

  try {
    const existing = await Location.getForegroundPermissionsAsync();
    const status =
      existing.status === 'granted'
        ? existing.status
        : (await Location.requestForegroundPermissionsAsync()).status;
    if (status !== 'granted') return { ok: false, why: LocationFailure.Denied };

    const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const lat = fix.coords.latitude;
    const lng = fix.coords.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, why: LocationFailure.Unavailable };
    }

    let name: string | null = null;
    try {
      const addresses = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      name = placeName(addresses[0]);
    } catch {
      name = null;
    }

    return { ok: true, location: { lat, lng, name } };
  } catch {
    return { ok: false, why: LocationFailure.Unavailable };
  }
}

/** A deep link that opens the point in whatever maps app the phone prefers. */
export function mapsUrl(location: ExpenseLocation): string {
  const query = `${location.lat},${location.lng}`;
  const label = location.name ? encodeURIComponent(location.name) : query;
  return Platform.OS === 'ios'
    ? `https://maps.apple.com/?q=${label}&ll=${query}`
    : `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/** What to show for a location that has no name: a trimmed coordinate pair. */
export function coordLabel(location: ExpenseLocation): string {
  return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`;
}
