/**
 * Where this shop's money went last time.
 *
 * The one gesture on a Review row — swipe it toward the leading edge and it is
 * filed — only works if the row can *say* where it is about to go before the
 * finger moves. So every draft wears a destination chip, and this is where that
 * chip's answer comes from.
 *
 * NO NEW TABLE, AND NO MIGRATION. The answer is already in the local ledger
 * mirror: every expense carries a description and the group it lives in. Read
 * the mirror, clean each description down to the brand underneath with
 * `normaliseMerchantName` (the same normaliser the statement categoriser uses,
 * so "POS UPI SWIGGY*ORDER 8842" and "Swiggy" are one merchant), and remember
 * which group that brand's spending went to.
 *
 * HONEST, OR SILENT. A chip that lies is worse than a chip that asks, so the
 * answer is withheld unless it is unambiguous:
 *
 *   * the cleaned name must be a real name — at least a few characters, not the
 *     residue of a line that was all gateway noise;
 *   * when a merchant's spending is split across several groups, the newest
 *     group only wins if it is also the one it went to most often. A shop you
 *     used twice on a trip and once at home keeps pointing at the trip; a shop
 *     genuinely split down the middle asks instead.
 *
 * A draft that was tagged for a group when it was caught outranks all of this —
 * that is not a guess, it is something a person said — and the screen asks for
 * that first.
 *
 * Pure — no mirror, no React — so the rule above is pinned by a test with no
 * device. The read that feeds it lives in `data/reviewSources.ts`.
 */

import { normaliseMerchantName } from '@waves/core';

/** The least a cleaned merchant name may be before it is allowed to point anywhere. */
const SHORTEST_USABLE_NAME = 3;

/** The fields this reads off an expense. Nothing else is needed or looked at. */
export interface FiledExpense {
  readonly groupId: string;
  readonly description: string;
  /** ISO stamp — which of two filings is the later one. */
  readonly at: string;
}

/** A merchant's usual home: the group, and how sure we are allowed to sound. */
export type MerchantDestinations = ReadonlyMap<string, string>;

/**
 * Merchant → the group its spending belongs to, built in one pass over the
 * ledger. Merchants that point two ways at once are simply absent.
 */
export function buildMerchantDestinations(expenses: readonly FiledExpense[]): Map<string, string> {
  const tally = new Map<string, Map<string, { count: number; last: string }>>();

  for (const expense of expenses) {
    const name = normaliseMerchantName(expense.description ?? '');
    if (name.length < SHORTEST_USABLE_NAME) continue;
    let byGroup = tally.get(name);
    if (!byGroup) {
      byGroup = new Map();
      tally.set(name, byGroup);
    }
    const seen = byGroup.get(expense.groupId);
    if (!seen) byGroup.set(expense.groupId, { count: 1, last: expense.at });
    else {
      seen.count += 1;
      if (String(expense.at) > seen.last) seen.last = expense.at;
    }
  }

  const answer = new Map<string, string>();
  for (const [name, byGroup] of tally) {
    let newest: { groupId: string; count: number; last: string } | null = null;
    let busiest = 0;
    for (const [groupId, stats] of byGroup) {
      if (!newest || stats.last > newest.last) newest = { groupId, ...stats };
      busiest = Math.max(busiest, stats.count);
    }
    // The most recent group has to be the most-used one too, or the merchant
    // has no settled home and the row asks rather than guesses.
    if (newest && newest.count >= busiest) answer.set(name, newest.groupId);
  }
  return answer;
}

/** Why a row points where it points — the chip says it differently for each. */
export type DestinationReason =
  /** The person named this group when the spend was caught. */
  | 'tagged'
  /** Derived: this shop's money went there last time. */
  | 'last-time';

export interface RowDestination {
  readonly groupId: string;
  readonly reason: DestinationReason;
}

/**
 * Where one draft would go, or null when nothing can honestly be said.
 *
 * `assignable` is the set of groups the viewer can still write to — a group
 * they left is not an answer, and pointing at one would be a chip that fails on
 * tap.
 */
export function destinationFor(
  capture: { readonly description: string; readonly target_group_id: string | null },
  merchants: MerchantDestinations,
  assignable: ReadonlySet<string>,
): RowDestination | null {
  const tagged = capture.target_group_id;
  if (tagged && assignable.has(tagged)) return { groupId: tagged, reason: 'tagged' };

  const name = normaliseMerchantName(capture.description ?? '');
  if (name.length < SHORTEST_USABLE_NAME) return null;
  const remembered = merchants.get(name);
  if (remembered && assignable.has(remembered)) {
    return { groupId: remembered, reason: 'last-time' };
  }
  return null;
}
