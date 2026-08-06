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

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

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
 * Cap the longest edge and re-encode as JPEG.
 *
 * Constraining width alone would leave a tall portrait photo just as heavy, so
 * which edge gets capped depends on the shape of the image. An image already
 * within budget is re-encoded but not resized — enlarging a small picture to
 * meet a maximum would add bytes to no purpose.
 */
async function shrink({ uri, width, height, maxEdge, compress }: ShrinkOptions): Promise<{
  base64: string;
  uri: string;
}> {
  const context = ImageManipulator.manipulate(uri);

  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    context.resize(width >= height ? { width: maxEdge } : { height: maxEdge });
  }

  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    base64: true,
    compress,
    format: SaveFormat.JPEG,
  });

  // `saveAsync` only omits base64 if it was not asked for; if it is missing
  // anyway there is nothing to upload, and saying so beats uploading nothing.
  if (!saved.base64) throw new Error('Could not read that image.');
  return { base64: saved.base64, uri: saved.uri };
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

  const shrunk = await shrink({
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    maxEdge,
    compress: 0.7,
  });
  return { base64: shrunk.base64, mimeType: 'image/jpeg', uri: shrunk.uri };
}

export const pickAvatarPhoto = () => pickSquarePhoto(AVATAR_MAX_EDGE);
export const pickGroupPhoto = () => pickSquarePhoto(COVER_MAX_EDGE);

/**
 * A receipt, from the camera by default (ADR-008). Not cropped to a square and
 * not compressed as hard: fidelity is worth the bytes when a model has to read
 * it back.
 */
export async function pickReceiptPhoto(): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  const launch = permission.granted
    ? ImagePicker.launchCameraAsync
    : ImagePicker.launchImageLibraryAsync;

  const result = await launch({ mediaTypes: ['images'], quality: 1, base64: false });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  const shrunk = await shrink({
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    maxEdge: RECEIPT_MAX_EDGE,
    compress: 0.9,
  });
  return { base64: shrunk.base64, mimeType: 'image/jpeg', uri: shrunk.uri };
}
