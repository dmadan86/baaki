/**
 * Restarting the app from inside it.
 *
 * There is exactly one thing in Baaki that cannot take effect while the app is
 * running: the direction the layout runs in. React Native reads that from
 * native constants before any JavaScript, so `I18nManager.forceRTL` says of
 * itself that changes *take full effect on the next application start*. Until
 * this file existed the only honest answer was to ask the person to close and
 * open Baaki, which two people in a row read as a broken app.
 *
 * `expo-updates` owns the only supported way to restart the JavaScript runtime
 * in a release build. It is here for that, and the fact that it also brings OTA
 * updates is a separate decision recorded in `app.json`.
 *
 * ## Why it is asked for twice, and required rather than imported
 *
 * Every build older than the one that added `expo-updates` — including the
 * development client on somebody's phone right now — has no such native module,
 * and a static import is hoisted and evaluated at module load. That is how a
 * missing native module stops being a failed feature and becomes an app that
 * dies at launch. Nothing in the type checker, the linter or the test suite
 * catches it, because all three run against the JavaScript.
 *
 * A `try`/`catch` around the require is *not* enough, which cost a round trip
 * on a device to learn. `expo-updates` calls `requireNativeModule('ExpoUpdates')`
 * at its own module scope, and that throw is reported to the global error
 * handler on the way past — so the red box appears even though the catch runs
 * and returns null. `requireOptionalNativeModule` is the same lookup with the
 * throw replaced by a null, so asking it first means nothing is ever thrown.
 */

// Via `expo` rather than `expo-modules-core`, which is a transitive dependency
// this app does not declare and has no business importing directly.
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface UpdatesModule {
  reloadAsync: () => Promise<void>;
}

function loadUpdates(): UpdatesModule | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  if (requireOptionalNativeModule('ExpoUpdates') == null) return null;
  try {
    // Required, not imported: an import is hoisted and evaluated at module
    // load, which is the thing the check above exists to avoid.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('expo-updates') as Partial<UpdatesModule>;
    return typeof loaded?.reloadAsync === 'function' ? (loaded as UpdatesModule) : null;
  } catch {
    return null;
  }
}

/**
 * Whether this build can restart itself.
 *
 * False on web, where there is nothing to restart — the layout mirrors the
 * moment `dir` changes — and false on any binary built before `expo-updates`
 * was added. Callers use it to decide *what to offer*, not what to say
 * afterwards: a screen that offers a button it cannot honour is worse than one
 * that asks plainly.
 */
export function canRestart(): boolean {
  return loadUpdates() !== null;
}

/**
 * Restart now. Resolves `false` if it could not, and does not resolve at all in
 * the ordinary case — the runtime is gone before the promise settles.
 */
export async function restartApp(): Promise<boolean> {
  const updates = loadUpdates();
  if (!updates) return false;
  try {
    await updates.reloadAsync();
    return true;
  } catch {
    // A refused reload leaves the app running and perfectly usable, just still
    // the old way round. The words about closing it by hand are still true.
    return false;
  }
}
