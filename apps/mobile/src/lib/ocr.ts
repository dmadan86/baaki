/**
 * Reading the text off a receipt on the phone itself.
 *
 * The photograph never leaves the device. What gets sent is the text, which is
 * both a better privacy trade — a receipt is a record of what somebody ate and
 * where they were — and roughly a tenth of the cost, because a receipt image is
 * one to two thousand tokens before the model has read a single word.
 *
 * `receipt-parse` already accepts text: it was built for pasted Swiggy and
 * Zomato bills, so nothing on the server changes.
 *
 * ML Kit's on-device recogniser is free, offline and needs no key. It reads
 * characters; it does not understand layout, so the text handed back is still
 * a bag of lines and turning that into priced items is still the model's job.
 */

import { Platform } from 'react-native';

/**
 * Below this many characters the recognition did not really work — a dark or
 * blurred photo yields a handful of stray glyphs, and sending those would burn
 * a scan from the user's quota to produce nothing. The image path reads such a
 * photo far better, so it is worth falling back to.
 */
const ENOUGH_TEXT = 40;

/** At least a few numbers, or this is not a bill. */
const LOOKS_LIKE_A_BILL = /\d[\d.,]*\s*$|\d+\.\d{2}/m;

export interface OcrResult {
  readonly text: string;
  /** How many lines the recogniser found. Useful for telling the user why. */
  readonly lines: number;
}

/**
 * Read a receipt image. Returns null when OCR is unavailable or the result is
 * too thin to be worth sending — the caller should upload the image instead.
 *
 * Never throws. A recogniser that fails is a reason to try the other path, not
 * a reason to lose the photo somebody just took.
 */
export async function recogniseReceipt(uri: string): Promise<OcrResult | null> {
  // Web has no ML Kit, and this module is imported by a screen that also runs
  // in the web export.
  if (Platform.OS === 'web') return null;

  try {
    const { default: TextRecognition } = await import('@react-native-ml-kit/text-recognition');
    const result = await TextRecognition.recognize(uri);

    const text = (result.blocks ?? [])
      .map((block) => (typeof block.text === 'string' ? block.text.trim() : ''))
      .filter((line) => line.length > 0)
      .join('\n');

    if (text.length < ENOUGH_TEXT || !LOOKS_LIKE_A_BILL.test(text)) return null;
    return { text, lines: result.blocks?.length ?? 0 };
  } catch {
    // No native module in this build, an unsupported script, a corrupt file —
    // all of them mean the same thing here: use the image.
    return null;
  }
}
