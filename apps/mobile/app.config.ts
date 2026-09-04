/**
 * `app.json` stays the app's description of itself. This file adds the two
 * things that cannot be written down statically, both for the same reason:
 * they name an account that belongs to whoever is building, not to this
 * repository, and hard-coding a placeholder would break `expo prebuild` for
 * anybody who cloned this without one.
 *
 * **Sentry.** Its config plugin uploads source maps during the native build,
 * which is the difference between a stack trace and a column number in a
 * minified bundle. To do that it needs an organisation and a project, so the
 * plugin is added only when the build is actually configured to talk to
 * Sentry. Reporting itself is a separate switch (`EXPO_PUBLIC_SENTRY_DSN`): a
 * build can report crashes without uploading source maps, and reads them
 * minified.
 *
 * **FCM.** Android push goes Waves → Expo → FCM → the phone, and FCM will not
 * issue this app a token unless the binary was built with the Firebase
 * project's `google-services.json` in it. Setting `android.googleServicesFile`
 * is what puts it there. The file is not checked in — this repo is public, and
 * it names a Firebase project only one person should be able to point builds
 * at — so the path is resolved at config time from whichever exists:
 *
 *   1. `GOOGLE_SERVICES_JSON` — an EAS file secret. EAS downloads the file
 *      before the build and sets this to its absolute path.
 *   2. `apps/mobile/google-services.json` — a local copy, for `expo prebuild`
 *      and `expo run:android` on a development machine.
 *
 * And when neither exists, the key is left off entirely. A `googleServicesFile`
 * pointing at a file that is not there fails the build outright, which would
 * mean nobody could build this app until they had a Firebase account. Without
 * the key the app builds and runs; the only thing that does not work is
 * registering for push, and `lib/push.ts` says so in words rather than
 * throwing.
 *
 * Setting the credentials up is a console job — see README, "Turning on push".
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ExpoConfig } from 'expo/config';

import appJson from './app.json';

/** The FCM config for this build, or nothing if this build has none. */
function googleServicesFile(): string | undefined {
  const fromEas = process.env.GOOGLE_SERVICES_JSON;
  if (fromEas && existsSync(fromEas)) return fromEas;

  const local = resolve(__dirname, 'google-services.json');
  return existsSync(local) ? local : undefined;
}

/**
 * The native Google Maps SDK key for a platform, or nothing when unset.
 *
 * `react-native-maps` with the Google provider needs an API key baked into the
 * native manifest (Android) / Info.plist (iOS) — this is Google's sanctioned
 * path for a mobile Maps key and MUST be locked down in the Cloud Console before
 * release (Android package + SHA-1, iOS bundle id; and the Maps SDK APIs only).
 * The key is not committed — this repo is public — so it is read at config time,
 * a platform-specific var winning over the shared one. With none set the app
 * still builds; the Google map just renders blank until a key is supplied.
 */
function googleMapsKey(platform: 'android' | 'ios'): string | undefined {
  const perPlatform =
    platform === 'android' ? process.env.GOOGLE_MAPS_ANDROID_KEY : process.env.GOOGLE_MAPS_IOS_KEY;
  return perPlatform || process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || undefined;
}

export default (): ExpoConfig => {
  const config = appJson.expo as ExpoConfig;

  const services = googleServicesFile();
  const androidBase = services
    ? { ...config.android, googleServicesFile: services }
    : config.android;

  // Fold the native Maps SDK key into each platform's `config` block when one is
  // set, so `expo prebuild` writes it into the manifest / Info.plist.
  const androidKey = googleMapsKey('android');
  const iosKey = googleMapsKey('ios');
  const withPush: ExpoConfig = {
    ...config,
    android: androidKey
      ? { ...androidBase, config: { ...androidBase?.config, googleMaps: { apiKey: androidKey } } }
      : androidBase,
    ios: iosKey
      ? { ...config.ios, config: { ...config.ios?.config, googleMapsApiKey: iosKey } }
      : config.ios,
  };

  const organization = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!organization || !project) return withPush;

  return {
    ...withPush,
    plugins: [
      ...(withPush.plugins ?? []),
      [
        '@sentry/react-native/expo',
        { organization, project, url: process.env.SENTRY_URL ?? 'https://sentry.io/' },
      ],
    ],
  };
};
