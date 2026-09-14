/**
 * Which group a draft probably belongs to — and when to say nothing.
 *
 * Review's rows used to ask "Which group?" on almost everything. A row only
 * pointed somewhere when the *same shop* had been filed before, which answers
 * the second time you buy a coffee and never answers the first, so a morning's
 * bank messages arrived as a hundred and forty identical questions.
 *
 * This replaces that one rule with several, weighed together. Not a model and
 * not a network call: four facts the phone already holds, each worth a fixed
 * amount, added up per group, with a bar the winner has to clear.
 *
 * ## The signals, strongest first
 *
 * **Tagged.** The person named a group when the spend was caught. That is not a
 * guess at all, so it short-circuits everything below and answers outright.
 *
 * **A trip that was running.** The draft's day falls inside a trip's dates. This
 * is the signal the old rule was missing and the reason a first-time merchant
 * could never be answered: on a trip, almost everything belongs to the trip —
 * the shop is new precisely *because* you are somewhere new. Weighted above
 * merchant memory on purpose, so a café you usually file at home goes to Goa
 * while you are in Goa, which is what a person means by "I'm on a trip".
 *
 * **This shop, before.** Where this merchant's money went, by share rather than
 * by last-one-wins: a shop filed three times to the flat and once to a trip
 * points at the flat, and one split down the middle points nowhere. The key is
 * the whole cleaned name, so "Blue Tokai" and "Blue Tokai Coffee" are two
 * merchants — deliberately, because a prefix match would make "Cafe" one
 * merchant and file every café in the city together. The cost of that strictness
 * used to be the whole feature; it is now only one signal of four.
 *
 * **This kind of spend, before.** The same shape over the category. Much weaker
 * — "food" is most groups — so it can only answer on its own when a category
 * has been filed to one group and nowhere else, and never off a single filing.
 *
 * ## Silence is an answer
 *
 * A chip that lies is worse than a chip that asks, so the winner has to clear a
 * floor *and* beat the runner-up by a margin. Two trips overlapping, a merchant
 * split evenly, a trip pointing one way and a strong merchant memory the other:
 * all of them come out here as "ask", which is the honest outcome and the one
 * the person can answer in a tap. The chip is a suggestion either way — tapping
 * it opens the picker — so the cost of asking is small and the cost of being
 * confidently wrong is somebody's ledger.
 *
 * Pure, so every rule above is pinned by a test with no device: the read that
 * feeds it is `data/reviewSources.ts`, and the screen only draws the answer.
 */

import { normaliseMerchantName } from '@waves/core';

import { GroupType, type GroupRow } from '@/data/types';

/** The least a cleaned merchant name may be before it is allowed to point anywhere. */
const SHORTEST_USABLE_NAME = 3;

/**
 * What each signal is worth.
 *
 * `base` is what the signal is worth for merely applying; `share` is what it
 * adds for how *consistent* the history behind it is (all of a merchant's
 * filings in one group scores the lot, an even split scores half). A signal
 * that cannot be consistent — a trip either covers the day or it does not —
 * carries its whole weight in `base`.
 */
const WEIGHT = {
  trip: { base: 0.9, share: 0 },
  merchant: { base: 0.3, share: 0.35 },
  category: { base: 0.25, share: 0.3 },
} as const;

/** What the best answer has to reach before it is said out loud at all. */
export const SUGGESTION_FLOOR = 0.5;

/** And how far clear of the second-best it has to be. */
export const SUGGESTION_MARGIN = 0.15;

/**
 * A category needs more than one filing before it may speak.
 *
 * One expense tagged "food" in a group is not a habit, and categories are broad
 * enough that a single one would have the first restaurant of every month
 * pointing at whichever group happened to hold the last meal.
 */
const MIN_CATEGORY_FILINGS = 2;

/** Why a row points where it points. The chip and the sheet can say it. */
export type SuggestionReason = 'tagged' | 'trip' | 'merchant' | 'category';

export interface GroupSuggestion {
  readonly groupId: string;
  /** The strongest single signal behind it — what to tell a person if asked. */
  readonly reason: SuggestionReason;
  /** 0–1. At `SUGGESTION_FLOOR` or above by construction; never a raw score. */
  readonly confidence: number;
}

/** The fields this reads off an already-filed expense. Nothing else is used. */
export interface FiledExpense {
  readonly groupId: string;
  readonly description: string;
  /** The built-in category id, or null for an expense that never had one. */
  readonly category: string | null;
}

/** A trip's dates, as plain `YYYY-MM-DD` — compared as strings, never parsed. */
export interface TripWindow {
  readonly groupId: string;
  readonly startDate: string;
  readonly endDate: string;
}

/** How often one key's spending went to each group. */
type Tally = Map<string, Map<string, number>>;

export interface SuggestionIndex {
  readonly merchants: Tally;
  readonly categories: Tally;
}

function bump(tally: Tally, key: string, groupId: string): void {
  let byGroup = tally.get(key);
  if (!byGroup) {
    byGroup = new Map();
    tally.set(key, byGroup);
  }
  byGroup.set(groupId, (byGroup.get(groupId) ?? 0) + 1);
}

/**
 * One pass over the ledger this device already holds: who files what, where.
 *
 * Counts only — no timestamps. The old rule needed them to break a tie by
 * recency; this one breaks ties by share and by the other signals, and a "most
 * recent wins" rule is exactly how one unusual filing on a Tuesday hijacks a
 * shop's settled home.
 */
export function buildSuggestionIndex(expenses: readonly FiledExpense[]): SuggestionIndex {
  const merchants: Tally = new Map();
  const categories: Tally = new Map();

  for (const expense of expenses) {
    const name = normaliseMerchantName(expense.description ?? '');
    if (name.length >= SHORTEST_USABLE_NAME) bump(merchants, name, expense.groupId);
    if (expense.category) bump(categories, expense.category, expense.groupId);
  }

  return { merchants, categories };
}

/** The share of `key`'s filings that went to each group, and how many there were. */
function scoresFrom(
  tally: Tally,
  key: string | null,
  weight: { base: number; share: number },
  minimum: number,
  assignable: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!key) return out;
  const byGroup = tally.get(key);
  if (!byGroup) return out;

  let total = 0;
  for (const count of byGroup.values()) total += count;
  if (total < minimum) return out;

  for (const [groupId, count] of byGroup) {
    // A group the viewer can no longer write to is not an answer, and pointing
    // at one would be a chip that fails on tap.
    if (!assignable.has(groupId)) continue;
    out.set(groupId, weight.base + weight.share * (count / total));
  }
  return out;
}

/**
 * The dated trips among the groups a viewer can write to.
 *
 * A trip with no dates is not a window and cannot cover anything, so it is left
 * out rather than treated as always-on — "we went to Goa at some point" must
 * not file this morning's coffee. Only the two ends and the id travel on; this
 * is the whole of what `suggestGroup` is allowed to know about a group.
 */
export function tripWindowsOf(groups: readonly GroupRow[]): TripWindow[] {
  const windows: TripWindow[] = [];
  for (const group of groups) {
    if (group.type !== GroupType.Trip) continue;
    if (!group.start_date || !group.end_date) continue;
    windows.push({ groupId: group.id, startDate: group.start_date, endDate: group.end_date });
  }
  return windows;
}

/** Every trip whose dates cover this day. Two of them is an ambiguity, not a win. */
export function tripsCovering(date: string, trips: readonly TripWindow[]): string[] {
  if (!date) return [];
  return trips
    .filter((trip) => trip.startDate <= date && date <= trip.endDate)
    .map((trip) => trip.groupId);
}

export interface SuggestionInput {
  readonly capture: {
    readonly description: string;
    readonly category: string | null;
    readonly expense_date: string;
    readonly target_group_id: string | null;
  };
  readonly index: SuggestionIndex;
  readonly trips: readonly TripWindow[];
  /** The groups the viewer can still write to. */
  readonly assignable: ReadonlySet<string>;
}

/**
 * The answer for one draft, or null when the honest answer is to ask.
 *
 * The scores are added per group and the best one is taken, but it is only
 * *said* when it clears `SUGGESTION_FLOOR` and beats the runner-up by
 * `SUGGESTION_MARGIN`. Both bars matter and they catch different mistakes: the
 * floor stops a lone weak signal from sounding certain, and the margin stops two
 * strong signals that disagree from being resolved by a rounding error.
 */
export function suggestGroup(input: SuggestionInput): GroupSuggestion | null {
  const { capture, index, trips, assignable } = input;

  // Something a person said outranks everything the app worked out.
  const tagged = capture.target_group_id;
  if (tagged && assignable.has(tagged)) {
    return { groupId: tagged, reason: 'tagged', confidence: 1 };
  }

  const totals = new Map<string, number>();
  const best = new Map<string, { reason: SuggestionReason; weight: number }>();

  const add = (groupId: string, score: number, reason: SuggestionReason): void => {
    totals.set(groupId, (totals.get(groupId) ?? 0) + score);
    const current = best.get(groupId);
    if (!current || score > current.weight) best.set(groupId, { reason, weight: score });
  };

  for (const groupId of tripsCovering(capture.expense_date, trips)) {
    if (assignable.has(groupId)) add(groupId, WEIGHT.trip.base, 'trip');
  }

  const merchantKey = normaliseMerchantName(capture.description ?? '');
  const merchantScores = scoresFrom(
    index.merchants,
    merchantKey.length >= SHORTEST_USABLE_NAME ? merchantKey : null,
    WEIGHT.merchant,
    1,
    assignable,
  );
  for (const [groupId, score] of merchantScores) add(groupId, score, 'merchant');

  const categoryScores = scoresFrom(
    index.categories,
    capture.category,
    WEIGHT.category,
    MIN_CATEGORY_FILINGS,
    assignable,
  );
  for (const [groupId, score] of categoryScores) add(groupId, score, 'category');

  let winner: { groupId: string; score: number } | null = null;
  let runnerUp = 0;
  for (const [groupId, score] of totals) {
    if (!winner || score > winner.score) {
      if (winner) runnerUp = Math.max(runnerUp, winner.score);
      winner = { groupId, score };
    } else {
      runnerUp = Math.max(runnerUp, score);
    }
  }

  if (!winner) return null;
  if (winner.score < SUGGESTION_FLOOR) return null;
  if (winner.score - runnerUp < SUGGESTION_MARGIN) return null;

  return {
    groupId: winner.groupId,
    reason: best.get(winner.groupId)?.reason ?? 'merchant',
    confidence: Math.min(1, winner.score),
  };
}
