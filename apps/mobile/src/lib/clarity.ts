/**
 * Microsoft Clarity — session replay and heatmaps.
 *
 * Three things about this integration are deliberate and worth reading before
 * changing any of them.
 *
 * **It is off unless a project id is configured.** Same bargain as Sentry in
 * `observability.ts`: a clone with no Clarity account behaves exactly as the
 * app did before this file existed, and nothing is recorded by accident.
 *
 * **It starts paused and is only resumed by `allowSessionReplay`.** The SDK
 * begins capturing the moment `initialize` returns, and this app puts other
 * people's money on the screen — expense descriptions, amounts, payment
 * handles, the names of everybody in a group. Recording that by default, in a
 * product whose own privacy screen says it holds as little as it can, would
 * make that screen untrue. The gate is here so the decision is explicit.
 *
 * **Masking cannot be set from code.** The React Native SDK's config carries
 * only `userId` and `logLevel`; the masking level lives in the Clarity
 * dashboard (Settings → Masking). Code cannot enforce it, so this file cannot
 * promise it — see the README note. Set the project to **Strict** before
 * enabling capture, or session recordings will contain the ledger.
 *
 * The native module is reached lazily through a check that does not throw,
 * which is this repo's rule: a missing native module reached at import time
 * takes the whole app down at launch, on a build nothing local can reproduce.
 */

const PROJECT_ID = process.env.EXPO_PUBLIC_CLARITY_PROJECT_ID ?? '';

/** Configured at all. Nothing below does anything when this is false. */
export const clarityConfigured = Boolean(PROJECT_ID);

type ClarityModule = typeof import('@microsoft/react-native-clarity');

/**
 * The native side, or null when it is not in this build.
 *
 * `require` inside a try, never a static import: Clarity ships native code, so
 * a JS bundle that reaches it in an app built before the dependency existed —
 * an over-the-air update, an old dev client — would throw during module
 * evaluation, before any error boundary is mounted.
 */
function clarity(): ClarityModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@microsoft/react-native-clarity') as ClarityModule;
  } catch {
    return null;
  }
}

let started = false;

/**
 * Bring Clarity up, capturing nothing.
 *
 * Called once at launch. `pause()` immediately after `initialize` is the only
 * way to hold it: the SDK has no "start disabled" option, so the window
 * between the two calls is as small as it can be made.
 */
export function initClarity(): void {
  if (!clarityConfigured || started) return;

  const sdk = clarity();
  if (!sdk) return;

  try {
    sdk.initialize(PROJECT_ID);
    void sdk.pause();
    started = true;
  } catch {
    // Analytics must never be the reason an app fails to start.
  }
}

/**
 * Turn capture on or off.
 *
 * Separate from `initClarity` so that whatever decides this — a settings
 * toggle, a consent prompt, a remote flag — is a caller rather than a constant
 * buried in here.
 */
export async function allowSessionReplay(allowed: boolean): Promise<void> {
  if (!clarityConfigured || !started) return;

  const sdk = clarity();
  if (!sdk) return;

  try {
    // Analytics storage follows the same switch; ads storage is never granted,
    // because this app has no advertising and its privacy screen says so.
    await sdk.consent(false, allowed);
    await (allowed ? sdk.resume() : sdk.pause());
  } catch {
    // Ignored on purpose — see above.
  }
}

/**
 * Name the screen somebody is on.
 *
 * Route names only. Never an id, a group name or anything typed by a person:
 * the value is displayed in the Clarity dashboard beside the recording, and a
 * screen name is meant to say which page, not who.
 */
export async function noteScreen(name: string): Promise<void> {
  if (!clarityConfigured || !started) return;

  const sdk = clarity();
  if (!sdk) return;

  try {
    await sdk.setCurrentScreenName(name);
  } catch {
    // Ignored on purpose — see above.
  }
}
