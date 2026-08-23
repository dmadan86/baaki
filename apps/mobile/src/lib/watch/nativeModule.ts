/**
 * The bridge to the native watch transport, if a build has one.
 *
 * The transport is a native module named `WavesWatch` (WatchConnectivity on
 * iOS, the Wearable Data Layer on Android) added by the per-platform watch PRs.
 * It is required *optionally*: a build that predates it — or any web build —
 * gets a null module and every call here becomes a safe no-op, so the phone app
 * never depends on the watch being present (the native-module rule).
 */

import { requireOptionalNativeModule } from 'expo';

import { encodePhoneToWatch, type PhoneToWatch } from '@waves/core';

interface NativeWatch {
  isReachable(): boolean;
  // Android implements this as an Expo `AsyncFunction` — its Wear send has to
  // await a connected-node lookup off the JS thread — so it hands back a
  // promise. iOS's is a plain `Function` and returns nothing. Typed as both so
  // callers cannot forget the promise half.
  sendToWatch(payload: Record<string, unknown>): void | Promise<void>;
  addListener(
    event: 'onWatchMessage',
    handler: (event: { payload: unknown }) => void,
  ): { remove(): void };
}

const native = requireOptionalNativeModule<NativeWatch>('WavesWatch');

/** True only in a build whose native watch transport is present. */
export function watchAvailable(): boolean {
  return native != null;
}

/** Whether a watch is currently paired and reachable. */
export function watchReachable(): boolean {
  try {
    return native?.isReachable() ?? false;
  } catch {
    return false;
  }
}

/** Send one phone→watch message (stamped with the relay version). No-op if absent. */
export function sendToWatch(message: PhoneToWatch): void {
  try {
    // The rejection has to be swallowed as well as the throw. On Android this
    // is an AsyncFunction, and its `Tasks.await(connectedNodes)` fails on any
    // phone with no paired watch or no working Play Services — the ordinary
    // case, not an edge one. A bare try/catch only covers the synchronous half,
    // so those failures surfaced as unhandled promise rejections, which is the
    // opposite of the safe no-op this module exists to promise. `Promise.resolve`
    // normalises iOS's undefined return so the same line covers both platforms.
    void Promise.resolve(native?.sendToWatch(encodePhoneToWatch(message))).catch(
      () => undefined,
    );
  } catch {
    // The transport went away between the check and the send; nothing to do.
  }
}

/** Subscribe to raw watch→phone payloads. Returns an unsubscribe; no-op if absent. */
export function onWatchMessage(handler: (raw: unknown) => void): () => void {
  if (!native) return () => undefined;
  try {
    const sub = native.addListener('onWatchMessage', (event) => handler(event.payload));
    return () => {
      try {
        sub.remove();
      } catch {
        // The module was torn down first; nothing to remove.
      }
    };
  } catch {
    // Subscribing failed — behave as if there were no transport.
    return () => undefined;
  }
}
