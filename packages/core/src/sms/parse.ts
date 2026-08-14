/**
 * Reading a bank SMS into a proposed expense.
 *
 * DEVIATION, recorded deliberately: TDR §10 lists SMS auto-import as out of
 * scope for v1. This module exists because it was asked for directly. It is
 * additive — nothing else depends on it — and the ledger rules are unchanged: a
 * parsed message is a *proposal*, never an entry.
 *
 * Three things this module will not do, all for the same reason:
 *
 *   - it does not touch the network, and nothing here is called from an edge
 *     function. A bank SMS carries an account tail, a balance, and sometimes a
 *     one-time password; sending it anywhere to be parsed would be a worse
 *     privacy trade than the feature is worth (ADR-013);
 *   - it does not write. `proposeFromSms` returns candidates, and a person
 *     confirms each one;
 *   - it does not guess at a split. Who was there is not in the message.
 *
 * Everything is parsed as digits and assembled into minor units. No float ever
 * exists between the text and the amount (ADR-003).
 */

import { minorUnitExponent, type CurrencyCode } from '../money/currency';
import { money, type Money } from '../money/money';

export enum TransactionDirection {
  Debit = 'debit',
  Credit = 'credit',
}

export interface ParsedSms {
  /** What moved, in minor units. */
  readonly amount: Money;
  /** Out of the account, or into it. Only debits can be expenses. */
  readonly direction: TransactionDirection;
  /** Best guess at who was paid. Null when the message does not say. */
  readonly merchant: string | null;
  /** Last digits of the account or card, when present — for telling cards apart. */
  readonly accountTail: string | null;
  /** The bank's own reference, when present. The strongest dedupe key we get. */
  readonly reference: string | null;
  /**
   * When the bank says it happened. Null when the message carries no date, in
   * which case the caller should fall back to when the message arrived — but
   * the distinction matters, because a delayed SMS would otherwise land the
   * expense on the wrong day of a trip.
   */
  readonly occurredAt: string | null;
  /** 0–1. Below `SMS_LOW_CONFIDENCE` the candidate is shown but not pre-selected. */
  readonly confidence: number;
}

/** Below this, a person should look before confirming. */
export const SMS_LOW_CONFIDENCE = 0.7;

/**
 * Currency markers seen in Indian bank SMS. `Rs` and `INR` are the same thing;
 * a bank abroad will say `USD` or use a symbol.
 */
const CURRENCY_MARKERS: ReadonlyArray<readonly [RegExp, CurrencyCode]> = [
  [/(?:INR|Rs\.?|₹)/i, 'INR'],
  // The amount regex matches case-insensitively, so "usd 42" yields an amount;
  // without `i` here the code fell through every marker and defaulted the
  // currency to INR, mislabelling the proposed expense.
  [/(?:USD|\$)/i, 'USD'],
  [/(?:EUR|€)/i, 'EUR'],
  [/(?:GBP|£)/i, 'GBP'],
  [/AED/i, 'AED'],
  [/SGD/i, 'SGD'],
  [/THB/i, 'THB'],
];

/**
 * Words that mean money left the account. Ordered longest-first so that
 * "debited" is not matched by a looser rule before "credited" is considered.
 */
const DEBIT_WORDS = /\b(debited|debit|spent|paid|withdrawn|purchase|sent|deducted)\b/i;
const CREDIT_WORDS = /\b(credited|credit|received|refund|reversed|cashback)\b/i;

/**
 * Messages that look like transactions but are not. A one-time password quotes
 * an amount and would otherwise parse cleanly into an expense somebody never
 * made — this is the single most dangerous false positive in the set, because
 * the number is real and the message is from the right sender.
 */
const NOT_A_TRANSACTION =
  /\b(OTP|one[- ]time\s*password|will\s+be\s+debited|request(?:ed)?\s+(?:for|to)|is\s+due|due\s+on|reminder|failed|declined|unsuccessful|balance\s+is|avl\s*bal|available\s+balance\s+is|statement|e-?mandate|auto[- ]?pay\s+scheduled)\b/i;

/**
 * Amount, as digits: "1,234.56" or "1234" or "1.234,56" is not attempted —
 * Indian and international banks both write "1,23,456.78" or "1,234.56", and
 * both use the dot as the decimal separator.
 */
const AMOUNT = /(?:INR|Rs\.?|₹|USD|\$|EUR|€|GBP|£|AED|SGD|THB)\s*([\d,]+(?:\.\d{1,2})?)/i;

/** "to AMAZON", "at STARBUCKS", "towards SWIGGY" — whoever was paid. */
const MERCHANT =
  /\b(?:to|at|towards|in\s+favour\s+of|VPA)\s+([A-Z0-9][A-Za-z0-9&.'@_-]*(?:\s+[A-Z0-9][A-Za-z0-9&.'@_-]*){0,3})/;

const ACCOUNT_TAIL = /\b(?:a\/c|acct?|account|card|xx+|\*+)\s*(?:no\.?\s*)?[xX*]*(\d{3,6})\b/;
const REFERENCE =
  /\b(?:ref(?:erence)?|txn|transaction|UPI\s*Ref|RRN)\s*(?:no\.?|id)?[:\s]\s*([A-Za-z0-9]{6,})/i;

/** "05-08-26", "05/08/2026", "05-Aug-26". Day first, as Indian banks write it. */
const DATE_NUMERIC = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/;
const DATE_NAMED = /\b(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})\b/;
const TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/;

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

/**
 * "1,23,456.78" → 12345678 minor units, by digits.
 *
 * A message quoting more precision than the currency has is truncated, not
 * rounded: banks do not print a third decimal, so seeing one means the parse
 * went wrong somewhere and inventing a rounding rule would hide that.
 */
function toMinor(text: string, currency: CurrencyCode): bigint {
  const cleaned = text.replace(/,/g, '');
  const exponent = minorUnitExponent(currency);
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);
  return BigInt(whole + padded);
}

function detectCurrency(text: string): CurrencyCode {
  for (const [pattern, code] of CURRENCY_MARKERS) {
    if (pattern.test(text)) return code;
  }
  return 'INR';
}

function detectDate(text: string): string | null {
  const time = TIME.exec(text);
  const clock = time
    ? `T${(time[1] ?? '0').padStart(2, '0')}:${time[2]}:${(time[3] ?? '00').padStart(2, '0')}.000Z`
    : 'T00:00:00.000Z';

  const named = DATE_NAMED.exec(text);
  if (named) {
    const month = MONTHS[(named[2] ?? '').toLowerCase()];
    if (month) return `${expandYear(named[3])}-${pad(month)}-${pad(Number(named[1]))}${clock}`;
  }

  const numeric = DATE_NUMERIC.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    // A day above 12 is unambiguous; otherwise trust the Indian convention.
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${expandYear(numeric[3])}-${pad(month)}-${pad(day)}${clock}`;
    }
  }
  return null;
}

const pad = (value: number): string => String(value).padStart(2, '0');
const expandYear = (raw: string | undefined): string =>
  !raw ? '1970' : raw.length === 4 ? raw : `20${raw.padStart(2, '0')}`;

/**
 * Read one message. Returns null when it is not a transaction at all — which
 * is most of them.
 */
export function parseSms(text: string): ParsedSms | null {
  const body = text.replace(/\s+/g, ' ').trim();
  if (!body) return null;

  // Checked before anything else: an OTP quotes a real amount from a real bank
  // and is the false positive most likely to be confirmed by accident.
  if (NOT_A_TRANSACTION.test(body)) return null;

  const amountMatch = AMOUNT.exec(body);
  if (!amountMatch?.[1]) return null;

  const currency = detectCurrency(body);
  const minor = toMinor(amountMatch[1], currency);
  if (minor <= 0n) return null;

  const debit = DEBIT_WORDS.test(body);
  const credit = CREDIT_WORDS.test(body);
  // Neither, or both, means we cannot tell which way the money went — and a
  // credit booked as an expense is worse than no candidate at all.
  if (debit === credit) return null;

  const merchantMatch = MERCHANT.exec(body);
  // "at SWIGGY. UPI Ref: …" — a merchant name can contain a dot (AMAZON.IN)
  // but a dot followed by a space ends the sentence, and everything after it
  // is the bank talking, not the shop's name.
  const merchant =
    merchantMatch?.[1]
      ?.split(/\.\s/)[0]
      ?.replace(/[.,;:]+$/, '')
      .trim() || null;
  const reference = REFERENCE.exec(body)?.[1] ?? null;
  const accountTail = ACCOUNT_TAIL.exec(body)?.[1] ?? null;
  const occurredAt = detectDate(body);

  // Confidence is about how much of the message we actually understood, not
  // about how plausible the number looks.
  let confidence = 0.55;
  if (merchant) confidence += 0.2;
  if (reference) confidence += 0.15;
  if (occurredAt) confidence += 0.1;
  if (accountTail) confidence += 0.05;

  return {
    amount: money(minor, currency),
    direction: debit ? TransactionDirection.Debit : TransactionDirection.Credit,
    merchant,
    accountTail,
    reference,
    occurredAt,
    confidence: Math.min(1, Number(confidence.toFixed(2))),
  };
}

export interface SmsMessage {
  /** The message body. */
  readonly body: string;
  /** When it arrived, ISO-8601. Used when the message carries no date itself. */
  readonly receivedAt: string;
  /** Sender id, e.g. "AD-HDFCBK". Kept only so a person can recognise it. */
  readonly sender?: string;
}

export interface ExpenseCandidate extends ParsedSms {
  readonly sender: string | null;
  /** The instant to file it under: the bank's, or the message's. */
  readonly at: string;
  /** True when the message itself carried no date and arrival time was used. */
  readonly dateInferred: boolean;
  /** Stable across re-scans, so confirming twice cannot double-post. */
  readonly dedupeKey: string;
  /** False when something needs a person's eye before confirming. */
  readonly preselect: boolean;
}

export interface ProposeOptions {
  /** Trip window, inclusive. ISO dates or instants. */
  readonly from: string;
  readonly to: string;
  /**
   * Dedupe keys already on the ledger. A candidate matching one of these is
   * dropped — re-scanning the inbox must not re-propose what was confirmed.
   */
  readonly alreadyImported?: ReadonlySet<string>;
}

/**
 * The whole feature, as one pure function: an inbox and a trip window in,
 * candidates out. Nothing is written and nothing is sent anywhere.
 */
export function proposeFromSms(
  messages: readonly SmsMessage[],
  options: ProposeOptions,
): ExpenseCandidate[] {
  const from = Date.parse(startOfDay(options.from));
  const to = Date.parse(endOfDay(options.to));
  const seen = new Set<string>();
  const candidates: ExpenseCandidate[] = [];

  for (const message of messages) {
    const parsed = parseSms(message.body);
    if (!parsed) continue;
    // Money coming in is not an expense. Refunds are real and worth showing one
    // day, but as a reversal of a known expense — not as a negative one.
    if (parsed.direction !== TransactionDirection.Debit) continue;

    const at = parsed.occurredAt ?? message.receivedAt;
    const stamp = Date.parse(at);
    if (Number.isNaN(stamp) || stamp < from || stamp > to) continue;

    const key = dedupeKey(parsed, at);
    if (seen.has(key) || options.alreadyImported?.has(key)) continue;
    seen.add(key);

    candidates.push({
      ...parsed,
      sender: message.sender ?? null,
      at,
      dateInferred: parsed.occurredAt === null,
      dedupeKey: key,
      // Pre-selected only when we understood the message well *and* the bank
      // told us when it happened. An inferred date on a trip is exactly the
      // case where an expense silently lands on the wrong day.
      preselect: parsed.confidence >= SMS_LOW_CONFIDENCE && parsed.occurredAt !== null,
    });
  }

  return candidates.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The bank's reference when there is one — it is unique and survives a reworded
 * message. Otherwise amount plus the day, which is the most that can be relied
 * on: the same shop at the same price on the same day is one transaction far
 * more often than two.
 */
export function dedupeKey(parsed: ParsedSms, at: string): string {
  if (parsed.reference) return `ref:${parsed.reference.toUpperCase()}`;
  const day = at.slice(0, 10);
  const merchant = parsed.merchant?.toUpperCase().replace(/\s+/g, '') ?? '?';
  return `amt:${parsed.amount.currency}:${parsed.amount.minor}:${day}:${merchant}`;
}

const startOfDay = (value: string): string =>
  value.length === 10 ? `${value}T00:00:00.000Z` : value;
const endOfDay = (value: string): string =>
  value.length === 10 ? `${value}T23:59:59.999Z` : value;
