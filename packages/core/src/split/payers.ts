/**
 * Who put the money in (TDR §3.1, the payer side of a split).
 *
 * The ledger has always been multi-payer: `expense_payers` is a table, the
 * balance is `paid − owed` summed over every payer row, and both edge functions
 * refuse a write whose payer rows do not add up to the total (`PAYER_MISMATCH`).
 * What was missing was a way to *say* it — every client wrote one row for one
 * person, so "she got the taxi, I got the tickets" had to be entered as two
 * separate expenses, which is a different fact: it splits two bills instead of
 * one, and it lands two rows in everybody's feed.
 *
 * This module is the arithmetic behind saying it. It is deliberately here and
 * not in a screen: the rounding rule has to be the same one the *share* side
 * uses (ADR-009 — floor everyone, rotate the leftover minor units by a seed
 * derived from the expense id), or a ₹1000 bill split three ways by two payers
 * would round two different ways in the same row and fail its own trigger.
 *
 * Everything here is pure, integer-only and deterministic. No currency is
 * consulted: minor units are minor units, so a JPY bill (no decimal places) and
 * an INR one behave identically.
 */

import { splitEqually } from './computeShares';
import type { MemberId } from './types';

/** Who paid what, in minor units of the expense's currency. */
export type PayerMap = ReadonlyMap<MemberId, bigint>;

export enum PayerProblemCode {
  /** Nobody is marked as having paid. */
  NoPayers = 'NO_PAYERS',
  /** Somebody is down for a negative amount. */
  Negative = 'NEGATIVE_PAYER_AMOUNT',
  /** The payers add up to less than the bill. */
  Short = 'PAYERS_SHORT',
  /** The payers add up to more than the bill. */
  Over = 'PAYERS_OVER',
}

export interface PayerProblem {
  readonly code: PayerProblemCode;
  /**
   * `amount − Σ payers`: positive when there is still money to account for,
   * negative when too much has been claimed. Zero for `NoPayers` and for
   * `Negative`, where the sum may happen to come out right anyway.
   */
  readonly delta: bigint;
  /** The offending member, for `Negative`. */
  readonly member?: MemberId;
}

/** Σ of what every payer put in. */
export function payerTotal(payers: PayerMap): bigint {
  let total = 0n;
  for (const paid of payers.values()) total += paid;
  return total;
}

/**
 * The one definition of "these payers are writable", matching what the
 * `expense-write` and `/sync` edge functions enforce and what the SQL trigger
 * enforces underneath both. A client that agrees with this never sees a
 * `PAYER_MISMATCH` come back from the server.
 *
 * Returns `null` when the payers are good, so the caller reads as
 * `const problem = validatePayers(...)`.
 */
export function validatePayers(amount: bigint, payers: PayerMap): PayerProblem | null {
  if (payers.size === 0) {
    return { code: PayerProblemCode.NoPayers, delta: amount };
  }
  // Stable order so that a bill with two negative entries always names the same
  // one — a message that moves between renders reads as a flickering bug.
  for (const member of stableIds(payers)) {
    const paid = payers.get(member) ?? 0n;
    if (paid < 0n) {
      return { code: PayerProblemCode.Negative, delta: 0n, member };
    }
  }
  const delta = amount - payerTotal(payers);
  if (delta > 0n) return { code: PayerProblemCode.Short, delta };
  if (delta < 0n) return { code: PayerProblemCode.Over, delta };
  return null;
}

/**
 * Divide the bill evenly between the people who paid it — "we each put in
 * half". Exactly the share side's equal split, called on the payer side, so the
 * leftover paisa is handed out by the same rule and the two sides of the row
 * can never disagree about rounding.
 *
 * An empty list gives an empty map rather than throwing: a form mid-edit has a
 * moment with nobody selected, and that is a validation state, not a crash.
 */
export function splitPaidEqually(
  amount: bigint,
  payerIds: readonly MemberId[],
  seed: string,
): Map<MemberId, bigint> {
  if (payerIds.length === 0) return new Map();
  return splitEqually(amount, payerIds, seed);
}

export interface RebalancePayersInput {
  /** The bill's total, in minor units. */
  readonly amount: bigint;
  /** Who is currently marked as a payer. Order is irrelevant. */
  readonly selected: readonly MemberId[];
  /** What each payer is currently down for; ids outside `selected` are dropped. */
  readonly current: PayerMap;
  /**
   * Payers whose amount was typed by a person and must survive verbatim.
   * Everyone else absorbs whatever is left, evenly.
   */
  readonly locked: ReadonlySet<MemberId>;
  /** The expense id — fixes which payer absorbs an odd minor unit. */
  readonly seed: string;
}

/**
 * Recompute the payer amounts after anything that can move them: the total was
 * edited, somebody was added to or taken off the payer list, or one person's
 * figure was typed in.
 *
 * The rule is "typed figures are facts, the rest is arithmetic": every locked
 * payer keeps exactly what they were given, and the unlocked ones share what is
 * left of the bill evenly. That is what makes the common gestures behave the way
 * people expect — type ₹600 against Asha on a ₹1000 bill with two payers, and
 * Ravi becomes ₹400 without being touched.
 *
 * Two deliberate refusals:
 *
 *   - Nothing is ever driven negative. If the locked figures already exceed the
 *     bill, the unlocked payers go to zero and the overage is left for
 *     `validatePayers` to report. Silently handing somebody −₹200 would make the
 *     row add up while describing something that did not happen.
 *   - Locked payers are never rescaled to fit. Somebody typed those numbers;
 *     rewriting them to make the total work is the ledger inventing a fact.
 *
 * Note for callers: with a single selected payer who is locked, a change to the
 * total leaves a mismatch by design — the UI drops the lock when the selection
 * falls to one, so the lone payer always carries the whole bill.
 */
export function rebalancePayers(input: RebalancePayersInput): Map<MemberId, bigint> {
  const selected = [...new Set(input.selected)];
  const result = new Map<MemberId, bigint>();
  if (selected.length === 0) return result;

  const lockedIds: MemberId[] = [];
  const unlockedIds: MemberId[] = [];
  for (const member of selected) {
    if (input.locked.has(member)) lockedIds.push(member);
    else unlockedIds.push(member);
  }

  let lockedTotal = 0n;
  for (const member of lockedIds) {
    // A negative typed figure is clamped rather than propagated: the field that
    // produced it cannot express one, and a stale draft should not be able to.
    const paid = input.current.get(member) ?? 0n;
    const kept = paid > 0n ? paid : 0n;
    result.set(member, kept);
    lockedTotal += kept;
  }

  if (unlockedIds.length === 0) return result;

  const free = input.amount - lockedTotal;
  if (free <= 0n) {
    for (const member of unlockedIds) result.set(member, 0n);
    return result;
  }

  for (const [member, paid] of splitPaidEqually(free, unlockedIds, input.seed)) {
    result.set(member, paid);
  }
  return result;
}

/**
 * The payer map as the wire wants it: `{ memberId: "1234" }` in minor units,
 * with anybody down for nothing left out.
 *
 * Zero rows are dropped because they are not a fact about the world — a person
 * who paid nothing is not a payer of the bill, and writing them as one puts a
 * "₹0" line on the expense screen and a member in the notification fan-out who
 * has no reason to be there. The one case that survives the drop is a zero-total
 * expense, where the map legitimately empties; `validatePayers` accepts that
 * only because Σ0 = 0, and every form refuses a zero total before it gets here.
 */
export function serialisePayers(payers: PayerMap): Record<MemberId, string> {
  const wire: Record<MemberId, string> = {};
  for (const member of stableIds(payers)) {
    const paid = payers.get(member) ?? 0n;
    if (paid === 0n) continue;
    wire[member] = paid.toString();
  }
  return wire;
}

/** Ids in the stable order every device agrees on (ADR-009). */
function stableIds(payers: PayerMap): MemberId[] {
  return [...payers.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
