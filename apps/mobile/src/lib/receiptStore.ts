/**
 * The receipt vault — where a scanned bill lives on the phone.
 *
 * A capture's photo is deliberately never uploaded to Baaki (the privacy choice
 * behind this feature): a receipt is a record of what somebody bought and
 * where, and it has no business on our servers. So the image and a small JSON
 * sidecar of what we parsed off it are written into the app's own document
 * directory instead — kept out of the OS's reach (unlike the cache), readable
 * offline, and the source the personal-cloud backup uploads from.
 *
 * The pair is keyed by the capture id, exactly as the Supabase path used to be:
 * `<captureId>.jpg` beside `<captureId>.json`. The sidecar is what makes the
 * archive worth having on its own — a folder of photos tells you nothing, a
 * photo next to its total, date and line items is a record you can browse.
 *
 * Nothing here throws for the ordinary "not there" cases; a missing receipt
 * reads back as null so the caller does not have to wrap every read.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

/** The folder under the document directory that holds every saved receipt. */
const FOLDER = 'receipts';

/**
 * What we write beside the image: everything the parser recovered, in the same
 * minor-unit integers the ledger uses (ADR-003). Enough to rebuild the capture,
 * or to read the archive without the app.
 */
export interface ReceiptSidecar {
  readonly captureId: string;
  readonly currency: string;
  /** Grand total, minor units. */
  readonly amountMinor: number;
  readonly itemCount: number;
  readonly items: readonly { readonly label: string; readonly total: number }[];
  /** ISO date on the receipt, or the capture date. */
  readonly date: string | null;
  readonly category: string | null;
  /** The raw OCR text, so a better parser can re-read it later. */
  readonly rawText: string | null;
  /** When this receipt was captured, ISO instant. */
  readonly createdAt: string;
}

export interface SavedReceipt {
  readonly imageUri: string;
  /** The JSON sidecar's URI, or null when only the image exists on disk. */
  readonly jsonUri: string | null;
}

/** Web has no document directory; the vault is a device-only feature. */
function unavailable(): boolean {
  return Platform.OS === 'web';
}

function folder(): Directory {
  return new Directory(Paths.document, FOLDER);
}

function ensureFolder(): Directory {
  const dir = folder();
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Write a receipt's image and sidecar, overwriting any earlier attempt for the
 * same capture. `overwrite` rather than a fresh name so a ret‑scan replaces
 * cleanly and the backup queue re-uploads one file, not two.
 */
export function saveReceipt(
  captureId: string,
  input: { base64: string; sidecar: ReceiptSidecar },
): SavedReceipt | null {
  if (unavailable()) return null;
  ensureFolder();

  const image = new File(folder(), `${captureId}.jpg`);
  image.create({ overwrite: true });
  image.write(input.base64, { encoding: 'base64' });

  const json = new File(folder(), `${captureId}.json`);
  json.create({ overwrite: true });
  json.write(JSON.stringify(input.sidecar, null, 2), { encoding: 'utf8' });

  return { imageUri: image.uri, jsonUri: json.uri };
}

/** The local URIs for a saved receipt, or null when nothing was saved for it. */
export function receiptFiles(captureId: string): SavedReceipt | null {
  if (unavailable()) return null;
  const image = new File(folder(), `${captureId}.jpg`);
  const json = new File(folder(), `${captureId}.json`);
  if (!image.exists) return null;
  // Never hand back the image path as the sidecar: a consumer would upload the
  // JPEG named as metadata, and any reader that parses it fails.
  return { imageUri: image.uri, jsonUri: json.exists ? json.uri : null };
}

/** The parsed sidecar for a saved receipt, or null. */
export async function readReceipt(captureId: string): Promise<ReceiptSidecar | null> {
  if (unavailable()) return null;
  const json = new File(folder(), `${captureId}.json`);
  if (!json.exists) return null;
  try {
    return JSON.parse(await json.text()) as ReceiptSidecar;
  } catch {
    return null;
  }
}

/** Every saved receipt's sidecar, newest first. Skips any that fail to parse. */
export async function listReceipts(): Promise<ReceiptSidecar[]> {
  if (unavailable()) return [];
  const dir = folder();
  if (!dir.exists) return [];

  const sidecars: ReceiptSidecar[] = [];
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.name.endsWith('.json')) {
      try {
        sidecars.push(JSON.parse(await entry.text()) as ReceiptSidecar);
      } catch {
        // A truncated write from a killed process — skip it rather than fail the
        // whole listing.
      }
    }
  }
  return sidecars.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Remove a receipt's image and sidecar. A missing file is not an error. */
export function deleteReceipt(captureId: string): void {
  if (unavailable()) return;
  for (const name of [`${captureId}.jpg`, `${captureId}.json`]) {
    const file = new File(folder(), name);
    if (file.exists) file.delete();
  }
}
