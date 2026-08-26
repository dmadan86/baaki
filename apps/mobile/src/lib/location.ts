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
  getLastKnownPositionAsync(): Promise<{
    coords: { latitude: number; longitude: number };
  } | null>;
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
 * A position fix that neither hangs nor gives up too easily.
 *
 * A fresh GPS read is raced against a short timeout — indoors or on a cold
 * receiver it can otherwise block for tens of seconds, or never resolve — and if
 * it loses, the last known fix is used instead. Either is good enough to name a
 * place and drop a pin, and the point is to come back with *something* far more
 * often than a bare `getCurrentPositionAsync` does, which is what left the field
 * empty when a spend was logged indoors. `null` only when neither is available.
 */
async function readPosition(
  Location: ExpoLocation,
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    if (fresh?.coords) return fresh.coords;
  } catch {
    // A hardware failure on the fresh read is not the end — try the cache below.
  }
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last?.coords) return last.coords;
  } catch {
    // Nothing usable; the caller reports "unavailable".
  }
  return null;
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

    const coords = await readPosition(Location);
    if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      return { ok: false, why: LocationFailure.Unavailable };
    }
    const lat = coords.latitude;
    const lng = coords.longitude;

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

/**
 * Read a fix *only if permission was already granted* — never prompting.
 *
 * This is what lets add-expense stamp the current place automatically: opening
 * the form must never throw up a system location prompt (the anti-pattern this
 * module exists to avoid), so a fix is read only when the person has already
 * said yes on an earlier explicit "Add location". Undetermined, denied, no
 * module, or no GPS lock all come back as `null`, and the expense saves with no
 * place exactly as before. Reverse-geocoding stays best-effort.
 */
export async function captureLocationIfGranted(): Promise<ExpenseLocation | null> {
  const Location = loadLocation();
  if (!Location) return null;
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return null; // deliberately never requests here
    const coords = await readPosition(Location);
    if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      return null;
    }
    const lat = coords.latitude;
    const lng = coords.longitude;
    let name: string | null = null;
    try {
      const addresses = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      name = placeName(addresses[0]);
    } catch {
      name = null;
    }
    return { lat, lng, name };
  } catch {
    return null;
  }
}

/**
 * Name an arbitrary point picked on the map — best-effort, `null` when the
 * lookup fails, runs offline, or the module is absent (the caller keeps the
 * coordinates and shows the point). Unlike {@link captureLocation} this reads no
 * GPS and asks for no permission: reverse geocoding a chosen coordinate does not
 * reveal where the person is.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const Location = loadLocation();
  if (!Location) return null;
  try {
    const addresses = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    return placeName(addresses[0]);
  } catch {
    return null;
  }
}

/**
 * A deep link that opens the point in Google Maps — the Google Maps app when it
 * is installed (this universal `/maps/search/` URL hands off to it on both iOS
 * and Android), else Google Maps in the browser. One provider on every platform,
 * rather than Apple Maps on iOS, so "open the map" is always the same place.
 */
export function mapsUrl(location: ExpenseLocation): string {
  const query = `${location.lat},${location.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/** What to show for a location that has no name: a trimmed coordinate pair. */
export function coordLabel(location: ExpenseLocation): string {
  return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`;
}
