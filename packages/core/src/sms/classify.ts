/**
 * What a bank message *is*, beyond how much it was for.
 *
 * `proposeFromSms` answers one question — what did this person spend? — and
 * throws everything else away. That is the right answer for a paste box, where
 * somebody hands over the four messages they care about, and the wrong one for
 * a screen that reads a whole inbox: a quarter of bank messages is hundreds of
 * them, most are not expenses, and a list that silently drops the rest cannot
 * be trusted, because "it did not find my dinner" and "it found my dinner and
 * decided not to mention it" look identical from the outside.
 *
 * So this sorts, rather than filters. Every message that describes money moving
 * comes out in one of three piles:
 *
 *   * **Expense** — money out, to somebody, for something. The only pile that
 *     can become a split expense.
 *   * **Income** — money in. Salary, a transfer from a friend, a dividend.
 *   * **Other** — money moved and none of it was spending or earning. A credit
 *     card bill settled out of the same account that made the purchases; a
 *     wallet loaded; a fund bought; cash taken from a machine; a refund.
 *
 * **Why "other" is not a rounding error.** Every message in it is a debit, and
 * a splitting app that read them as expenses would double-count an entire
 * month: once when the card was used, and again when the card was paid. Cash is
 * the same shape — money leaves the account when it is withdrawn and again when
 * the person enters the dinner they bought with it. The whole pile exists to be
 * *visible and not counted*, which is exactly what a person needs in order to
 * believe the number in the other two.
 *
 * **What it never does.** It does not decide what is worth showing; the screen
 * does. A message the parser could not read at all produces no row here — that
 * count is reported separately — but nothing that *was* read is dropped for
 * being uninteresting. And, as everywhere on this path, nothing is sent
 * anywhere: this is a pure function over strings.
 */

import { dedupeKey, parseSms, SMS_LOW_CONFIDENCE, TransactionDirection } from './parse';
import type { ParsedSms, SmsMessage } from './parse';
import type { SmsParseContext } from './locale';
import {
  BALANCE_ONLY,
  CARD_BILL,
  CASH_WITHDRAWAL,
  CREDIT_SOURCE,
  DEBIT_SOURCE,
  INVESTMENT,
  NOT_A_TRANSACTION,
  REFUND,
  SELF_TRANSFER,
  WALLET_TOPUP,
} from './vocabulary';

/** Which of the three piles a message falls in. */
export enum SmsKind {
  Expense = 'expense',
  Income = 'income',
  Other = 'other',
}

/**
 * Why a message is in the third pile.
 *
 * Carried rather than inferred again on the screen, so the row can say "credit
 * card bill" instead of "other" — a label a person can check against their own
 * memory is the difference between a pile they trust and a pile they ignore.
 */
export enum SmsOtherReason {
  CardBill = 'card-bill',
  WalletTopUp = 'wallet-top-up',
  Investment = 'investment',
  SelfTransfer = 'self-transfer',
  CashWithdrawal = 'cash-withdrawal',
  Refund = 'refund',
}

/**
 * The order the reasons are tested in, most specific first.
 *
 * It matters: "Rs 9,165 debited towards your credit card bill via autopay"
 * matches both the card-bill and the autopay halves of `CARD_BILL`, and a
 * refund of a card payment matches both `REFUND` and `CARD_BILL`. A refund is
 * the more surprising fact about a message and therefore the more useful label,
 * so it wins.
 */
const REASONS: readonly (readonly [SmsOtherReason, RegExp])[] = [
  [SmsOtherReason.Refund, REFUND],
  [SmsOtherReason.CardBill, CARD_BILL],
  [SmsOtherReason.Investment, INVESTMENT],
  [SmsOtherReason.WalletTopUp, WALLET_TOPUP],
  [SmsOtherReason.SelfTransfer, SELF_TRANSFER],
  [SmsOtherReason.CashWithdrawal, CASH_WITHDRAWAL],
];

/** The `other` reason this message gives, if it gives one. */
export function otherReasonFor(body: string): SmsOtherReason | null {
  for (const [reason, pattern] of REASONS) {
    // Every pattern here is built without the `g` flag precisely so `test` has
    // no `lastIndex` to carry between calls — a stateful regex reused across a
    // whole inbox would match every other message and nobody would see why.
    if (pattern.test(body)) return reason;
  }
  return null;
}

/** One classified message: everything the parser read, plus which pile it is in. */
export interface ClassifiedSms extends ParsedSms {
  /**
   * The message itself, carried through so the caller can put it somewhere.
   *
   * On a phone that somewhere is the device-only store, which is what lets the
   * detail screen show the original text. It is safe to carry here because the
   * one thing that turns a row into something syncable — `planSmsDrafts` — sets
   * `parsed` field by field rather than spreading, so a field added to this
   * type cannot find its way onto the wire by being added to it.
   */
  readonly body: string;
  readonly kind: SmsKind;
  /** Set only when `kind` is `Other`. */
  readonly reason: SmsOtherReason | null;
  /** Sender id, e.g. "AD-HDFCBK". Null when the message carried none. */
  readonly sender: string | null;
  /** The instant to file it under: the bank's, or the message's arrival. */
  readonly at: string;
  /** True when the message carried no date and arrival time was used instead. */
  readonly dateInferred: boolean;
  /** Stable across re-scans, so reading twice cannot produce two rows. */
  readonly dedupeKey: string;
  /**
   * The app understood this one well enough to act without being asked.
   *
   * The same bar `proposeFromSms` uses, and it means the same thing: the
   * parser was confident *and* the bank said when it happened. Only an expense
   * can be preselected — nothing in the other two piles becomes anything
   * without somebody saying so.
   */
  readonly preselect: boolean;
}

export interface ClassifyOptions {
  /** Dedupe keys already dealt with. A message matching one is left out. */
  readonly alreadySeen?: ReadonlySet<string>;
  /** Region, locale, the currency to assume — merged with each message's sender. */
  readonly context?: SmsParseContext;
}

export interface ClassifiedInbox {
  readonly expenses: readonly ClassifiedSms[];
  readonly income: readonly ClassifiedSms[];
  readonly other: readonly ClassifiedSms[];
  /**
   * How many messages described money moving but could not be read — reported
   * so the screen can say so rather than quietly showing a shorter list.
   *
   * Not "everything that was not classified": an inbox is mostly delivery
   * notifications and one-time passwords, and counting those as failures would
   * make the number meaningless. This counts only what the parser refused
   * *after* the message looked like a bank telling somebody about money.
   */
  readonly unreadable: number;
}

/** Which pile one parsed message belongs in. */
export function kindOf(
  parsed: Pick<ParsedSms, 'direction'>,
  body: string,
): { kind: SmsKind; reason: SmsOtherReason | null } {
  const reason = otherReasonFor(body);
  if (reason !== null) return { kind: SmsKind.Other, reason };
  return {
    kind: parsed.direction === TransactionDirection.Debit ? SmsKind.Expense : SmsKind.Income,
    reason: null,
  };
}

/**
 * Read one message into a row, or null when it is not about money at all.
 *
 * Exported because the screen re-reads a single stored message when somebody
 * opens it, and it must reach the same verdict the scan did — one function, so
 * the detail screen and the list can never disagree about what a row is.
 */
export function classifyOne(
  message: SmsMessage,
  options: ClassifyOptions = {},
): ClassifiedSms | null {
  const parsed = parseSms(message.body, { ...options.context, sender: message.sender });
  if (!parsed) return null;

  const at = parsed.occurredAt ?? message.receivedAt;
  const stamp = Date.parse(at);
  if (Number.isNaN(stamp)) return null;

  const { kind, reason } = kindOf(parsed, message.body);
  return {
    ...parsed,
    body: message.body,
    kind,
    reason,
    sender: message.sender ?? null,
    at,
    dateInferred: parsed.occurredAt === null,
    dedupeKey: dedupeKey(parsed, at),
    preselect:
      kind === SmsKind.Expense &&
      parsed.confidence >= SMS_LOW_CONFIDENCE &&
      parsed.occurredAt !== null,
  };
}

/**
 * An inbox, sorted into three piles.
 *
 * Deduplicated across the whole run, not per pile: a bank that sends the same
 * alert twice produces one row, and the first arrival wins so the earliest
 * timestamp is the one kept.
 *
 * Each pile comes back newest first, which is the order every one of them is
 * read in — a person scanning for "did it catch yesterday's dinner" should not
 * have to reach the bottom of ninety days to find out.
 */
export function classifySms(
  messages: readonly SmsMessage[],
  options: ClassifyOptions = {},
): ClassifiedInbox {
  const seen = new Set<string>();
  const expenses: ClassifiedSms[] = [];
  const income: ClassifiedSms[] = [];
  const other: ClassifiedSms[] = [];
  let unreadable = 0;

  for (const message of messages) {
    const row = classifyOne(message, options);
    if (!row) {
      if (looksLikeMoney(message.body)) unreadable += 1;
      continue;
    }
    if (seen.has(row.dedupeKey) || options.alreadySeen?.has(row.dedupeKey)) continue;
    seen.add(row.dedupeKey);

    if (row.kind === SmsKind.Expense) expenses.push(row);
    else if (row.kind === SmsKind.Income) income.push(row);
    else other.push(row);
  }

  const newestFirst = (a: ClassifiedSms, b: ClassifiedSms): number => b.at.localeCompare(a.at);
  return {
    expenses: expenses.sort(newestFirst),
    income: income.sort(newestFirst),
    other: other.sort(newestFirst),
    unreadable,
  };
}

/**
 * Was this a message the parser *should* have read and did not?
 *
 * The distinction this draws is the whole value of the number. `parseSms`
 * returns null for two very different reasons, and lumping them together
 * produces a count nobody can use:
 *
 *   * **It refused, correctly.** A one-time password, a balance report, an
 *     advert, a payment reminder. Most of an inbox is this, and it is not a
 *     failure — the parser has a list of these and turning them down is the
 *     job. Counting them would put "unreadable: 340" on a screen every time,
 *     which says nothing and would be ignored within a week.
 *   * **It could not.** A message that plainly says money moved, that carries
 *     digits, and that is on none of the refusal lists. That is a gap in the
 *     parser, it is the one thing worth telling somebody about, and it is what
 *     this counts.
 *
 * Built from the parser's own vocabulary rather than a second opinion, so a
 * word added to the debit list is a word this notices too — the alternative
 * drifts, and drifts silently, in the direction of a number that means nothing.
 * The patterns are rebuilt without `g`: the exported ones are global, and
 * `test` on a global regex carries `lastIndex` between calls.
 */
const MOVED_MONEY = new RegExp(`(?:${DEBIT_SOURCE}|${CREDIT_SOURCE})`, 'iu');
const REFUSED_ON_PURPOSE = new RegExp(NOT_A_TRANSACTION.source, 'iu');
const JUST_A_BALANCE = new RegExp(BALANCE_ONLY.source, 'iu');

function looksLikeMoney(body: string): boolean {
  if (!/\d/.test(body)) return false;
  if (!MOVED_MONEY.test(body)) return false;
  if (REFUSED_ON_PURPOSE.test(body)) return false;
  return !JUST_A_BALANCE.test(body);
}
