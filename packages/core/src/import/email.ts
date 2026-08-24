/**
 * Reading a pasted email — a card statement, or a booking confirmation — into
 * proposed expenses.
 *
 * This is the SMS importer's sibling (sms/parse.ts) and keeps every one of its
 * promises, for the same reasons:
 *
 *   - **on-device only.** Nothing here touches the network and nothing is called
 *     from an edge function. A statement email carries a card number, a running
 *     balance, sometimes an address; parsing it locally is the whole point
 *     (ADR-013). The person pastes the text; the text never leaves the phone.
 *   - **it proposes, never writes.** `proposeFromEmail` returns candidates a
 *     person confirms one by one.
 *   - **it does not guess a split.** Who was on the trip is not in the email.
 *   - **digits to minor units, never a float** (ADR-003).
 *
 * The difference from an SMS is shape. An SMS is one message about one
 * transaction; an email is often a *table* — many statement rows, each its own
 * expense — or a single confirmation with the total in the body and the date in
 * a header. So this reads line by line, pulls a document-level date to fall back
 * on, and treats a line as an outflow unless it clearly says money came in
 * (a statement lists what you spent; a booking is something you paid for).
 *
 * The dedupe key is the SMS module's own (`dedupeKey`), so a transaction that
 * arrives once by SMS and once on the month's statement is one candidate, not
 * two.
 */

import { categoriseMerchant } from '../category/merchant';
import { CategoryId } from '../category/categories';
import { minorUnitExponent, type CurrencyCode } from '../money/currency';
import { money } from '../money/money';
import {
  dedupeKey,
  SMS_LOW_CONFIDENCE,
  TransactionDirection,
  type ExpenseCandidate,
  type ParsedSms,
} from '../sms/parse';

/** A candidate from an email — the SMS shape plus the guessed category. */
export interface EmailExpenseCandidate extends ExpenseCandidate {
  /** From `categoriseMerchant`; null when nothing is recognised. */
  readonly category: CategoryId | null;
}

export interface ProposeFromEmailOptions {
  /** Trip window, inclusive. ISO dates or instants. Omitted → no window filter. */
  readonly from?: string;
  readonly to?: string;
  /** When the email arrived, ISO-8601. The last resort for a line with no date. */
  readonly receivedAt?: string;
  /** Statement's own market, forwarded to the categoriser's market vocabulary. */
  readonly countryCode?: string | null;
  /** Dedupe keys already on the ledger; a matching candidate is dropped. */
  readonly alreadyImported?: ReadonlySet<string>;
  /** Safety cap on a pathological paste. Default 300. */
  readonly maxCandidates?: number;
}

/** Currency written before the number: "INR 420.00", "$ 12.50", "₹1,234". */
const AMOUNT_BEFORE =
  /(INR|Rs\.?|₹|US\$|USD|\$|EUR|€|GBP|£|AED|SGD|THB|JPY|¥)\s*([\d,]+(?:\.\d{1,2})?)/i;
/** Currency written after the number: "420.00 INR", "12.50 USD". */
const AMOUNT_AFTER = /(?<![%\d.])([\d,]+(?:\.\d{1,2})?)\s*(INR|USD|EUR|GBP|AED|SGD|THB|JPY)\b/i;

const MARKER_TO_CODE: ReadonlyArray<readonly [RegExp, CurrencyCode]> = [
  [/^(?:INR|Rs\.?|₹)$/i, 'INR'],
  [/^(?:US\$|USD|\$)$/i, 'USD'],
  [/^(?:EUR|€)$/i, 'EUR'],
  [/^(?:GBP|£)$/i, 'GBP'],
  [/^AED$/i, 'AED'],
  [/^SGD$/i, 'SGD'],
  [/^THB$/i, 'THB'],
  [/^(?:JPY|¥)$/i, 'JPY'],
];

/** Money came in, not out — skip these lines (a refund is not an expense). */
const CREDIT_WORDS = /\b(credited|\bCr\b|received|refund|reversed|cashback|repayment)\b/i;
/** Explicit outflow markers on a statement row. */
const DEBIT_WORDS = /\b(debited|\bDr\b|spent|paid|purchase|charged|withdrawn)\b/i;

/** Header/summary rows that quote numbers but are not transactions. */
const NON_TRANSACTION =
  /\b(opening|closing|available|avl|outstanding|total\s+due|minimum\s+due|min\s+due|statement|balance\s+(?:b\/f|c\/f|forward)|page\s+\d)\b/i;

/**
 * The component lines of a single itemised bill — a subtotal, a tax, a tip, a
 * fee. They break down a total; they are not expenses on their own. Deliberately
 * excludes the total itself ("Total", "Amount payable") so the total survives as
 * the one candidate. Applied only to lines with no date of their own, so a dated
 * card-statement fee row is untouched.
 */
const BREAKDOWN_LABEL =
  /\b(sub[-\s]?total|taxes?|gst|vat|service\s*charge|service\s*fee|tip|gratuity|convenience\s*fee|booking\s*fee|processing\s*fee|surcharge|discount|fees?)\b/i;

const DATE_NUMERIC = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/;
const DATE_NAMED = /\b(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})\b/;
const NAMED_DATE_FIRST = /\b([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})\b/; // "Aug 14, 2026"

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const pad = (value: number): string => String(value).padStart(2, '0');
const expandYear = (raw: string | undefined): string =>
  !raw ? '1970' : raw.length === 4 ? raw : `20${raw.padStart(2, '0')}`;

/** "1,23,456.78" → minor units for the currency, by digits. No float (ADR-003). */
function toMinor(text: string, currency: CurrencyCode): bigint {
  const cleaned = text.replace(/,/g, '');
  const exponent = minorUnitExponent(currency);
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);
  const digits = (whole + padded).replace(/\D/g, '');
  return digits ? BigInt(digits) : 0n;
}

function markerToCode(marker: string): CurrencyCode {
  for (const [pattern, code] of MARKER_TO_CODE) {
    if (pattern.test(marker.trim())) return code;
  }
  return 'INR';
}

/** A `YYYY-MM-DD` from a line, or null. Day-first for numeric, per Indian banks. */
function detectDate(text: string): string | null {
  const namedFirst = NAMED_DATE_FIRST.exec(text);
  if (namedFirst) {
    const month = MONTHS[(namedFirst[1] ?? '').toLowerCase()];
    if (month) return `${namedFirst[3]}-${pad(month)}-${pad(Number(namedFirst[2]))}`;
  }
  const named = DATE_NAMED.exec(text);
  if (named) {
    const month = MONTHS[(named[2] ?? '').toLowerCase()];
    if (month) return `${expandYear(named[3])}-${pad(month)}-${pad(Number(named[1]))}`;
  }
  const numeric = DATE_NUMERIC.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${expandYear(numeric[3])}-${pad(month)}-${pad(day)}`;
    }
  }
  return null;
}

/** The amount on a line: currency-before form preferred, then currency-after. */
function detectAmount(line: string): { minor: bigint; currency: CurrencyCode } | null {
  const before = AMOUNT_BEFORE.exec(line);
  if (before?.[2]) {
    const currency = markerToCode(before[1] ?? '');
    const minor = toMinor(before[2], currency);
    if (minor > 0n) return { minor, currency };
  }
  const after = AMOUNT_AFTER.exec(line);
  if (after?.[1] && after[2]) {
    const currency = markerToCode(after[2]);
    const minor = toMinor(after[1], currency);
    if (minor > 0n) return { minor, currency };
  }
  return null;
}

/**
 * Boilerplate that surrounds a total but is not a merchant name. Struck out so a
 * line like "Total charged: THB 5,600" yields no merchant rather than the false
 * name "Total charged" — which would then defeat categorisation.
 */
const MERCHANT_STOPWORDS = new Set<string>([
  'total',
  'charged',
  'amount',
  'paid',
  'payment',
  'booking',
  'confirmed',
  'transaction',
  'txn',
  'debit',
  'credit',
  'debited',
  'credited',
  'balance',
  'card',
  'statement',
  'ref',
  'reference',
  'description',
  'date',
  'the',
  'your',
  'for',
  'was',
]);

/**
 * The merchant on a line: the words left once the amount, the date, the
 * direction markers and boilerplate are struck out. A short, cleaned name —
 * never the whole row. Null when nothing readable remains.
 */
function detectMerchant(line: string): string | null {
  const stripped = line
    .replace(AMOUNT_BEFORE, ' ')
    .replace(AMOUNT_AFTER, ' ')
    .replace(NAMED_DATE_FIRST, ' ')
    .replace(DATE_NAMED, ' ')
    .replace(DATE_NUMERIC, ' ')
    .replace(/\b(Dr|Cr)\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/[|;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep words that are a name — has a letter, and is not boilerplate around a
  // total ("Total charged", "Amount paid"). Cap the length so a whole sentence
  // never becomes a "merchant".
  const cleaned = stripped
    .split(/\s+/)
    .filter((word) => /[\p{L}]/u.test(word) && !MERCHANT_STOPWORDS.has(word.toLowerCase()))
    .slice(0, 5)
    .join(' ')
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

const startOfDay = (value: string): string =>
  value.length === 10 ? `${value}T00:00:00.000Z` : value;
const endOfDay = (value: string): string =>
  value.length === 10 ? `${value}T23:59:59.999Z` : value;

/**
 * A merchant named somewhere in a confirmation's prose — "stay at Marriott",
 * "booking at Taj", "flight with Indigo". Used only to enrich a single-
 * transaction email, where the name and the amount sit on different lines. A
 * statement's rows each carry their own merchant and never reach this.
 */
const DOCUMENT_MERCHANT =
  /\b(?:stay(?:ing)?\s+at|booking\s+(?:at|with)|reservation\s+at|hotel|with|at)\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})/;

function documentMerchant(text: string): string | null {
  const match = DOCUMENT_MERCHANT.exec(text);
  return match?.[1]?.replace(/\b(is|are|has|have)\b.*$/i, '').trim() || null;
}

/**
 * An email in, candidates out. Pure: nothing is written and nothing is sent.
 *
 * Sorted by date. Deduped within the paste and against `alreadyImported`. A
 * paste with no recognisable transactions returns an empty list — the common
 * case for a marketing email or a plain note.
 */
export function proposeFromEmail(
  text: string,
  options: ProposeFromEmailOptions = {},
): EmailExpenseCandidate[] {
  if (!text || !text.trim()) return [];

  const windowFrom = options.from ? Date.parse(startOfDay(options.from)) : null;
  const windowTo = options.to ? Date.parse(endOfDay(options.to)) : null;
  const max = options.maxCandidates ?? 300;

  // A date named once at the top of a confirmation stands in for lines that
  // carry none of their own.
  const documentDate = detectDate(text.replace(/\s+/g, ' '));

  const seen = new Set<string>();
  const candidates: EmailExpenseCandidate[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (candidates.length >= max) break;
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (NON_TRANSACTION.test(line)) continue;

    const amount = detectAmount(line);
    if (!amount) continue;

    // Money in is not an expense. A credit/refund word disqualifies the line
    // even when it also carries debit vocabulary — "REFUND processed, debited
    // back" is income; a real spend has no reason to say "refund" at all.
    if (CREDIT_WORDS.test(line)) continue;

    const lineDate = detectDate(line);
    const occurredAt = lineDate ?? documentDate;
    const at = occurredAt ?? options.receivedAt ?? null;
    if (!at) continue; // nothing to file it under; drop rather than invent a day

    // A confirmation itemises one bill — "Subtotal … Tax … Total". Those parts
    // are not separate expenses; only the total is. A breakdown line that
    // carries no date of its own is such a part and is dropped, leaving the
    // total as the single candidate. A *statement* fee row carries its own
    // date, so it keeps that date and is not mistaken for a breakdown part.
    if (BREAKDOWN_LABEL.test(line) && lineDate === null) continue;

    const stamp = Date.parse(startOfDay(at));
    if (Number.isNaN(stamp)) continue;
    if (windowFrom !== null && stamp < windowFrom) continue;
    if (windowTo !== null && stamp > windowTo) continue;

    const merchant = detectMerchant(line);

    let confidence = 0.5;
    if (merchant) confidence += 0.2;
    if (lineDate) confidence += 0.15;
    if (DEBIT_WORDS.test(line)) confidence += 0.1;

    const parsed: ParsedSms = {
      amount: money(amount.minor, amount.currency),
      direction: TransactionDirection.Debit,
      merchant,
      accountTail: null,
      reference: null,
      occurredAt,
      confidence: Math.min(1, Number(confidence.toFixed(2))),
    };

    const key = dedupeKey(parsed, startOfDay(at));
    if (seen.has(key) || options.alreadyImported?.has(key)) continue;
    seen.add(key);

    candidates.push({
      ...parsed,
      category: categoriseMerchant(merchant, options.countryCode),
      sender: null,
      at: startOfDay(at),
      dateInferred: lineDate === null,
      dedupeKey: key,
      preselect: parsed.confidence >= SMS_LOW_CONFIDENCE && lineDate !== null,
    });
  }

  // A confirmation names its merchant in prose, a line away from the total. When
  // the whole email is about one transaction, it is safe to read that name and
  // its category from the document; a multi-row statement is left untouched,
  // since document-wide text cannot be attributed to any one row.
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only && only.category === null) {
    const collapsed = text.replace(/\s+/g, ' ');
    const docMerchant = documentMerchant(collapsed);
    const merchant = docMerchant ?? only.merchant;
    const category = categoriseMerchant(
      docMerchant ?? only.merchant ?? collapsed,
      options.countryCode,
    );
    candidates[0] = { ...only, merchant, category };
  }

  return candidates.sort((a, b) => a.at.localeCompare(b.at));
}
