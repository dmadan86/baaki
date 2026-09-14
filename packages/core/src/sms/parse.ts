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
 *
 * ## Never guess silently
 *
 * Three things in a bank message are genuinely undecidable from the text:
 * `08/05/2026` is two different days, `1.234` is two amounts a thousand apart,
 * and `$` is seven currencies. The rule this file follows everywhere is that
 * such a thing is either settled by an explicit signal — the caller's region,
 * locale or default currency, passed in as {@link SmsParseContext} — or it is
 * decided by one documented fallback *and reported*, in `inferred`, with the
 * confidence lowered to match. A parser that guesses is fine. A parser that
 * guesses and then looks certain puts an expense on the wrong day of a trip.
 *
 * The context is entirely optional and every path works without it. A caller
 * that knows the user's country simply gets a better answer, and Waves knows
 * the user's country.
 */

import { minorUnitExponent, isCurrencyCode, type CurrencyCode } from '../money/currency';
import { money, type Money } from '../money/money';
import { normaliseForParsing, foldToken } from '../text/digits';
import {
  ACCOUNT_TAIL,
  BALANCE_ONLY,
  BALANCE_WORDS,
  CARD_PHRASES,
  CREDIT_SOURCE,
  CREDIT_WORDS,
  DEBIT_SOURCE,
  DEBIT_WORDS,
  MERCHANT_DETERMINERS,
  MERCHANT_NOISE,
  MERCHANT_PREPOSITIONS,
  MERCHANT_STOP_WORDS,
  UPI_SEGMENT_CODES,
  MONTHS,
  NOT_A_TRANSACTION,
  REFERENCE,
} from './vocabulary';
import {
  CURRENCY_TOKEN_SOURCE,
  dateOrderFor,
  decimalSeparatorFor,
  looksLikeBankSender,
  resolveCurrency,
  type InferredField,
  type SmsParseContext,
} from './locale';

export type { InferredField, SmsParseContext, DateOrder } from './locale';
export { senderHeader, looksLikeBankSender } from './locale';

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
  /**
   * Which fields the parser had to decide for itself because the message and
   * the context between them did not say.
   *
   * This is the honest half of the confidence score: a caller can point at the
   * exact field to check rather than telling somebody the whole row is doubtful
   * and leaving them to find out which part.
   */
  readonly inferred: readonly InferredField[];
  /** 0–1. Below `SMS_LOW_CONFIDENCE` the candidate is shown but not pre-selected. */
  readonly confidence: number;
}

/** Below this, a person should look before confirming. */
export const SMS_LOW_CONFIDENCE = 0.7;

/* ------------------------------------------------------------------ *
 * Folding
 * ------------------------------------------------------------------ */

/**
 * Letters with no Unicode decomposition, so `normalize('NFD')` cannot strip
 * them down to a base letter. Each replacement is exactly one character long,
 * which is the whole constraint: the fold must not change the string's length.
 */
const UNDECOMPOSABLE: Readonly<Record<string, string>> = Object.freeze({
  ß: 's',
  Ø: 'O',
  ø: 'o',
  Đ: 'D',
  đ: 'd',
  Ł: 'L',
  ł: 'l',
  ı: 'i',
  ħ: 'h',
  Æ: 'A',
  æ: 'a',
  Œ: 'O',
  œ: 'o',
  Ð: 'D',
  ð: 'd',
  Þ: 'T',
  þ: 't',
});

const ACCENTED = /[\u00c0-\u024f\u1e00-\u1eff]/g;

/**
 * `débité` to `debite`, `ağustos` to `agustos`, `số` to `so` — **without
 * changing the length of the string**.
 *
 * That constraint is what lets the whole file work: every word list is written
 * unaccented and matched against the folded text, while merchant names are
 * sliced out of the *original* text at the indices the folded match reported.
 * Strip the accents with NFD instead and every index after the first accent in
 * the message points one character to the left, which is a bug that only shows
 * up in French.
 */
function foldLatin(text: string): string {
  return text.replace(ACCENTED, (character) => {
    const direct = UNDECOMPOSABLE[character];
    if (direct) return direct;
    const base = character.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return base.length === 1 ? base : character;
  });
}

/** The card phrases blanked out, same length, so every other index still holds. */
function maskCards(text: string): string {
  return text.replace(CARD_PHRASES, (match) => ' '.repeat(match.length));
}

/* ------------------------------------------------------------------ *
 * Amounts
 * ------------------------------------------------------------------ */

/**
 * A written number, in the four shapes the world writes them in.
 *
 * Ordered longest-first, because the alternation is tried in order and the
 * shortest form would otherwise swallow `1,23` out of `1,23,456.78`. Every
 * group is non-capturing so this can be embedded in larger patterns without
 * renumbering their groups, and the whole thing ends with a lookahead refusing
 * a trailing digit: without it `500 123456` reads as `500 123`.
 *
 *   1. space, apostrophe or non-breaking space grouping — `1 234,56` (fr, ru),
 *      `1'234.56` (ch);
 *   2. comma or dot grouping with the other as the decimal — `1,234.56`,
 *      `1.234,56`, and India's `1,23,456.78`;
 *   3. a single separator, which is the ambiguous case — see `readNumber`;
 *   4. bare digits.
 */
const NUMBER_SOURCE =
  "(?:\\d{1,3}(?:['\u2019 \u00a0\u202f\u2009\u2007]\\d{3})+(?:[.,]\\d{1,4})?" +
  '|\\d{1,3}(?:[.,]\\d{2,3})+(?:[.,]\\d{1,4})?' +
  '|\\d+(?:[.,]\\d{1,4})?)(?!\\d)';

const AMOUNT_LEADING = new RegExp(`(${CURRENCY_TOKEN_SOURCE})\\s*(${NUMBER_SOURCE})`, 'gi');
const AMOUNT_TRAILING = new RegExp(`(${NUMBER_SOURCE})\\s*(${CURRENCY_TOKEN_SOURCE})`, 'gi');

/**
 * A number with no currency token at all, which is how State Bank of India —
 * the country's largest bank — writes every UPI alert: `debited by 150.0`.
 *
 * Only ever reached when no currency-marked amount was found, and only when a
 * transaction verb introduces the number, because a bare number in a bank
 * message is far more often a date, an account tail or a helpline.
 */
const AMOUNT_AFTER_VERB = new RegExp(
  `(?:${DEBIT_SOURCE}|${CREDIT_SOURCE})\\s*(?:by|for|with|of|:|-)?\\s*(${NUMBER_SOURCE})`,
  'giu',
);
const AMOUNT_BEFORE_VERB = new RegExp(
  `(${NUMBER_SOURCE})\\s*(?:(?:has|have|was|were|is|are)\\s+(?:been\\s+)?)?(?:${DEBIT_SOURCE}|${CREDIT_SOURCE})`,
  'giu',
);

interface AmountMatch {
  /** The digits as written. */
  readonly token: string;
  /** The currency marker beside it, when there was one. */
  readonly marker: string | null;
  /** Where the digits start, in the collapsed message. */
  readonly index: number;
}

/** Ranges in the message where a balance is being reported. */
function balanceRanges(folded: string): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = [];
  BALANCE_WORDS.lastIndex = 0;
  for (const match of folded.matchAll(BALANCE_WORDS)) {
    if (match.index === undefined) continue;
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * A number that is plainly not an amount: part of a date, part of a card tail,
 * or a reference long enough that no shop charges it.
 */
function looksLikeIdentifier(text: string, index: number, token: string): boolean {
  const before = index > 0 ? text[index - 1] : '';
  const after = text.slice(index + token.length, index + token.length + 2);
  if (before && /[\d\-/:xX*]/.test(before)) return true;
  if (/^[-/:]\d/.test(after)) return true;
  return !/[.,]/.test(token) && token.replace(/\D/g, '').length >= 9;
}

function collect(pattern: RegExp, text: string, markerFirst: boolean): AmountMatch[] {
  const found: AmountMatch[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const marker = markerFirst ? (match[1] ?? null) : (match[2] ?? null);
    const token = markerFirst ? match[2] : match[1];
    if (!token) continue;
    const index = match.index + match[0].indexOf(token);
    if (looksLikeIdentifier(text, index, token)) continue;
    found.push({ token, marker, index });
  }
  return found;
}

/**
 * The transaction's amount, out of however many numbers the message quotes.
 *
 * Two amounts in one message is the normal case, not the exception — almost
 * every debit alert carries the running balance as a trailer. The old parser
 * took the first number and was right by luck, because Indian banks quote the
 * transaction first. This takes the first number that is *not* sitting behind a
 * balance word, which is the same answer for those messages and the right one
 * for a bank that leads with the balance.
 */
function findAmount(raw: string, folded: string): AmountMatch | null {
  let candidates = [...collect(AMOUNT_LEADING, raw, true), ...collect(AMOUNT_TRAILING, raw, false)];
  if (candidates.length === 0) {
    candidates = [
      ...collect(AMOUNT_AFTER_VERB, folded, false),
      ...collect(AMOUNT_BEFORE_VERB, folded, false),
    ];
  }
  if (candidates.length === 0) return null;

  const byPosition = [...candidates].sort((a, b) => a.index - b.index);
  const balances = balanceRanges(folded);
  const isBalance = (candidate: AmountMatch): boolean =>
    balances.some(([, end]) => end <= candidate.index && candidate.index - end <= 12);

  return byPosition.find((candidate) => !isBalance(candidate)) ?? byPosition[0] ?? null;
}

interface NumberReading {
  readonly minor: bigint;
  /** True when the decimal separator was a coin flip rather than a deduction. */
  readonly separatorInferred: boolean;
}

/**
 * Digits on the page to integer minor units, deciding which separator was the
 * decimal point and which was grouping.
 *
 * The cases in order, and why each one is safe:
 *
 *   - **both a dot and a comma appear.** The later one is the decimal point.
 *     No locale writes it the other way, so `1.234,56` and `1,234.56` are both
 *     settled outright.
 *   - **one kind, more than once.** `1.234.567` and India's `1,23,456` can only
 *     be grouping; nothing has two decimal points.
 *   - **one separator, fewer than three digits after it.** Grouping is always
 *     in threes, so this is a decimal point.
 *   - **one separator, exactly three digits after it.** The genuinely ambiguous
 *     case — and for almost every currency it is not ambiguous at all, because
 *     a currency with two minor digits cannot have three. So the currency's own
 *     exponent settles it, and `EUR 1.234` reads as one thousand two hundred
 *     and thirty-four rather than as €1.23. Only the three-decimal currencies
 *     (KWD, BHD, OMR, JOD, TND) are left genuinely open; there the caller's
 *     locale decides, and with no locale the fallback is reported as inferred.
 *
 * More fraction digits than the currency has are truncated rather than rounded,
 * which is the old rule kept deliberately: inventing a rounding here would hide
 * a parse that went wrong. A zero-decimal currency therefore never acquires
 * phantom minor units — `JPY 1,234.00` is ¥1,234, not ¥123,400.
 */
function readNumber(
  token: string,
  currency: CurrencyCode,
  context: SmsParseContext,
): NumberReading | null {
  // Spaces and apostrophes are only ever grouping — no locale uses either as a
  // decimal point — so they can go before anything is decided.
  const cleaned = token.replace(/['\u2019 \u00a0\u202f\u2009\u2007]/g, '');
  if (!/^\d/.test(cleaned)) return null;

  const exponent = minorUnitExponent(currency);
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  const dots = (cleaned.match(/\./g) ?? []).length;
  const commas = (cleaned.match(/,/g) ?? []).length;

  let decimalAt = -1;
  let separatorInferred = false;

  if (dots > 0 && commas > 0) {
    decimalAt = Math.max(lastDot, lastComma);
  } else if (dots + commas > 1) {
    decimalAt = -1;
  } else if (dots + commas === 1) {
    const at = dots === 1 ? lastDot : lastComma;
    const separator = cleaned[at] === '.' ? '.' : ',';
    const after = cleaned.length - at - 1;
    const before = at;
    if (after === 0) {
      decimalAt = -1;
    } else if (after !== 3 || before > 3) {
      decimalAt = at;
    } else if (exponent !== 3) {
      // Grouping: a two- or zero-decimal currency cannot carry three of them.
      decimalAt = -1;
    } else {
      const locale = decimalSeparatorFor(context);
      decimalAt = (locale ?? '.') === separator ? at : -1;
      separatorInferred = locale === null;
    }
  }

  if (!/^\d+$/.test(cleaned.replace(/[.,]/g, ''))) return null;

  const whole = (decimalAt === -1 ? cleaned : cleaned.slice(0, decimalAt)).replace(/[.,]/g, '');
  const fraction = decimalAt === -1 ? '' : cleaned.slice(decimalAt + 1).replace(/[.,]/g, '');
  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);
  return { minor: BigInt((whole || '0') + padded), separatorInferred };
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

const DATE_ISO = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s:](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
// `(?!\d)` on the day is what stops the month-first pattern reading `Okt 2026`
// as the 20th of October: without it `\d{1,2}` happily takes the `20` out of
// the year and leaves `26` behind as one.
// The optional `de`/`di`/`of` is Spanish and Portuguese writing the date out in
// full — "12 de dezembro de 2026" — which is the ordinary form on a Brazilian
// card alert, not a flourish.
const DATE_DAY_FIRST =
  /(\d{1,2})(?!\d)[-./]?\s*(?:(?:de|di|of)\s+)?(\p{L}{3,12})[-./,]?\s*(?:(?:de|del|di)\s+)?(\d{2,4})\b/gu;
const DATE_MONTH_FIRST = /(\p{L}{3,12})[-./]?\s*(\d{1,2})(?!\d)(?:st|nd|rd|th)?,?\s*(\d{2,4})\b/gu;
const DATE_NUMERIC = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/;
const TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/;

/**
 * A month name in any of the languages the vocabulary covers, or null.
 *
 * Looked up longest key first so French `juin` (6) and `juillet` (7) do not
 * collapse into a shared `jui`.
 */
function monthOf(word: string): number | null {
  const folded = foldToken(word);
  return MONTHS[folded] ?? MONTHS[folded.slice(0, 4)] ?? MONTHS[folded.slice(0, 3)] ?? null;
}

interface DateReading {
  readonly iso: string;
  /** True when day-versus-month order was a fallback rather than a deduction. */
  readonly orderInferred: boolean;
}

const pad = (value: number): string => String(value).padStart(2, '0');
const expandYear = (raw: string | undefined): string =>
  !raw ? '1970' : raw.length === 4 ? raw : `20${raw.padStart(2, '0')}`;

const validDay = (day: number, month: number): boolean =>
  day >= 1 && day <= 31 && month >= 1 && month <= 12;

/**
 * The first match whose middle word is really a month name.
 *
 * Rewinds to one character past the *start* of a rejected match rather than
 * past its end, which matters more than it looks: `harcama 12 Agustos 2026`
 * matches the pattern once with `harcama` in the month slot, and skipping past
 * that whole match would swallow the real date sitting inside it.
 */
function scanNamed(
  pattern: RegExp,
  text: string,
  dayGroup: number,
  monthGroup: number,
): DateReading | null {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const month = monthOf(match[monthGroup] ?? '');
    const day = Number(match[dayGroup]);
    if (month !== null && validDay(day, month)) {
      const end = match.index + match[0].length;
      return {
        iso: `${expandYear(match[3])}-${pad(month)}-${pad(day)}${clockOutside(text, match.index, end)}`,
        orderInferred: false,
      };
    }
    pattern.lastIndex = match.index + 1;
    match = pattern.exec(text);
  }
  return null;
}

/** The clock in the message, ignoring the span the date itself occupies. */
function clockOutside(text: string, from: number, to: number): string {
  const masked = `${text.slice(0, from)}${' '.repeat(to - from)}${text.slice(to)}`;
  const time = TIME.exec(masked);
  if (!time) return 'T00:00:00.000Z';
  return `T${(time[1] ?? '0').padStart(2, '0')}:${time[2]}:${(time[3] ?? '00').padStart(2, '0')}.000Z`;
}

const clockOf = (hour?: string, minute?: string, second?: string): string =>
  minute
    ? `T${(hour ?? '0').padStart(2, '0')}:${minute}:${(second ?? '00').padStart(2, '0')}.000Z`
    : 'T00:00:00.000Z';

/**
 * When the bank says it happened.
 *
 * ISO first, then a named month in either order, then bare numbers — and the
 * bare numbers are the hard case. `08/05/2026` is the 8th of May in every
 * market Waves ships in and the 5th of August in the United States, and the
 * message itself contains nothing that tells them apart. So: a component over
 * twelve settles it outright, otherwise the caller's region settles it, and
 * with neither the fallback is day-first — the order most of the world writes —
 * reported back as inferred so the confidence drops and the UI can say which
 * field to check.
 */
function detectDate(raw: string, context: SmsParseContext): DateReading | null {
  const iso = DATE_ISO.exec(raw);
  if (iso?.[1] && iso[2] && iso[3]) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (validDay(day, month)) {
      return {
        iso: `${iso[1]}-${pad(month)}-${pad(day)}${clockOf(iso[4], iso[5], iso[6])}`,
        orderInferred: false,
      };
    }
  }

  const dayFirst = scanNamed(DATE_DAY_FIRST, raw, 1, 2);
  if (dayFirst) return dayFirst;

  const monthFirst = scanNamed(DATE_MONTH_FIRST, raw, 2, 1);
  if (monthFirst) return monthFirst;

  const numeric = DATE_NUMERIC.exec(raw);
  if (numeric?.[1] && numeric[2]) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const { order, explicit } = dateOrderFor(context);

    let day = order === 'mdy' ? second : first;
    let month = order === 'mdy' ? first : second;
    let inferred = !explicit;

    // A component over twelve is not a month, whatever the locale says. That
    // settles most real messages without any context at all.
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
      inferred = false;
    } else if (second > 12 && first <= 12) {
      day = second;
      month = first;
      inferred = false;
    } else if (first === second) {
      inferred = false; // 05/05 reads the same either way
    }

    if (validDay(day, month)) {
      const end = numeric.index + numeric[0].length;
      return {
        iso: `${expandYear(numeric[3])}-${pad(month)}-${pad(day)}${clockOutside(raw, numeric.index, end)}`,
        orderInferred: inferred,
      };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Merchant
 * ------------------------------------------------------------------ */

const PREPOSITION = new RegExp(`(?:${MERCHANT_PREPOSITIONS})\\s*`, 'giu');
const PAYEE_CREDITED =
  /([\p{L}\p{N}][\p{L}\p{N}&.'_-]{1,30})\s+(?:credited|creditado|acreditado)\b/iu;

/** A long digit run is a reference, not a shop. */
const isLongNumber = (token: string): boolean => /^\d{5,}$/.test(token);

/** `12/09/2026` or `12-09-26`: the date that follows the shop's name, not part of it. */
const isDateToken = (token: string): boolean =>
  /^\d{1,4}[-/.]\d{1,2}(?:[-/.]\d{2,4})?[.,;:]?$/.test(token);

/**
 * Whoever was paid, read out of the words after "to", "at", "chez", "bei", "di".
 *
 * The old version produced `VPA` and `A` — the literal word before a UPI
 * address, and the `A` of `A/c` — and scored both at full confidence. A row
 * reading `A` is worse than a row reading nothing, because it looks parsed and
 * a person has to notice it is nonsense. So a capture has to survive a
 * plausibility test before it counts as a merchant at all, and an implausible
 * one is skipped rather than returned: the parser keeps looking.
 */
/**
 * The words of a name, cut where the bank starts talking again.
 *
 * One rule, used by both readers. The prose reader has always needed it; the
 * reference reader needs exactly the same one, because a reference is not
 * always followed by a full stop — `UPI/P2M/987654321/ZOMATO LTD Avl Bal INR
 * 900` runs straight on, and a reader that only stopped at sentence ends would
 * produce "ZOMATO LTD Avl Bal". Sharing the rule rather than writing a second
 * one is the point: every marker learned in one place is known in both.
 */
function keepWords(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (const word of words) {
    const folded = foldToken(word.replace(/[.,;:]+$/, ''));
    if (!folded) break;
    if (MERCHANT_NOISE.has(folded) || MERCHANT_STOP_WORDS.has(folded)) break;
    if (isLongNumber(folded) || isDateToken(word)) break;
    kept.push(word);
    if (kept.length === 4) break;
  }
  return kept;
}

function readMerchant(tail: string): string | null {
  // A dot followed by a space ends the sentence; everything after it is the
  // bank talking. A merchant name can still contain a dot (AMAZON.IN).
  const sentence = (tail.split(/\.\s|;|\|/)[0] ?? '').trim();
  const words = sentence.split(/\s+/).slice(0, 6);

  let start = 0;
  while (start < words.length && MERCHANT_DETERMINERS.has(foldToken(words[start] ?? '')))
    start += 1;

  const kept = keepWords(words.slice(start));

  let name = kept
    .join(' ')
    .replace(/[.,;:]+$/, '')
    .trim();
  // A UPI address or an email is the handle, not the domain: swiggy@icici is
  // SWIGGY, and showing the bank's name instead would be actively misleading.
  if (kept.length === 1 && name.includes('@')) name = name.split('@')[0] ?? name;

  return plausibleMerchant(name) ? name : null;
}

function plausibleMerchant(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  if (MERCHANT_STOP_WORDS.has(foldToken(trimmed))) return false;
  // A bare number, a date, or punctuation: all of these are the message's
  // furniture rather than a shop.
  if (/^[\d\s.,:/@#*-]+$/.test(trimmed)) return false;
  return detectDate(trimmed, {}) === null;
}

/**
 * A UPI reference, and the name hiding in the middle of it.
 *
 * India's banks do not put the payee in the sentence. They put it inside a
 * slash-separated reference — `UPI/P2M/526012345678/ZOMATO LTD` — and write the
 * sentence around the account number instead. So a parser that reads only the
 * prose finds a preposition, follows it to "A/c no. XX9811", rejects that as
 * implausible, and correctly returns nothing. Every UPI payment on the phone
 * then reads "No shop named", which is most of them.
 *
 * The reference is a better source than the prose, not a worse one: it is
 * written by the payment rails rather than composed by a bank's copywriter, so
 * it has the same shape across every bank in the country.
 *
 * Segments are taken in order and the first that could be a name wins. Three
 * kinds are skipped, each for its own reason:
 *
 *   * **The codes.** `P2M`, `P2A`, `CR` — these sit exactly where a name could,
 *     so a reader taking the first lettered segment files a payment under "P2M".
 *   * **The reference number.** A long digit run is the RRN, never a shop.
 *   * **A bare VPA.** `rahul@okaxis` is kept, but as its handle — the bank
 *     after the `@` is not who was paid.
 *
 * Deliberately not anchored to the word "UPI" alone: `IMPS`, `NEFT` and `FT`
 * references are built the same way and carry the counterparty in the same place.
 */
// The space matters: a payee segment is "RAHUL SHARMA", not "RAHUL". Without it
// the class stops at the first word and the reference yields half a name, which
// looks like a parse rather than a truncation.
const UPI_REFERENCE = /\b(?:UPI|IMPS|NEFT|RTGS|FT)[/-][\p{L}\p{N}@._/ -]{4,120}/giu;

function readUpiCounterparty(raw: string): string | null {
  UPI_REFERENCE.lastIndex = 0;
  for (const match of raw.matchAll(UPI_REFERENCE)) {
    // Allowing spaces means the match can run past the reference into the
    // sentence after it ("… /RAHUL SHARMA. Avl Bal- INR 15000"). A full stop
    // followed by a space ends it, exactly as it does for the prose reader.
    const reference = (match[0].split(/\.\s/)[0] ?? '').replace(/[.,;:]+$/, '');
    for (const segment of reference.split(/[/-]/)) {
      const piece = segment.trim();
      if (!piece) continue;
      const folded = foldToken(piece);
      if (!folded || UPI_SEGMENT_CODES.has(folded)) continue;
      // The reference number, and anything else with no letters in it.
      if (!/\p{L}/u.test(piece)) continue;
      // A VPA is the handle, not the bank behind the "@" — the same rule the
      // prose reader applies, for the same reason.
      const handle = piece.includes('@') ? (piece.split('@')[0] ?? piece) : piece;
      // The same rule the prose reader keeps, for the same reason: a reference
      // is not always closed by a full stop, so "ZOMATO LTD Avl Bal INR 900"
      // has to be cut where the bank starts talking rather than at four words.
      const name = keepWords(handle.split(/\s+/)).join(' ');
      if (plausibleMerchant(name)) return name;
    }
  }
  return null;
}

/**
 * A card spend, where the shop sits between the timestamp and the limit.
 *
 * `Spent Card no. XX1234 INR 225 13-09-26 12:30:00 SWIGGY Avl Lmt INR 50000` —
 * there is no preposition anywhere near the name, so the prose reader has
 * nothing to follow. What there is instead is position: the shop is what stands
 * between the time and the bank's closing balance line, and both edges are
 * unambiguous enough to read between.
 *
 * Position is the weakest evidence in this file, so it is the last thing tried
 * and it is not tried at all unless the message says it is about a card. Without
 * that guard any debit carrying a clock and a balance would hand whatever words
 * fell between them to the ledger as a shop — a guess dressed as a reading,
 * which is the one failure this parser is written to avoid.
 */
const CARD_CONTEXT = /\b(?:card|kaart|karte|tarjeta|cartao|carte|lmt|limit)\b/iu;
const CARD_SPEND_MERCHANT =
  /\d{1,2}:\d{2}(?::\d{2})?\s+(?:at\s+)?([\p{L}\p{N}][\p{L}\p{N}&.'*_ -]{1,40}?)\s+(?:avl|available|avbl)\b/iu;

function readCardSpend(raw: string): string | null {
  if (!CARD_CONTEXT.test(raw)) return null;
  const match = CARD_SPEND_MERCHANT.exec(raw);
  const captured = match?.[1]?.replace(/[.,;:\s]+$/, '').trim();
  if (!captured) return null;
  // Cut on the shared rule too — the words between a clock and a balance are
  // not guaranteed to be only a name.
  const name = keepWords(captured.split(/\s+/)).join(' ');
  if (!name) return null;
  return plausibleMerchant(name) && !MERCHANT_STOP_WORDS.has(foldToken(name)) ? name : null;
}

function detectMerchant(
  raw: string,
  folded: string,
  direction: TransactionDirection,
): string | null {
  // The reference first. Where a message carries one it is the most reliable
  // thing in it, and the prose around it is written about the account.
  const viaReference = readUpiCounterparty(raw);
  if (viaReference) return viaReference;

  PREPOSITION.lastIndex = 0;
  for (const match of folded.matchAll(PREPOSITION)) {
    if (match.index === undefined) continue;
    const start = match.index + match[0].length;
    const candidate = readMerchant(raw.slice(start, start + 96));
    if (candidate) return candidate;
  }

  // "…debited for Rs 500.00 …; SWIGGY credited." — a transfer alert describes
  // both sides, and the side that was credited is the shop.
  if (direction === TransactionDirection.Debit) {
    const payee = PAYEE_CREDITED.exec(folded);
    if (payee?.[1] && payee.index !== undefined) {
      const at = payee.index + payee[0].indexOf(payee[1]);
      const name = raw.slice(at, at + payee[1].length).replace(/[.,;:]+$/, '');
      if (plausibleMerchant(name) && !MERCHANT_NOISE.has(foldToken(name))) return name;
    }
  }

  return readCardSpend(raw);
}

/* ------------------------------------------------------------------ *
 * Direction
 * ------------------------------------------------------------------ */

/** Distance from `index` to the nearest match of `pattern`, or null for none. */
function nearest(pattern: RegExp, text: string, index: number): number | null {
  pattern.lastIndex = 0;
  let best: number | null = null;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    const distance = index < start ? start - index : index > end ? index - end : 0;
    if (best === null || distance < best) best = distance;
  }
  return best;
}

/**
 * Which way the money went, decided by the verb *nearest the amount*.
 *
 * The old rule bailed whenever a message contained both a debit and a credit
 * word, which loses ICICI's entire account-debit format: `debited for Rs 500.00
 * … ; SWIGGY credited` describes both sides of one transfer and is a perfectly
 * ordinary debit. Proximity reads it correctly and still refuses the case that
 * matters — a message where the two are equally close is genuinely unreadable,
 * and a credit booked as an expense is worse than no candidate at all.
 */
function decideDirection(masked: string, amountIndex: number): TransactionDirection | null {
  const debit = nearest(DEBIT_WORDS, masked, amountIndex);
  const credit = nearest(CREDIT_WORDS, masked, amountIndex);
  if (debit === null && credit === null) return null;
  if (credit === null) return TransactionDirection.Debit;
  if (debit === null) return TransactionDirection.Credit;
  if (debit === credit) return null;
  return debit < credit ? TransactionDirection.Debit : TransactionDirection.Credit;
}

/* ------------------------------------------------------------------ *
 * The parse
 * ------------------------------------------------------------------ */

/**
 * Read one message. Returns null when it is not a transaction at all — which
 * is most of them.
 *
 * `context` is optional everywhere. Given the user's region or locale the
 * parser stops guessing at date order, decimal separators and shared currency
 * symbols; given nothing it still answers, and says what it guessed.
 */
export function parseSms(text: string, context: SmsParseContext = {}): ParsedSms | null {
  if (!text) return null;
  // NFKC, bidi marks out, native numerals to ASCII — so an Arabic or Hindi
  // message reaches the same code path as an English one, and an RTL isolate
  // around the amount does not hide a number that is plainly there.
  // A concatenated SMS tops out around 1,600 characters. The cap is not about
  // correctness, it is about a parser that runs over a whole inbox: the number
  // patterns backtrack, and nothing should be able to hand this function a
  // megabyte of digits and have it think about it.
  const raw = normaliseForParsing(text.slice(0, 2000)).replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  // Accents folded away, same length, so every index below is valid in both.
  const folded = foldLatin(raw);

  // Checked before anything else: an OTP quotes a real amount from a real bank
  // and is the false positive most likely to be confirmed by accident.
  if (NOT_A_TRANSACTION.test(folded)) return null;
  DEBIT_WORDS.lastIndex = 0;
  CREDIT_WORDS.lastIndex = 0;
  const saysMoneyMoved = DEBIT_WORDS.test(folded) || CREDIT_WORDS.test(folded);
  if (BALANCE_ONLY.test(folded) && !saysMoneyMoved) return null;

  const masked = maskCards(folded);
  const amountMatch = findAmount(raw, masked);
  if (!amountMatch) return null;

  const { currency, inferred: currencyInferred } = resolveCurrency(amountMatch.marker, context);
  if (!isCurrencyCode(currency)) return null;
  const number = readNumber(amountMatch.token, currency, context);
  if (!number || number.minor <= 0n) return null;

  const direction = decideDirection(masked, amountMatch.index);
  if (!direction) return null;

  const merchant = detectMerchant(raw, masked, direction);
  const reference = REFERENCE.exec(raw)?.[1] ?? null;
  const accountTail = ACCOUNT_TAIL.exec(raw)?.[1] ?? null;
  const date = detectDate(raw, context);

  const inferred: InferredField[] = [];
  if (currencyInferred) inferred.push('currency');
  if (number.separatorInferred) inferred.push('decimalSeparator');
  if (date?.orderInferred) inferred.push('dateOrder');

  // Confidence is about how much of the message we understood *and how much of
  // that we are entitled to believe*. The old score counted fields found, so a
  // merchant reading `VPA` scored 1.0 and was pre-selected; a field that failed
  // its plausibility test now counts for nothing, and every inference above
  // costs what it is worth.
  let confidence = 0.55;
  if (merchant) confidence += 0.2;
  if (reference) confidence += 0.15;
  if (date) confidence += 0.1;
  if (accountTail) confidence += 0.05;
  if (looksLikeBankSender(context.sender)) confidence += 0.05;
  if (currencyInferred) confidence -= 0.1;
  if (number.separatorInferred) confidence -= 0.15;
  if (date?.orderInferred) confidence -= 0.1;

  return {
    amount: money(number.minor, currency),
    direction,
    merchant,
    accountTail,
    reference,
    occurredAt: date?.iso ?? null,
    inferred,
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
  };
}

export interface SmsMessage {
  /** The message body. */
  readonly body: string;
  /** When it arrived, ISO-8601. Used when the message carries no date itself. */
  readonly receivedAt: string;
  /** Sender id, e.g. "AD-HDFCBK". Kept so a person can recognise it — and, when
   * it looks like a bank, as a small nudge to confidence. Never a filter: a
   * bank the allowlist has not heard of is still a bank. */
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
  /**
   * Trip window, inclusive. ISO dates or instants.
   *
   * Both ends are optional, and an absent end means "no bound that way". The
   * window was mandatory while this only ever ran inside a group, where the
   * trip's own dates were the obvious fence. The drafts inbox has no trip: a
   * person pastes the messages they chose, and a window would then silently
   * drop some of them — the one failure mode a paste flow must not have, since
   * what went missing is invisible. An unparseable bound is treated as absent
   * for the same reason: dropping everything because a date field held nonsense
   * would be worse than proposing too much, which a person can simply untick.
   */
  readonly from?: string;
  readonly to?: string;
  /**
   * Dedupe keys already on the ledger. A candidate matching one of these is
   * dropped — re-scanning the inbox must not re-propose what was confirmed.
   */
  readonly alreadyImported?: ReadonlySet<string>;
  /**
   * What the caller knows that the messages do not: region, locale, the
   * currency the group counts in. Every message is parsed with it, and each
   * message's own sender is merged in on top.
   */
  readonly context?: SmsParseContext;
}

/** A window bound as a number, or ±Infinity when there is no usable bound. */
function bound(value: string | undefined, edge: (value: string) => string, fallback: number) {
  if (!value) return fallback;
  const stamp = Date.parse(edge(value));
  return Number.isNaN(stamp) ? fallback : stamp;
}

/**
 * The whole feature, as one pure function: an inbox and (optionally) a trip
 * window in, candidates out. Nothing is written and nothing is sent anywhere.
 */
export function proposeFromSms(
  messages: readonly SmsMessage[],
  options: ProposeOptions = {},
): ExpenseCandidate[] {
  const from = bound(options.from, startOfDay, -Infinity);
  const to = bound(options.to, endOfDay, Infinity);
  const seen = new Set<string>();
  const candidates: ExpenseCandidate[] = [];

  for (const message of messages) {
    const parsed = parseSms(message.body, { ...options.context, sender: message.sender });
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
