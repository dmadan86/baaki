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

import type { ConfigContext, ExpoConfig } from 'expo/config';

/** The FCM config for this build, or nothing if this build has none. */
function googleServicesFile(): string | undefined {
  const fromEas = process.env.GOOGLE_SERVICES_JSON;
  if (fromEas && existsSync(fromEas)) return fromEas;

  const local = resolve(__dirname, 'google-services.json');
  return existsSync(local) ? local : undefined;
}

/**
 * The same file for the other half of the app: iOS wants a plist, and it is
 * not optional there the way it is on Android.
 *
 * `@react-native-firebase/app`'s iOS mod *throws* when `ios.googleServicesFile`
 * is unset — "Path to GoogleService-Info.plist is not defined" — so an iOS
 * build had no way to succeed while only the Android half of this was wired,
 * whatever it had in its secrets. Resolved exactly like the Android one: the
 * EAS file secret first, a local copy second, nothing if this machine has
 * neither.
 */
function googleServicesPlist(): string | undefined {
  const fromEas = process.env.GOOGLE_SERVICES_INFO_PLIST;
  if (fromEas && existsSync(fromEas)) return fromEas;

  const local = resolve(__dirname, 'GoogleService-Info.plist');
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

/**
 * The Google sign-in plugin, for iOS builds that have a client id.
 *
 * Two features ride on it — logging in (`lib/nativeIdentity.ts`) and linking
 * Drive for backup (`lib/cloud/nativeGoogle.ts`) — and they share one client
 * id because Google allows exactly one iOS client per bundle id. Either name
 * therefore configures both; the neutral one wins so a build that offers
 * sign-in without backup need not set something called `..._DRIVE_...`.
 *
 * Android needs nothing here: the native module autolinks, and Google matches
 * the app by package name and signing certificate rather than by anything
 * written into the binary. iOS is matched by bundle id instead, and its SDK
 * takes the consent result back through a URL scheme derived from the client
 * id — `123-abc.apps.googleusercontent.com` becomes
 * `com.googleusercontent.apps.123-abc` — which has to be in the Info.plist
 * before the app is built.
 *
 * The plugin is added only when that id is set, because its own validation
 * throws without one, and an unconfigured clone must still be able to prebuild.
 */
function googleSignInPlugin(): [string, { iosUrlScheme: string }] | undefined {
  const iosClientId =
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS ||
    process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_IOS;
  if (!iosClientId) return undefined;
  const bare = iosClientId.replace(/\.apps\.googleusercontent\.com$/, '');
  return [
    '@react-native-google-signin/google-signin',
    { iosUrlScheme: `com.googleusercontent.apps.${bare}` },
  ];
}

/**
 * Whether this build declares `android.permission.READ_SMS`.
 *
 * The same one-spelling switch `plugins/withSmsReader.js` reads, recorded into
 * `extra` so the running app can tell without guessing. Asking the native module
 * whether it loaded is not the same question: the module autolinks into every
 * Android build, and a build without the manifest entry would get as far as the
 * system permission dialog before failing — which is precisely the dialog a
 * default build must never show. `src/lib/smsFeature.ts` reads this.
 */
function smsReaderBuild(): boolean {
  return process.env.WAVES_SMS_READER === '1';
}

export default ({ config: fromAppJson }: ConfigContext): ExpoConfig => {
  // `app.json` arrives here already parsed, rather than being imported: that is
  // the shape `expo-doctor` recognises as "the dynamic config uses the static
  // one", and importing `./app.json` directly — which worked, and produced
  // identical output — failed that check and read as a project with two
  // configs disagreeing.
  const config = fromAppJson as ExpoConfig;

  const services = googleServicesFile();
  const androidBase = services
    ? { ...config.android, googleServicesFile: services }
    : config.android;

  const plist = googleServicesPlist();
  const iosBase = plist ? { ...config.ios, googleServicesFile: plist } : config.ios;

  // Fold the native Maps SDK key into each platform's `config` block when one is
  // set, so `expo prebuild` writes it into the manifest / Info.plist.
  const androidKey = googleMapsKey('android');
  const iosKey = googleMapsKey('ios');
  const withPush: ExpoConfig = {
    ...config,
    extra: { ...config.extra, smsReader: smsReaderBuild() },
    android: androidKey
      ? { ...androidBase, config: { ...androidBase?.config, googleMaps: { apiKey: androidKey } } }
      : androidBase,
    ios: iosKey
      ? { ...iosBase, config: { ...iosBase?.config, googleMapsApiKey: iosKey } }
      : iosBase,
  };

  const googleSignIn = googleSignInPlugin();
  const withGoogleSignIn: ExpoConfig = googleSignIn
    ? { ...withPush, plugins: [...(withPush.plugins ?? []), googleSignIn] }
    : withPush;

  const organization = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!organization || !project) return withGoogleSignIn;

  return {
    ...withGoogleSignIn,
    plugins: [
      ...(withGoogleSignIn.plugins ?? []),
      [
        '@sentry/react-native/expo',
        { organization, project, url: process.env.SENTRY_URL ?? 'https://sentry.io/' },
      ],
    ],
  };
};
