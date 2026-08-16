/**
 * Reading a receipt's numbers off its OCR text, on the phone, without a model.
 *
 * The vision model (`receipt-parse`) understands layout and is what ADR-008
 * ultimately relies on. But it costs money and a network round trip, and while
 * the Anthropic account is unfunded it returns nothing at all. A capture caught
 * with no group has no reason to wait on any of that: ML Kit has already turned
 * the photo into lines of text on the device, and most receipts are regular
 * enough that a total and a list of priced lines can be recovered from those
 * lines by rule rather than by inference.
 *
 * This is deliberately a floor, not a ceiling. It is approximate on a crumpled
 * thermal bill and it does not pretend otherwise — every result carries a
 * `confidence`, computed by the same {@link checkReceipt} arithmetic the model
 * path uses, so the caller can prefer the model the moment it is available and
 * fall back here when it is not. The number it is surest about is the printed
 * grand total; the itemisation is a best effort the user can override.
 *
 * Every amount it produces is an integer in minor units, like the rest of the
 * ledger (ADR-003). A price written with two decimals is read as those decimals
 * (`12.50` → 1250); a bare whole number is taken to be a two-decimal currency's
 * major unit (`12` → 1200). That assumption is wrong for a zero-decimal
 * currency such as JPY, which is a known limit of reading without the model.
 */

import { checkReceipt } from './reconcile';
import { LOW_CONFIDENCE, type ParsedReceipt, type ParsedReceiptCharge } from './types';

/** A parsed receipt plus how much the caller should trust it (0–1). */
export interface HeuristicReceipt extends ParsedReceipt {
  /**
   * 0–1. High when the lines add up to the printed total and items were found;
   * low when the arithmetic does not close, the total had to be inferred, or no
   * items were recognised. Below {@link LOW_CONFIDENCE} the caller should treat
   * the itemisation as a draft and lean on the single editable amount instead.
   */
  readonly confidence: number;
}

export interface ParseReceiptTextOptions {
  /** Currency to assume when the text carries no symbol or code. */
  readonly currency?: string;
}

/** Currency symbols and codes we can recognise in the raw text. */
const CURRENCY_HINTS: readonly { readonly pattern: RegExp; readonly code: string }[] = [
  { pattern: /₹|\bRs\.?\b|\bINR\b/i, code: 'INR' },
  { pattern: /\$|\bUSD\b/i, code: 'USD' },
  { pattern: /€|\bEUR\b/i, code: 'EUR' },
  { pattern: /£|\bGBP\b/i, code: 'GBP' },
  { pattern: /\bAED\b|\bDhs?\b/i, code: 'AED' },
];

/**
 * A line whose trailing number is the receipt's grand total. Ordered by how
 * unambiguous the wording is — "grand total" beats a lone "total", which in
 * turn beats "balance", because a receipt often prints several of these and the
 * last, most-specific one is the amount that actually left the wallet.
 */
const TOTAL_LABELS: readonly RegExp[] = [
  /\bgrand\s*total\b/i,
  /\b(?:amount|balance)\s*(?:due|payable)\b/i,
  /\bnet\s*(?:payable|amount|total)\b/i,
  /\btotal\b/i,
];

const SUBTOTAL = /\bsub[\s-]*total\b/i;
const TAX = /\b(?:tax|gst|cgst|sgst|igst|vat|hst|pst)\b/i;
const SERVICE = /\bservice\s*(?:charge|fee|tax)?\b/i;
const TIP = /\b(?:tip|gratuity)\b/i;
const DISCOUNT = /\b(?:discount|coupon|savings?|promo|%?\s*off)\b/i;
const DELIVERY = /\b(?:delivery|packing|packaging|convenience|handling)\b/i;

/**
 * Lines that carry a number but are never an item or a charge — payment
 * mechanics, identifiers and pleasantries. Left in, each would be counted as a
 * priced line and wreck the arithmetic.
 */
const NOISE =
  /\b(?:cash|change|tendered|card|visa|master|upi|paid|balance\b(?!\s*due)|invoice|bill\s*no|receipt|gstin|tin|vat\s*no|phone|tel|mobile|table|token|order\s*no|qty|thank|welcome|www\.|\.com)\b/i;

/**
 * Parse OCR text into a receipt. Never throws: text that is not a receipt at
 * all comes back as an empty, zero-total, zero-confidence result rather than an
 * exception, because the caller's fallback is "let the person type it", not
 * "handle an error".
 */
export function parseReceiptText(
  text: string,
  opts: ParseReceiptTextOptions = {},
): HeuristicReceipt {
  const fallbackCurrency = opts.currency ?? 'USD';
  const currency = detectCurrency(text) ?? fallbackCurrency;
  const date = detectDate(text);

  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const items: { label: string; total: number; confidence: number }[] = [];
  const taxes: ParsedReceiptCharge[] = [];
  const discounts: ParsedReceiptCharge[] = [];
  let subtotal: number | null = null;
  let serviceCharge: number | null = null;
  let tip: number | null = null;
  let totalCandidate: { amount: number; rank: number } | null = null;

  let merchant: string | null = null;

  for (const line of rawLines) {
    const money = trailingAmount(line);

    // A line with no price is either the merchant (the first wordy line) or
    // noise. It never becomes an item, so nothing downstream depends on it.
    if (money === null) {
      if (merchant === null && hasWords(line) && !NOISE.test(line)) merchant = line;
      continue;
    }

    const label = money.label;
    const amount = money.amount;
    const lower = label.toLowerCase();

    // Order matters: "subtotal" contains "total", and "service tax" contains
    // "tax", so the most specific bucket has to be tested first.
    if (SUBTOTAL.test(lower)) {
      subtotal = amount;
      continue;
    }
    // Discount before the total labels: a "Total Savings 50.00" line matches the
    // lone \btotal\b and would otherwise be taken as the grand total.
    if (DISCOUNT.test(lower)) {
      discounts.push({ label, amount: Math.abs(amount) });
      continue;
    }
    const totalRank = TOTAL_LABELS.findIndex((pattern) => pattern.test(lower));
    if (totalRank !== -1) {
      // Keep the most specific wording seen; on a tie keep the later (lower)
      // line, which on a real receipt is the final amount payable.
      if (!totalCandidate || totalRank <= totalCandidate.rank) {
        totalCandidate = { amount, rank: totalRank };
      }
      continue;
    }
    if (TIP.test(lower)) {
      tip = (tip ?? 0) + amount;
      continue;
    }
    if (SERVICE.test(lower)) {
      serviceCharge = (serviceCharge ?? 0) + amount;
      continue;
    }
    if (TAX.test(lower) || DELIVERY.test(lower)) {
      taxes.push({ label, amount });
      continue;
    }
    if (NOISE.test(lower)) continue;

    // Everything else with a price is an item. A "label" that is really just
    // more digits (a stray total, a code) is kept but marked unsure, so
    // `checkReceipt` surfaces it rather than the parser silently trusting it.
    items.push({
      label: label.length > 0 ? label : '—',
      total: amount,
      confidence: hasWords(label) ? 0.9 : 0.4,
    });
  }

  const itemsTotal = items.reduce((sum, item) => sum + item.total, 0);
  const extras =
    taxes.reduce((sum, tax) => sum + tax.amount, 0) +
    (serviceCharge ?? 0) +
    (tip ?? 0) -
    discounts.reduce((sum, discount) => sum + discount.amount, 0);

  // The printed total is authoritative when the receipt gave us one; otherwise
  // it is the only thing we can say — the sum of what we read.
  const inferredTotal = totalCandidate === null;
  const grandTotal = totalCandidate?.amount ?? Math.max(0, itemsTotal + extras);

  const receipt: ParsedReceipt = {
    merchant,
    date,
    currency,
    items: items.map((item) => ({
      label: item.label,
      qty: 1,
      unitPrice: null,
      total: item.total,
      confidence: item.confidence,
    })),
    subtotal,
    taxes,
    serviceCharge,
    tip,
    discounts,
    grandTotal,
  };

  return { ...receipt, confidence: scoreConfidence(receipt, { inferredTotal }) };
}

/**
 * How much to trust the parse, on the receipt's own checksum.
 *
 * A receipt whose lines add up to its printed total is almost certainly read
 * correctly, so it scores high. One that does not reconcile, or whose total we
 * had to invent because none was printed, or that yielded no items at all, is a
 * draft — scored below {@link LOW_CONFIDENCE} so the caller keeps the manual
 * amount in front of the user.
 */
function scoreConfidence(receipt: ParsedReceipt, flags: { inferredTotal: boolean }): number {
  if (receipt.items.length === 0 && receipt.grandTotal === 0) return 0;

  const check = checkReceipt(receipt);
  let score = check.reconciles ? 0.92 : 0.5;
  if (flags.inferredTotal) score -= 0.25;
  if (receipt.items.length === 0) score -= 0.3;
  // A single unreadable item name drags trust down a little, as it does in the
  // model path — the same LOW_CONFIDENCE threshold decides "look at this".
  if (receipt.items.some((item) => item.confidence < LOW_CONFIDENCE)) score -= 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * The money at the end of a line, in minor units, with the rest as its label.
 *
 * Anchored to the end of the line because that is where a receipt prints its
 * price; a number in the middle (a quantity, a date, an SKU) is left in the
 * label rather than mistaken for the amount. A value in parentheses or led by a
 * minus is negative — how thermal printers show a discount.
 */
function trailingAmount(line: string): { label: string; amount: number } | null {
  // e.g. "Cheese Naan          2  240.00", "TOTAL: ₹1,240.50", "Off  (-50.00)"
  const match = line.match(
    /^(.*?)[\s:]*[(-]?\s*(?:₹|Rs\.?|INR|\$|USD|€|EUR|£|GBP|AED|Dhs?)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*\)?\s*$/i,
  );
  if (!match) return null;

  const [, rawLabel = '', rawNumber = ''] = match;
  const amount = parseMoney(rawNumber);
  if (amount === null) return null;

  const rest = line.slice(rawLabel.length);
  const negative = /^\s*[(-]/.test(rest) || /[(-]\s*$/.test(rawLabel);
  const label = rawLabel.replace(/[\s:.\-–(]+$/, '').trim();
  return { label, amount: negative ? -amount : amount };
}

/**
 * A number as printed → minor units. `1,240.50` → 124050, `12` → 1200.
 *
 * Grouping separators are dropped; a two-decimal fraction becomes the minor
 * part; a bare integer is scaled by 100 on the assumption of a two-decimal
 * currency (the ADR-003 convention almost every target currency here follows).
 */
function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[\s,]/g, '');
  if (cleaned.length === 0) return null;

  const dot = cleaned.indexOf('.');
  if (dot === -1) {
    const whole = Number(cleaned);
    return Number.isFinite(whole) ? Math.round(whole) * 100 : null;
  }

  const whole = Number(cleaned.slice(0, dot) || '0');
  const fraction = cleaned
    .slice(dot + 1)
    .padEnd(2, '0')
    .slice(0, 2);
  const minor = Number(fraction);
  if (!Number.isFinite(whole) || !Number.isFinite(minor)) return null;
  return Math.round(whole) * 100 + minor;
}

/** At least two letters — enough to call it a name rather than a code. */
function hasWords(text: string): boolean {
  return (text.match(/[A-Za-zÀ-ɏ؀-ۿऀ-෿]/g)?.length ?? 0) >= 2;
}

function detectCurrency(text: string): string | null {
  for (const { pattern, code } of CURRENCY_HINTS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

/**
 * A date on the receipt as `YYYY-MM-DD`, or null. Reads the common numeric
 * forms; an ambiguous `03/04/2026` is taken as day-first, which is the majority
 * convention in the markets this app serves (TDR §6 leaves this to the client).
 */
function detectDate(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/);
  if (dmy) {
    const day = dmy[1]!.padStart(2, '0');
    const month = dmy[2]!.padStart(2, '0');
    const year = dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]!;
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}
