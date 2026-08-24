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
  // iOS only: a queued WatchConnectivity transfer that never reached the watch.
  // Android has no equivalent event — its failures surface as a rejection from
  // `sendToWatch` above — and both are funnelled into `onWatchSendFailed`.
  addListener(
    event: 'onWatchSendFailed',
    handler: (event: { t?: unknown }) => void,
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

type SendFailureHandler = (kind: string | null) => void;

const failureHandlers = new Set<SendFailureHandler>();
let failureSubscription: { remove(): void } | null = null;

function notifySendFailed(kind: string | null): void {
  // A copy, so a handler that unsubscribes itself cannot mutate the set mid-loop.
  for (const handler of [...failureHandlers]) {
    try {
      handler(kind);
    } catch {
      // One subscriber's failure must not stop the others being told.
    }
  }
}

/**
 * Learn that a payload never reached the watch.
 *
 * Delivery is asynchronous on both platforms, so `sendToWatch` returning true
 * only means the payload left this side — the loss is reported later or not at
 * all. Handlers receive the `t` of the lost message where the platform says
 * which one it was (iOS names it; Android's rejection is per-send, so it is
 * named from the call), and null when it is unknown.
 *
 * A build with no watch module, or one whose native half predates the event,
 * simply never calls back — the same safe no-op the rest of this module keeps.
 */
export function onWatchSendFailed(handler: SendFailureHandler): () => void {
  failureHandlers.add(handler);
  if (native && !failureSubscription) {
    try {
      failureSubscription = native.addListener('onWatchSendFailed', (event) => {
        const kind = event.t;
        notifySendFailed(typeof kind === 'string' && kind !== '' ? kind : null);
      });
    } catch {
      // An older native module without this event; Android's send-promise path
      // below still reports, so leave the subscription unmade.
      failureSubscription = null;
    }
  }
  return () => {
    failureHandlers.delete(handler);
  };
}

/**
 * Hand a payload to the native transport. Returns whether the payload was
 * dispatched — false when no watch module is present or the native call threw
 * synchronously — so a caller that dedupes on the last sent payload can hold
 * its state until a send is at least dispatched (see the recent-list relay in
 * bridge.tsx). An asynchronous delivery failure (Android with no paired watch)
 * cannot become an unhandled rejection and still returns true, since the
 * payload did leave this side; it is reported through `onWatchSendFailed`
 * instead, which is the only way a caller hears about it.
 */
export function sendToWatch(message: PhoneToWatch): boolean {
  if (!native) return false;
  try {
    // The rejection has to be swallowed as well as the throw. On Android this
    // is an AsyncFunction, and its `Tasks.await(connectedNodes)` fails on any
    // phone with no paired watch or no working Play Services — the ordinary
    // case, not an edge one. A bare try/catch only covers the synchronous half,
    // so those failures surfaced as unhandled promise rejections, which is the
    // opposite of the safe no-op this module exists to promise. `Promise.resolve`
    // normalises iOS's undefined return so the same line covers both platforms.
    void Promise.resolve(native.sendToWatch(encodePhoneToWatch(message))).catch(() => {
      notifySendFailed(message.t);
    });
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
