/**
 * Sign in with Apple, on the one platform where it is native.
 *
 * **Nothing here is imported at the top of the file that can fail.**
 * `expo-apple-authentication` is gentler than most native modules — its
 * functions come through `requireOptionalNativeModule`, which returns a stub
 * answering `isAvailableAsync() === false` rather than throwing. The *button*
 * is not: `ExpoAppleAuthenticationButton` calls `requireNativeViewManager` at
 * module scope whenever `Platform.OS === 'ios'`, and that throws on an iOS
 * binary built before this package was added. expo-router loads every route
 * file to build the route tree, so that is not a missing button — it is the app
 * failing to launch, with a red screen naming a screen nobody opened.
 *
 * So the package is only ever required once the native side is known to be
 * there, read from Expo's registry directly (`globalThis.expo.modules`), which
 * is the same non-throwing check `image.ts` uses and for the same reason.
 *
 * A false negative costs the Apple button and nothing else: the web flow in
 * `auth.tsx` still works, on this platform and every other one.
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { appleFullName } from '@baaki/core';

type AppleModule = typeof import('expo-apple-authentication');

/** What the sheet gives back, reduced to the two things anything here reads. */
export interface AppleCredential {
  /** The JWT Supabase exchanges for a session. */
  readonly identityToken: string;
  /**
   * Apple hands this over **on the first authorization only**, and never again
   * — not on a reinstall, not on a second device. If it is not captured now it
   * is gone, and in a bill-splitting app the cost of losing it is a row in
   * somebody's group that reads "Guest".
   */
  readonly fullName: string | null;
}

let cached: AppleModule | null | undefined;

/** Whether this build contains the native side. False on Android and web. */
function nativeSideExists(): boolean {
  if (Platform.OS !== 'ios') return false;
  const registry = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
  return Boolean(registry?.ExpoAppleAuthentication);
}

function load(): AppleModule | null {
  if (cached !== undefined) return cached;
  if (!nativeSideExists()) {
    cached = null;
    return null;
  }
  try {
    // Required, not imported: an import is hoisted and would be evaluated at
    // module load, which is the thing the check above exists to avoid.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-apple-authentication') as AppleModule;
  } catch {
    cached = null;
  }
  return cached;
}

/** The lazily-loaded module, for the button to render itself from. Null elsewhere. */
export function appleModule(): AppleModule | null {
  return load();
}

/**
 * Whether the native sheet can be opened at all.
 *
 * Two separate questions, and both have to be yes: is the module in this binary
 * (an old build says no), and does this iOS version support Sign in with Apple
 * (iOS 13+, so a very old phone says no). Asked before opening the sheet rather
 * than inferred from its result, because "no sheet here" and "somebody closed
 * the sheet" need opposite responses and are otherwise indistinguishable.
 */
export async function appleSignInAvailable(): Promise<boolean> {
  const apple = load();
  if (!apple) return false;
  try {
    return await apple.isAvailableAsync();
  } catch {
    // Unavailable is the only meaningful answer to a check that failed.
    return false;
  }
}

/**
 * The same question for rendering, where an answer is needed synchronously.
 *
 * Starts at false, which is the safe way round: a moment without the button
 * beats a button that throws when it is pressed.
 */
export function useAppleSignInAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    void appleSignInAvailable().then((yes) => {
      if (active) setAvailable(yes);
    });
    return () => {
      active = false;
    };
  }, []);

  return available;
}

/**
 * Open Apple's sheet and return what it gave us.
 *
 * Null means **somebody closed the sheet**, and nothing should happen — no
 * error, and in particular no falling back to the browser, which would answer a
 * person declining to sign in by opening a second thing to decline. Callers ask
 * `appleSignInAvailable()` first; anything else that goes wrong throws, because
 * a sheet that failed is worth saying out loud.
 *
 * No nonce. `signInAsync` would pass one through to Apple and Supabase would
 * compare it, but the two disagree about whether the value travelling in the
 * token is the raw string or its SHA-256, and getting that backwards fails
 * every sign-in on a device this repository cannot test from. Supabase's own
 * Expo guide omits it, the token still carries a signature and an audience that
 * are verified server-side, and it never leaves this process except over TLS to
 * Supabase.
 */
export async function signInWithApple(): Promise<AppleCredential | null> {
  const apple = load();
  // A missing module is not a cancellation — null is reserved for the person
  // closing the sheet, so throw here to keep the two states distinguishable.
  if (!apple) throw new Error('Sign in with Apple is not available in this build');

  try {
    const credential = await apple.signInAsync({
      requestedScopes: [
        apple.AppleAuthenticationScope.FULL_NAME,
        apple.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) return null;

    return {
      identityToken: credential.identityToken,
      fullName: appleFullName(credential.fullName),
    };
  } catch (error) {
    if ((error as { code?: string })?.code === 'ERR_REQUEST_CANCELED') return null;
    throw error;
  }
}
