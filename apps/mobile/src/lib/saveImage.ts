/**
 * Save a receipt image off the device — the "download" affordance on the viewer.
 *
 * The app ships `expo-sharing`, not `expo-media-library`, so "download" here means
 * the OS share sheet, which on both platforms carries "Save Image" / "Save to
 * Photos" / "Save to Files" alongside the send targets. That needs no extra
 * native module and no gallery-write permission, and it is the same mechanism the
 * export and invite screens already use.
 *
 * The bytes are a short-lived signed URL, so they are fetched to a cache file
 * first (the share sheet needs a local `file://`, not a remote URL) and the file
 * is named and typed by what actually came back, so a WebP saves as `.webp` and a
 * JPEG as `.jpg`.
 */

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export type SaveImageResult = 'shared' | 'unavailable' | 'error';

/** Map a content-type to a file extension; default to jpg, the safest to open. */
function extensionFor(contentType: string | null): string {
  if (!contentType) return 'jpg';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('heic')) return 'heic';
  return 'jpg';
}

/**
 * Fetch a (signed) image URL and hand it to the OS share/save sheet.
 *
 * Returns `'shared'` once the sheet has been presented (we cannot know whether
 * the person tapped Save or Cancel — the OS does not tell us, and that is fine),
 * `'unavailable'` where no share sheet exists (some web contexts), and `'error'`
 * when the bytes could not be fetched or written.
 */
export async function saveImageToDevice(url: string): Promise<SaveImageResult> {
  try {
    if (!(await Sharing.isAvailableAsync())) return 'unavailable';

    const response = await fetch(url);
    if (!response.ok) return 'error';
    const contentType = response.headers.get('content-type');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return 'error';

    const ext = extensionFor(contentType);
    // A stable, human name in the sheet rather than the opaque storage key.
    const file = new FileSystem.File(FileSystem.Paths.cache, `receipt.${ext}`);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);

    try {
      await Sharing.shareAsync(file.uri, {
        mimeType: contentType ?? 'image/jpeg',
        dialogTitle: 'Save receipt',
      });
    } finally {
      try {
        if (file.exists) file.delete();
      } catch {
        // Best-effort privacy cleanup; the share outcome matters more than cleanup errors.
      }
    }
    return 'shared';
  } catch {
    return 'error';
  }
}
