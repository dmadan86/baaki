/**
 * The expense form's decisions, with no React around them.
 *
 * The add/edit route is a long file, and the parts of it that are easy to get
 * wrong are not the layout — they are the answers to "which figure survives
 * this tap". Those answers live here as plain functions over plain values, so
 * they can be tested without standing up Expo Router, a mirror and a keyboard
 * (mobile's vitest deliberately renders nothing; see vitest.config.ts).
 *
 * The route keeps the state and the side effects. Everything below only reads
 * its arguments and returns what the next state should be.
 */

import {
  type MemberId,
  type CurrencyCode,
  type PayerMap,
  parseMinorInput,
  sanitiseMinorInput,
} from '@waves/core';

/** Today, as the ledger stores a date: a plain UTC day, no time. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The day the expense is filed under.
 *
 * An edit must not move it. The form has no date picker, so it used to send
 * today's date on every write — which meant opening a three-week-old dinner to
 * fix a spelling silently re-filed it as today's, reordered the feed, moved it
 * between months and trips, and (now that an expense keeps a visible history)
 * wrote a date change into the audit trail that nobody made.
 *
 * A capture keeps the day it was caught; a saved expense keeps the day it has;
 * only a genuinely new expense is today's.
 */
export function expenseDateFor(input: {
  readonly captureDate: string | null | undefined;
  readonly savedDate: string | null | undefined;
  readonly today: string;
}): string {
  return input.captureDate ?? input.savedDate ?? input.today;
}

/**
 * What the payer figures should become. `selected` is who is paying, `current`
 * the figures to start from, `locked` the ones to hold constant, and `typed`
 * the one field whose characters must be left exactly as they were typed.
 *
 * The arithmetic itself is `rebalancePayers` in core — this only decides what
 * to hand it.
 */
export interface PayerPlan {
  readonly selected: readonly MemberId[];
  readonly current: PayerMap;
  readonly locked: ReadonlySet<MemberId>;
  readonly typed?: { readonly member: MemberId; readonly text: string };
}

const NO_LOCKS: ReadonlySet<MemberId> = new Set<MemberId>();

/**
 * Tapping a member's face.
 *
 * One-payer mode is a radio: the tap replaces whoever was there and hands them
 * the whole bill. Several-payer mode is a checkbox: it adds or removes. Null
 * means the tap does nothing — the last payer cannot be removed, because a bill
 * that nobody paid is not a state the ledger has.
 */
export function planToggle(input: {
  readonly many: boolean;
  readonly payers: PayerMap;
  readonly locked: ReadonlySet<MemberId>;
  readonly amount: bigint;
  readonly memberId: MemberId;
}): PayerPlan | null {
  const { many, payers, locked, amount, memberId } = input;
  if (!many) {
    return { selected: [memberId], current: new Map([[memberId, amount]]), locked: NO_LOCKS };
  }
  const ids = [...payers.keys()];
  const selected = payers.has(memberId) ? ids.filter((id) => id !== memberId) : [...ids, memberId];
  if (selected.length === 0) return null;
  return {
    selected,
    current: payers,
    // A lock on somebody who is no longer paying would hold a figure for a row
    // that is not there, and strand the total short by it.
    locked: new Set([...locked].filter((id) => selected.includes(id))),
  };
}

/**
 * Collapsing several payers back to one.
 *
 * The person who put in the most keeps the bill: dropping the largest
 * contributor is the one collapse nobody means. Null when there is nothing to
 * collapse.
 */
export function planCollapseToOne(input: {
  readonly payers: PayerMap;
  readonly amount: bigint;
}): PayerPlan | null {
  const ids = [...input.payers.keys()];
  if (ids.length <= 1) return null;
  const biggest = ids.reduce((best, id) =>
    (input.payers.get(id) ?? 0n) > (input.payers.get(best) ?? 0n) ? id : best,
  );
  return { selected: [biggest], current: new Map([[biggest, input.amount]]), locked: NO_LOCKS };
}

/**
 * A figure typed against one payer. Typing it locks it — it is now a stated
 * fact — and the others absorb the difference.
 */
export function planTypedAmount(input: {
  readonly payers: PayerMap;
  readonly locked: ReadonlySet<MemberId>;
  readonly memberId: MemberId;
  readonly text: string;
  readonly currency: CurrencyCode;
}): PayerPlan {
  const cleaned = sanitiseMinorInput(input.text, input.currency);
  const current = new Map(input.payers).set(
    input.memberId,
    parseMinorInput(cleaned, input.currency),
  );
  return {
    selected: [...current.keys()],
    current,
    locked: new Set(input.locked).add(input.memberId),
    typed: { member: input.memberId, text: cleaned },
  };
}

/** Back to an even split of the paying — every lock dropped. */
export function planEvenly(payers: PayerMap): PayerPlan {
  return { selected: [...payers.keys()], current: payers, locked: NO_LOCKS };
}
