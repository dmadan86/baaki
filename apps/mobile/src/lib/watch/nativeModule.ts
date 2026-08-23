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
  sendToWatch(payload: Record<string, unknown>): void;
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
/**
 * Hand a payload to the native transport. Returns whether the handoff actually
 * happened — false when no watch module is present or the native call threw —
 * so a caller that dedupes on the last sent payload can hold its state until a
 * send truly lands (see the recent-list relay in bridge.tsx).
 */
export function sendToWatch(message: PhoneToWatch): boolean {
  if (!native) return false;
  try {
    native.sendToWatch(encodePhoneToWatch(message));
    return true;
  } catch {
    // The transport went away between the check and the send; nothing to do.
    return false;
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
