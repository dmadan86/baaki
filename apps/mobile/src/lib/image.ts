/**
 * Choosing a picture, and making it a sensible size before it leaves the phone.
 *
 * A 2026 phone camera produces a 12-megapixel JPEG somewhere north of 4 MB. The
 * app displays an avatar at 78pt and a group cover a little larger, so
 * uploading the original means paying — in the free tier's storage (ADR-011),
 * in the person's mobile data, and again in every signed-URL fetch — for
 * roughly forty times the pixels that will ever be drawn.
 *
 * `quality` on the picker alone does not fix this: it re-compresses at the same
 * dimensions, so a 4000×3000 photo stays 4000×3000. The resize is the part that
 * matters, and it happens here rather than at each call site so that no future
 * upload can forget it.
 *
 * The bucket ceilings (5 MB for covers, 2 MB for avatars) stay where they are.
 * They are the backstop for the case where this code did not run, not the
 * mechanism.
 */

import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Image, Platform } from 'react-native';

import { scanDocument } from './scanner';

/**
 * Loaded on demand, and only once the native side is known to be there.
 *
 * `expo-image-manipulator` is a native module, so a development client built
 * before it was added does not contain it. Importing it at the top of the file
 * threw while the module was being evaluated and took down every screen that
 * imports this one; moving to `await import()` was not enough, because Metro's
 * dev-mode loader hands a module-evaluation error to the global error handler
 * before the awaiting `catch` ever sees it — the app carried on, but with a
 * full-screen red box over it.
 *
 * So the module is never evaluated unless it can work. Expo's native registry
 * publishes what it installed on `globalThis.expo.modules`, which is what
 * `requireNativeModule` reads and what it throws about when the name is absent.
 * Reading it directly avoids importing `expo-modules-core`, which pnpm's
 * isolated layout does not resolve from this app anyway.
 *
 * A false negative here costs the resize and nothing else, which is the right
 * direction for this check to fail in.
 */
type Manipulator = typeof import('expo-image-manipulator');
let manipulator: Manipulator | null | undefined;

function nativeSideExists(): boolean {
  // On web the package resolves to a browser implementation that never asks the
  // native registry anything, so there is nothing to check and nothing to throw.
  if (Platform.OS === 'web') return true;
  const registry = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
  return Boolean(registry?.ExpoImageManipulator);
}

async function loadManipulator(): Promise<Manipulator | null> {
  if (manipulator !== undefined) return manipulator;
  if (!nativeSideExists()) {
    manipulator = null;
    return null;
  }
  try {
    manipulator = await import('expo-image-manipulator');
  } catch {
    manipulator = null;
  }
  return manipulator;
}

export interface PickedImage {
  base64: string;
  mimeType: string;
  /** Local URI, so the choice is visible before it has been uploaded. */
  uri: string;
}

/** Longest edge, in pixels, after downscaling. */
export const AVATAR_MAX_EDGE = 512;
export const COVER_MAX_EDGE = 1024;
/**
 * A receipt is read by an OCR model, not by a person, and a faded line it
 * cannot resolve is a line somebody has to retype. It gets the largest budget
 * and the lightest compression (ADR-008).
 */
export const RECEIPT_MAX_EDGE = 2000;

interface ShrinkOptions {
  uri: string;
  /** Source dimensions from the picker, used to decide which edge to cap. */
  width: number;
  height: number;
  maxEdge: number;
  compress: number;
}

/**
 * Cap the longest edge and re-encode, preferring WebP (A44).
 *
 * Constraining width alone would leave a tall portrait photo just as heavy, so
 * which edge gets capped depends on the shape of the image. An image already
 * within budget is re-encoded but not resized — enlarging a small picture to
 * meet a maximum would add bytes to no purpose.
 *
 * WebP is the target: at the same visible quality it is materially smaller than
 * JPEG, which is bytes saved in storage (the free-tier ceiling), on the wire and
 * in every fetch. But `expo-image-manipulator`'s WebP encoder is Android-solid
 * and unreliable on some iOS versions, where `saveAsync` throws. So the encode
 * is tried as WebP and falls back to JPEG on failure — a smaller file where the
 * platform allows it, a working upload everywhere. The returned `mimeType` says
 * which one it was, so the object is stored and served as what it actually is.
 */
async function shrink({ uri, width, height, maxEdge, compress }: ShrinkOptions): Promise<{
  base64: string;
  uri: string;
  mimeType: string;
} | null> {
  const module = await loadManipulator();
  if (!module) return null;

  const render = async () => {
    // Re-manipulate per attempt: a rendered context is consumed by saveAsync and
    // cannot be re-saved in another format.
    const context = module.ImageManipulator.manipulate(uri);
    const longest = Math.max(width, height);
    if (longest > maxEdge) {
      context.resize(width >= height ? { width: maxEdge } : { height: maxEdge });
    }
    return context.renderAsync();
  };

  const webp = module.SaveFormat.WEBP;
  if (webp) {
    try {
      const saved = await (await render()).saveAsync({ base64: true, compress, format: webp });
      if (saved.base64) return { base64: saved.base64, uri: saved.uri, mimeType: 'image/webp' };
    } catch {
      // iOS without a WebP encoder — fall through to JPEG.
    }
  }

  const saved = await (
    await render()
  ).saveAsync({
    base64: true,
    compress,
    format: module.SaveFormat.JPEG,
  });

  // `saveAsync` only omits base64 if it was not asked for; if it is missing
  // anyway there is nothing to upload, and saying so beats uploading nothing.
  if (!saved.base64) throw new Error('Could not read that image.');
  return { base64: saved.base64, uri: saved.uri, mimeType: 'image/jpeg' };
}

/**
 * Read the picked file without resizing it.
 *
 * Only reached in a development client built before `expo-image-manipulator`
 * was added. The picker's own `quality` still compresses, and the bucket size
 * limits still reject anything absurd — so the worst case is a rejected upload
 * with a clear message, rather than a screen that will not open.
 */
async function readUnshrunk(
  uri: string,
): Promise<{ base64: string; uri: string; mimeType?: string }> {
  // `File.base64()` rather than fetch + FileReader: React Native's fetch does
  // not reliably read a `file://` URI on Android, and a fallback that fails is
  // not a fallback.
  const base64 = await new FileSystem.File(uri).base64();
  if (!base64) throw new Error('Could not read that image.');
  // No manipulator ran, so the format is whatever was picked; the caller falls
  // back to JPEG for the stored mime, which the bucket normalises anyway.
  return { base64, uri, mimeType: undefined };
}

/**
 * Ask for a square photo — a profile picture or a group cover.
 *
 * Returns null when the person changes their mind or declines access. Both are
 * ordinary answers, not errors to report.
 */
export async function pickSquarePhoto(maxEdge: number): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
    // Base64 of the original is megabytes of string we are about to throw away;
    // the manipulator reads the file from its URI instead.
    base64: false,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  const shrunk =
    (await shrink({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      maxEdge,
      compress: 0.7,
    })) ?? (await readUnshrunk(asset.uri));
  return { base64: shrunk.base64, mimeType: shrunk.mimeType ?? 'image/jpeg', uri: shrunk.uri };
}

export const pickAvatarPhoto = () => pickSquarePhoto(AVATAR_MAX_EDGE);
export const pickGroupPhoto = () => pickSquarePhoto(COVER_MAX_EDGE);

/** Longest edge for an album photo — big enough to look good full-screen,
 *  small enough to stay light in the free-tier storage cap. */
export const ALBUM_MAX_EDGE = 1600;

/**
 * A photo for the trip album — from the library, uncropped, any shape.
 *
 * Re-encoding through the manipulator is what strips the EXIF metadata (a beach
 * photo should not carry the GPS of where it was taken into a shared album), so
 * the resize here is a privacy step as much as a size one.
 *
 * And unlike a receipt, there is **no `readUnshrunk` fallback**: a receipt's
 * audience is the group's ledger and losing the resize only costs bytes, but an
 * album photo is group-visible and uploading the untouched original would ship
 * its GPS EXIF to everyone. So if the manipulator cannot run (a dev client built
 * before it existed), the add fails safe — null, no upload — rather than leak a
 * location. Returns null for a cancel/decline too; both are ordinary answers.
 */
export async function pickAlbumPhoto(): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    base64: false,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  const shrunk = await shrink({
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    maxEdge: ALBUM_MAX_EDGE,
    compress: 0.8,
  });
  // No un-stripped fallback — see the doc comment. A missing manipulator means
  // "cannot add safely", which reads as a cancel to the caller.
  if (!shrunk) return null;
  return { base64: shrunk.base64, mimeType: shrunk.mimeType ?? 'image/jpeg', uri: shrunk.uri };
}

/**
 * A receipt, from the camera by default (ADR-008). Not cropped to a square and
 * not compressed as hard: fidelity is worth the bytes when a model has to read
 * it back.
 */
export async function pickReceiptPhoto(): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  let launch = ImagePicker.launchCameraAsync;
  if (!permission.granted) {
    // Falling back to the library needs its own permission, or the picker can
    // throw or return nothing on a restricted Android library.
    const library = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!library.granted) return null;
    launch = ImagePicker.launchImageLibraryAsync;
  }

  const result = await launch({ mediaTypes: ['images'], quality: 1, base64: false });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  const shrunk =
    (await shrink({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      maxEdge: RECEIPT_MAX_EDGE,
      compress: 0.9,
    })) ?? (await readUnshrunk(asset.uri));
  return { base64: shrunk.base64, mimeType: shrunk.mimeType ?? 'image/jpeg', uri: shrunk.uri };
}

/**
 * A receipt the person already has — pick it from the photo library.
 *
 * The counterpart to {@link captureReceipt} for the times there is nothing to
 * point a camera at: the bill is a screenshot of a food-delivery order, a PDF
 * someone photographed earlier, or a scan that failed and the person would
 * rather attach the picture they already took. It goes straight to the library
 * rather than the camera, and it is deliberately not gated behind OCR — an
 * attached image is worth keeping whether or not a model can read a total off
 * it (E1/E2).
 *
 * Sized and compressed exactly like a camera receipt so the vault and any
 * personal-cloud backup carry the same bytes either way. Returns null when the
 * person cancels or declines access — both ordinary answers, not errors.
 */
export async function pickReceiptImage(): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    base64: false,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  const shrunk =
    (await shrink({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      maxEdge: RECEIPT_MAX_EDGE,
      compress: 0.9,
    })) ?? (await readUnshrunk(asset.uri));
  return { base64: shrunk.base64, mimeType: shrunk.mimeType ?? 'image/jpeg', uri: shrunk.uri };
}

/**
 * A receipt, however this phone can best get one.
 *
 * The document scanner is tried first: it finds the page edges and flattens the
 * perspective, and OCR on a flat crop of the bill is a different proposition
 * from OCR on a photograph of a table. Where the build has no scanner — web, or
 * a binary from before it was installed — this falls through to the plain
 * camera, which is what every scan used until now.
 *
 * The two are deliberately one function. Two capture paths would drift, and the
 * screen asking for a receipt has no business knowing which one it got.
 */
export async function captureReceipt(): Promise<PickedImage | null> {
  const outcome = await scanDocument();
  // No scanner in this build (web, or a binary from before it was installed) or
  // one that would not open: fall through to the plain camera, which is what
  // every scan used until the scanner existed.
  if (outcome.kind === 'unavailable') return pickReceiptPhoto();
  // Backed out of the scanner. That is a cancel, not a request for a different
  // camera — the old code fell back here and surprised the person with the OS
  // camera. Do nothing.
  if (outcome.kind === 'cancelled') return null;
  const scanned = outcome.uri;

  // The scanner reports no dimensions, and `shrink` caps whichever edge is
  // longer. Asking the file is cheap; failing to ask would send a 4000px scan
  // up whole, so an unreadable size is a reason to skip the resize rather than
  // to abandon the scan.
  const size = await imageSize(scanned);
  const shrunk =
    (size
      ? await shrink({
          uri: scanned,
          width: size.width,
          height: size.height,
          maxEdge: RECEIPT_MAX_EDGE,
          compress: 0.9,
        })
      : null) ?? (await readUnshrunk(scanned));
  return { base64: shrunk.base64, mimeType: shrunk.mimeType ?? 'image/jpeg', uri: shrunk.uri };
}

function imageSize(uri: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve(null),
    );
  });
}
