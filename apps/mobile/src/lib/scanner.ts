/**
 * The camera that knows it is looking at a piece of paper.
 *
 * A photograph of a bill taken at a table is at an angle, on a patterned cloth,
 * with half a plate in frame. The OCR that follows reads characters; it has no
 * idea which of those characters are on the receipt. The platforms both ship a
 * scanner that solves exactly this — `VNDocumentCameraViewController` on iOS,
 * ML Kit's document scanner on Android — which finds the page edges, corrects
 * the perspective and hands back a flat, cropped image. The same receipt reads
 * far better afterwards, and nobody had to line the shot up.
 *
 * **Nothing is imported at the top of this file that can fail.**
 * `react-native-document-scanner-plugin` calls
 * `TurboModuleRegistry.getEnforcing('DocumentScanner')` while its own module is
 * being evaluated, which throws on any binary built before it was installed.
 * That is not a missing button — expo-router loads every route file to build
 * the route tree, so it is the app failing to launch. `TurboModuleRegistry.get`
 * answers the same question and returns null instead of throwing, so the
 * package is only ever required once it is known to be there.
 */

import { Platform, TurboModuleRegistry } from 'react-native';

interface DocumentScanner {
  scanDocument(options: {
    croppedImageQuality?: number;
    maxNumDocuments?: number;
  }): Promise<{ scannedImages?: string[]; status?: string }>;
}

/** Whether this build contains the scanner. False on web, and on older binaries. */
export function scannerAvailable(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try {
    return TurboModuleRegistry.get('DocumentScanner') != null;
  } catch {
    return false;
  }
}

/**
 * How a scan ended. The three cases are deliberately kept apart because the
 * caller must treat them differently:
 *
 *  - `image`       — a cropped page, use it.
 *  - `cancelled`   — the scanner opened and the person backed out. Do nothing;
 *                    they did not ask for a different camera.
 *  - `unavailable` — there is no scanner in this build, or it would not open at
 *                    all. Falling back to the plain camera is right here.
 *
 * Collapsing `cancelled` and `unavailable` into one "no image" was the bug this
 * type exists to prevent: it made backing out of the scanner silently launch
 * the OS camera instead.
 */
export type ScanResult =
  { kind: 'image'; uri: string } | { kind: 'cancelled' } | { kind: 'unavailable' };

/**
 * Open the scanner and report how it ended (see `ScanResult`).
 *
 * One page only. A restaurant bill is one page, and a second image would have
 * to be reconciled against the first before either could become an expense —
 * work with no home in ADR-008's "the model proposes, the person confirms".
 */
export async function scanDocument(): Promise<ScanResult> {
  if (!scannerAvailable()) return { kind: 'unavailable' };

  let scanner: DocumentScanner;
  try {
    // Required, not imported: an import is hoisted and would be evaluated at
    // module load, which is the thing the check above exists to avoid.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('react-native-document-scanner-plugin') as {
      default: DocumentScanner;
    };
    scanner = loaded.default;
  } catch {
    return { kind: 'unavailable' };
  }

  try {
    const { scannedImages } = await scanner.scanDocument({
      maxNumDocuments: 1,
      // A receipt is read by a model, not looked at. Faded thermal print is
      // the whole difficulty, and compression artefacts land on exactly the
      // strokes that were already marginal.
      croppedImageQuality: 100,
    });
    const uri = scannedImages?.[0];
    // An image means success. No image with no throw is the person backing out
    // of the scanner — a cancel, not a reason to open another camera.
    return uri ? { kind: 'image', uri } : { kind: 'cancelled' };
  } catch {
    // A scanner that will not open at all is a reason to fall back to the plain
    // camera, not to put an error in front of somebody holding a bill.
    return { kind: 'unavailable' };
  }
}
