/**
 * The invite-QR scanner, kept behind a runtime check.
 *
 * `expo-camera` is a native module. On a JS-only reload of an older dev-client
 * — one built before the module was installed — importing its `CameraView`
 * eagerly would reach for a native view that is not there. So nothing here
 * imports `expo-camera`; callers ask `cameraAvailable()` first and only mount
 * the camera leaf when the answer is yes, showing a "rebuild the app" notice
 * otherwise. Same discipline the document scanner uses (see `scanner.ts`).
 */

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/** Whether this binary actually contains the camera module. False on web, and
 *  on any dev-client built before `expo-camera` was added. */
export function cameraAvailable(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  return requireOptionalNativeModule('ExpoCamera') != null;
}

/**
 * The invite token out of whatever the camera read.
 *
 * A Waves invite QR encodes the join URL (`https://baaki.app/join?token=…`, or
 * the `waves://join?token=…` deep link). We only trust a value that carries a
 * `token` query on a join URL; a random QR from a poster is not an invite, and
 * returns null so the screen can say so rather than routing nowhere.
 */
export function tokenFromScan(data: string): string | null {
  const text = data.trim();
  if (!text) return null;
  // Must look like our join link, not just any string that happens to carry a
  // token= pair.
  if (!/\/join\b/i.test(text) && !/^waves:\/\/join\b/i.test(text)) return null;
  const match = text.match(/[?&]token=([^&\s]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
