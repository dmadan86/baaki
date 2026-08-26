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

/**
 * Bound the text sent to the parser. A corrupted OCR result can otherwise build
 * a huge string on the JS thread and, later, burn cloud-parser tokens.
 */
const MAX_OCR_CHARS = 20_000;

const RECEIPT_KEYWORD =
  /\b(total|grand total|subtotal|amount due|net payable|tax|gst|vat|balance|paid)\b/i;
const CURRENCY_AMOUNT = /(?:₹|rs\.?|inr|\$|usd|€|eur|£|gbp|aed|د\.إ)\s*\d[\d,]*(?:\.\d{1,2})?/i;
const DECIMAL_AMOUNT = /\b\d{1,3}(?:,\d{2,3})*(?:\.\d{2})\b/;
const INTEGER_AMOUNT_LINE = /\b\d{1,3}(?:,\d{2,3})+\b/;

const DIGIT_RANGES = [
  ['٠', '٩'],
  ['۰', '۹'],
  ['०', '९'],
] as const;

function normaliseDigits(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return char;
      for (const [start, end] of DIGIT_RANGES) {
        const startCode = start.codePointAt(0) as number;
        const endCode = end.codePointAt(0) as number;
        if (code >= startCode && code <= endCode) return String(code - startCode);
      }
      return char;
    })
    .join('');
}

function normaliseLineText(value: string): string {
  return normaliseDigits(
    value
      .normalize('NFKC')
      .replace(/\u00a0/g, ' ')
      .replace(/\u066b/g, '.')
      .replace(/\u066c/g, ',')
      .replace(/[ \t]+/g, ' ')
      .trim(),
  );
}

function normaliseTextLines(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(/\r?\n/)
        .map(normaliseLineText)
        .filter((line) => line.length > 0)
    : [];
}

function looksLikeReceipt(text: string, lines: readonly string[]): boolean {
  const amountLines = lines.filter(
    (line) =>
      CURRENCY_AMOUNT.test(line) || DECIMAL_AMOUNT.test(line) || INTEGER_AMOUNT_LINE.test(line),
  ).length;
  return (
    CURRENCY_AMOUNT.test(text) ||
    (RECEIPT_KEYWORD.test(text) && amountLines >= 1) ||
    amountLines >= 3
  );
}

function blockLines(block: unknown): string[] {
  if (!block || typeof block !== 'object') return [];
  const candidate = block as { lines?: unknown; text?: unknown };
  if (Array.isArray(candidate.lines)) {
    return candidate.lines.flatMap((line) =>
      line && typeof line === 'object' ? normaliseTextLines((line as { text?: unknown }).text) : [],
    );
  }
  return normaliseTextLines(candidate.text);
}

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

    const lines = (result.blocks ?? []).flatMap(blockLines);
    const text = lines.join('\n');

    if (
      text.length < ENOUGH_TEXT ||
      text.length > MAX_OCR_CHARS ||
      !looksLikeReceipt(text, lines)
    ) {
      return null;
    }
    return { text, lines: lines.length };
  } catch {
    // No native module in this build, an unsupported script, a corrupt file —
    // all of them mean the same thing here: use the image.
    return null;
  }
}
