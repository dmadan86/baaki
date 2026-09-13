/**
 * The decisions a scan makes, with none of the machinery that carries them out.
 *
 * `smsScan.ts` is device wiring: a native bridge into Android's SMS provider, a
 * SQLite file, the sync queue. None of that can be exercised without a phone,
 * and none of it is where this feature can go quietly wrong. What *can* is in
 * here — how far back to reach, and which of the messages that came back are
 * sure enough to become something a person has to answer — so it is separated
 * out and pinned by tests that need no device (mobile's vitest renders nothing;
 * see vitest.config.ts).
 *
 * The split is also what keeps those tests loadable at all: importing the scan
 * pulls in React Native, expo-crypto and the sync engine, and a test that has
 * to boot all three to check an arithmetic decision is a test nobody will keep
 * running.
 */

import { SmsKind, type ClassifiedSms } from '@waves/core';

import { planSmsDrafts, type SmsDraft } from './smsDrafts';
import type { IncomingSms } from './smsMessageTypes';
import type { SmsWindow } from './smsReader';

/**
 * How much of the inbox a scan reaches for.
 *
 * Two choices rather than a date picker, and they are the two questions people
 * actually have: "catch up on what just happened" and "go back and get
 * everything". The second is slower, and the sheet that offers it says so.
 */
export enum ScanScope {
  /** The last month. Seconds, and what an ordinary top-up scan wants. */
  Recent = 'recent',
  /** As far back as the phone keeps messages. Can be minutes on a full inbox. */
  Everything = 'everything',
}

export const RECENT_DAYS = 30;

/**
 * The far edge of "everything".
 *
 * Ten years, which is past the point where any handset still holds messages —
 * the number exists so the window is *bounded* rather than because anybody has
 * an inbox that deep. The bound matters: the native filter turns this into a
 * date comparison, and one with no lower edge is a query with no plan.
 */
export const EVERYTHING_DAYS = 3650;

/** Ceilings on how many messages one scan will pull across the bridge. */
export const RECENT_MAX = 400;
export const EVERYTHING_MAX = 5000;

const DAY_MS = 86_400_000;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The dates a scope asks the inbox for. */
export function scanWindow(scope: ScanScope, now: number): SmsWindow {
  const days = scope === ScanScope.Recent ? RECENT_DAYS : EVERYTHING_DAYS;
  return { from: day(now - (days - 1) * DAY_MS), to: day(now) };
}

/** How many messages a scope is willing to take at once. */
export function scanMaxCount(scope: ScanScope): number {
  return scope === ScanScope.Recent ? RECENT_MAX : EVERYTHING_MAX;
}

/** A classified row, as the device store takes it. */
export function toIncoming(row: ClassifiedSms): IncomingSms {
  return {
    dedupeKey: row.dedupeKey,
    body: row.body,
    sender: row.sender,
    kind: row.kind,
    reason: row.reason,
    merchant: row.merchant,
    accountTail: row.accountTail,
    currency: row.amount.currency,
    amount: row.amount.minor.toString(),
    occurredOn: row.at.slice(0, 10),
    at: row.at,
    confidence: row.confidence,
    dateInferred: row.dateInferred,
  };
}

/**
 * Turn the confident new expenses into drafts, and nothing else into anything.
 *
 * `preselect` is the bar, and it means what it meant on the paste screen: the
 * parser understood the message *and* the bank said which day. Three things are
 * therefore never drafted, each for its own reason:
 *
 *   * **Money coming in.** Not an expense in any reading.
 *   * **A card bill, a wallet top-up, a fund, cash from a machine.** Debits
 *     every one, and counting them would double-count a month — once when the
 *     card was used and again when the card was paid.
 *   * **An expense whose day had to be guessed.** On a trip that is precisely
 *     the row that lands on the wrong day and is believed, because nothing
 *     about it looks wrong.
 *
 * None of them is lost: every message is on the device, and the Bank messages
 * screen shows all three piles. What they do not do is arrive in Review, which
 * is the list of things genuinely waiting on a person.
 *
 * The body goes nowhere. Every key is handed over as a read key and no bodies
 * are passed at all — both halves of "a read message keeps no text" said in one
 * call, and `planSmsDrafts` ignores bodies for read keys besides.
 */
export function draftsFor(rows: readonly ClassifiedSms[]): SmsDraft[] {
  const confident = rows.filter((row) => row.kind === SmsKind.Expense && row.preselect);
  if (confident.length === 0) return [];
  const keys = new Set(confident.map((row) => row.dedupeKey));
  return planSmsDrafts({ candidates: confident, chosen: keys, readKeys: keys });
}
