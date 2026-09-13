/**
 * The reason the hourly check quietly stops working, on about half of Android.
 *
 * Waves schedules its background read through WorkManager, which is the correct
 * and documented way to do it. On stock Android that is enough. On a large
 * number of shipping phones it is not: several manufacturers run their own
 * "battery optimisation" layer above the platform's, and its default behaviour
 * is to stop a backgrounded app's scheduled work altogether after a while —
 * sometimes within a day of the app last being opened. Nothing throws, nothing
 * is logged, and the job simply never runs again. FinArt warns about exactly
 * this, by name, on Vivo; it is the same problem on Xiaomi, Oppo, Realme,
 * OnePlus, Huawei, Honor, Samsung, Meizu, Tecno and Infinix.
 *
 * There is no API that reports it. `isIgnoringBatteryOptimizations` answers a
 * *different* question — the platform's own doze allowlist — and returns true
 * on a phone whose manufacturer layer will still kill the job. So this does the
 * only honest thing available: it names the manufacturers where the problem is
 * documented and widespread, tells the person what to change, and offers the
 * one screen that can change it. It is a warning, not a diagnosis, and the
 * wording on screen says so rather than claiming something is wrong.
 *
 * Why not just ask every phone? Because a warning everybody sees is a warning
 * nobody reads. Stock Android, Pixel, Nothing, Motorola and Sony do not have
 * this behaviour, and telling those people to go and change a setting that does
 * not affect them spends the credibility the warning needs on the phones where
 * it is true.
 */

import { Linking, Platform } from 'react-native';
import * as Device from 'expo-device';

/**
 * Manufacturers whose Android layer stops scheduled background work by default.
 *
 * Lower-cased, matched as a prefix of `Device.manufacturer` — the field is not
 * consistent across vendors ("Xiaomi", "XIAOMI", "Redmi" on some builds), so an
 * exact match would miss more than it caught.
 *
 * Sources for each of these are the manufacturers' own power-management
 * settings screens plus dontkillmyapp.com, which tracks the behaviour per
 * vendor. The list changes over time; a phone missing from it sees no warning,
 * which is the safe direction to be wrong in.
 */
const AGGRESSIVE = [
  'xiaomi',
  'redmi',
  'poco',
  'vivo',
  'iqoo',
  'oppo',
  'realme',
  'oneplus',
  'huawei',
  'honor',
  'samsung',
  'meizu',
  'tecno',
  'infinix',
  'itel',
  'asus',
  'lenovo',
  'blackview',
  'umidigi',
] as const;

/**
 * Is this a phone where the hourly check is likely to be stopped?
 *
 * False on iOS, on web, and on any phone this does not recognise. Never throws:
 * `Device.manufacturer` is null on some builds and on the simulator, and a
 * warning that crashed the screen it was warning on would be a poor trade.
 */
export function batteryLimitsLikely(): boolean {
  if (Platform.OS !== 'android') return false;
  try {
    const maker = (Device.manufacturer ?? '').trim().toLowerCase();
    if (!maker) return false;
    return AGGRESSIVE.some((name) => maker.startsWith(name));
  } catch {
    return false;
  }
}

/** The manufacturer's own name, for a warning that says which phone it means. */
export function deviceMaker(): string | null {
  try {
    const maker = (Device.manufacturer ?? '').trim();
    return maker === '' ? null : maker;
  } catch {
    return null;
  }
}

/**
 * Open this app's settings page, which is as close as a managed app can get.
 *
 * The battery setting itself is two taps further in and lives somewhere
 * different on every one of these phones — "Battery and performance", "Power
 * saving", "App battery usage", "Background usage limits". Deep-linking to it
 * requires a vendor-specific intent per manufacturer, most of which are
 * undocumented and several of which crash on the wrong OS version, so the
 * screen says where to go and this gets them to the door.
 *
 * Returns false when even that could not be opened, so the caller can say so
 * rather than appearing to do nothing.
 */
export async function openAppSettings(): Promise<boolean> {
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}
