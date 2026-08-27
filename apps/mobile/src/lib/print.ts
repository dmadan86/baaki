/**
 * A soft-failing seam over `expo-print`.
 *
 * expo-print is a NATIVE module: it registers on the JSI host object as the app
 * starts, and `requireNativeModule('ExpoPrint')` — which `require('expo-print')`
 * triggers at module-eval time — throws on a binary that never linked it (a
 * stale dev client, or an OTA update that added the dependency before a native
 * rebuild shipped). A throw like that at module top-level would take the whole
 * screen down at launch, so this file never imports expo-print eagerly.
 *
 * Instead it mirrors `lib/location.ts`: a dependency-free property lookup tells
 * us whether the module is linked, and only then do we `require` it, still
 * inside a try. Callers get `printAvailable()` to gate the UI and
 * `printHtmlToFile()` to actually render — the latter returns `null` when the
 * module is absent so the screen can show an "update the app" message rather
 * than crashing.
 */

import { Platform } from 'react-native';

// A type-only import: erased at build time, so it never pulls the native module
// in. It only gives `require('expo-print')` a shape.
import type * as ExpoPrint from 'expo-print';

/** Printing is a native concern; the web build has no expo-print backend. */
const printSupported = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * Whether the `ExpoPrint` native module is linked into this binary. A plain
 * property read on the Expo JSI host — it cannot throw, unlike requiring the JS
 * wrapper, so it is safe to call from render.
 */
function printModuleLinked(): boolean {
  const host = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo;
  return host?.modules?.ExpoPrint != null;
}

/**
 * Whether a PDF can actually be rendered on this device right now: a native
 * platform AND the module linked into this build. The export screen gates the
 * PDF path on this so a stale binary shows the "update to export" message
 * instead of throwing.
 */
export function printAvailable(): boolean {
  return printSupported && printModuleLinked();
}

function loadPrint(): typeof ExpoPrint | null {
  if (!printAvailable()) return null;
  try {
    // Lazy so a build that did not link the module fails soft, not at launch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-print') as typeof ExpoPrint;
  } catch {
    return null;
  }
}

/**
 * Render an HTML string to a PDF file and return its `file://` uri, or `null`
 * when expo-print is unavailable (so the caller shows the update message). Any
 * genuine render failure still throws, for the caller's `friendlyError`.
 */
export async function printHtmlToFile(html: string): Promise<string | null> {
  const Print = loadPrint();
  if (!Print) return null;
  const { uri } = await Print.printToFileAsync({ html });
  return uri;
}
