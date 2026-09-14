/**
 * Review's list: one run of drafts, newest first, under day headings.
 *
 * ## The cut that stayed, and the one that went
 *
 * Two things separate these rows, and only one of them earns a place in the
 * layout.
 *
 * **Where a draft came from** is a tab, and stays one:
 *
 *   * **SMS** — read out of the phone's bank messages, or pasted in from one.
 *     Nobody asked for these; the app went and got them, and a person arrives
 *     wanting to know what it found while they were not looking.
 *   * **Added by you** — typed, spoken or photographed. Every one is something
 *     a person did on purpose and already knows about; they are here only
 *     because they have not been told which group they belong to yet.
 *
 * Two errands, not two degrees of one. "What did it find?" and "where do mine
 * go?" are asked at different moments and answered by different gestures, and
 * mixing them meant a morning's bank messages buried the three lunches somebody
 * typed on purpose.
 *
 * **What the app was sure of** used to cut each tab again, into *Ready* and
 * *Worth a look*, with a counted heading over each. Those headings are gone.
 * The reasoning for them was sound and the result was not: on a tab holding a
 * hundred and forty drafts, "READY 134" is a band of furniture above a list
 * whose first row is about to say the same thing better. Because the doubt is
 * already **on the row** — `doubtsAbout` drives a mark there, naming the part
 * the parser was unsure of — the heading was never where a person learned it.
 * It only said how many, which is a number the tab above already carries.
 *
 * So the confidence cut survives where it was always most useful (the row) and
 * leaves the layout it was not earning. What remains is the shape a list of
 * questions wants: the drafts, in the order they arrived, with a day heading
 * when and only when the pile spans more than one day.
 *
 * Everything here is pure so the arithmetic of "which tab, in what order" can
 * be pinned by a test with no device (mobile's vitest renders nothing; see
 * vitest.config.ts).
 */

import { SMS_LOW_CONFIDENCE } from '@waves/core';

import { groupByDay } from '@/data/activity';
import type { CaptureRow } from '@/data/types';
import { foldCaptureBatches, type CaptureInboxItem } from '@/lib/captureFeed';

/**
 * A row in the Review list: a day heading, or a draft (alone, or a spoken batch
 * folded into one card).
 */
export type ReviewFeedItem = { kind: 'day'; key: string; createdAt: string } | CaptureInboxItem;

/**
 * What the app was unsure of about one draft, as machine-readable reasons the
 * screen turns into sentences. Empty means it is Ready.
 *
 * Read from the `parsed` provenance an SMS draft carries (`lib/smsDrafts.ts`) —
 * facts about the message, never the message. Only two things put a draft in
 * the second pile, and they are the same two that stopped it being pre-ticked
 * on the screen that made it: the message named no day, or the parser only half
 * understood it. A spend a person typed or spoke has no such doubt and is never
 * here; inventing one would be the screen second-guessing its own user.
 */
export type ReviewDoubt = 'date-inferred' | 'hard-to-read';

export function doubtsAbout(capture: { parsed?: unknown }): ReviewDoubt[] {
  const parsed = capture.parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const blob = parsed as { source?: unknown; confidence?: unknown; dateInferred?: unknown };
  if (blob.source !== 'sms') return [];
  const doubts: ReviewDoubt[] = [];
  if (blob.dateInferred === true) doubts.push('date-inferred');
  if (typeof blob.confidence === 'number' && blob.confidence < SMS_LOW_CONFIDENCE) {
    doubts.push('hard-to-read');
  }
  return doubts;
}

/** Which tab a draft belongs to: what the app found, or what its user added. */
export type ReviewTabId = 'found' | 'added';

/**
 * Where a draft came from.
 *
 * The one fact that decides it is the provenance an SMS draft carries
 * (`lib/smsDrafts.ts`), which is written by the only path that reads messages.
 * Everything else — typed, spoken, photographed — is something a person did,
 * and the absence of that mark is a reliable way to say so: no other source
 * writes it, and a draft with no `parsed` blob at all is a typed one.
 */
export function tabFor(capture: { parsed?: unknown }): ReviewTabId {
  const parsed = capture.parsed;
  if (!parsed || typeof parsed !== 'object') return 'added';
  return (parsed as { source?: unknown }).source === 'sms' ? 'found' : 'added';
}

/**
 * The drafts of each tab, in the order they arrived.
 *
 * Counted here rather than by the feed builder, because a tab's label has to
 * say how many are behind it *before* anyone opens it — a tab whose count only
 * appears once you visit is a tab you have to visit to know you can skip.
 *
 * These are raw counts, not folded ones: a spoken batch shows as one card in
 * the list but is several drafts, and the number on a tab answers "how much is
 * waiting", which is the unfolded question.
 */
export function splitByTab(rows: readonly CaptureRow[]): Record<ReviewTabId, CaptureRow[]> {
  const split: Record<ReviewTabId, CaptureRow[]> = { found: [], added: [] };
  for (const row of rows) split[tabFor(row)].push(row);
  return split;
}

/**
 * Which tab to open on.
 *
 * Whichever has something in it, preferring **what the person added
 * themselves**. This is a reversal: it used to prefer the found pile, on the
 * grounds that it is the half nobody has seen yet, and that was the right rule
 * while the found pile was a handful of drafts an hourly read had turned up.
 *
 * It is the wrong rule now that the same pile is the automatic one. A phone
 * whose messages the app reads tops that half up on its own, forever — open
 * there and Review is a backlog every single time, a screen that can never look
 * finished no matter what anybody does to it. The other half is finite: it is
 * exactly the spends this person caught on purpose and has not filed, and it
 * empties when they are done. Opening on the half that can reach zero is what
 * makes the zero state reachable at all.
 *
 * Decided once, from the first load that carries rows, and never re-decided: a
 * tab that moves under somebody between renders is worse than one that opened
 * on the emptier half.
 */
export function openingTab(rows: readonly CaptureRow[]): ReviewTabId {
  const split = splitByTab(rows);
  if (split.added.length > 0) return 'added';
  return split.found.length > 0 ? 'found' : 'added';
}

/**
 * The list, in the order the drafts arrived.
 *
 * Day headings only when the pile actually spans more than one day — a month
 * pasted in one go still reads as a calendar, while the ordinary case
 * (everything caught today) is not made to carry a "TODAY" that says nothing.
 * Expenses spoken in one breath are folded into one card.
 */
export function buildReviewFeed(rows: readonly CaptureRow[]): ReviewFeedItem[] {
  if (rows.length === 0) return [];

  const items: ReviewFeedItem[] = [];
  const days = groupByDay(rows);

  for (const day of days) {
    if (days.length > 1) {
      const first = day.entries[0];
      if (first) items.push({ kind: 'day', key: `day-${day.key}`, createdAt: first.created_at });
    }
    for (const entry of foldCaptureBatches(day.entries)) items.push(entry);
  }

  return items;
}

/** The key FlashList tracks a row by. */
export function reviewItemKey(item: ReviewFeedItem): string {
  switch (item.kind) {
    case 'day':
      return item.key;
    case 'batch':
      return `batch-${item.id}`;
    case 'single':
      return item.capture.id;
  }
}

/**
 * Where a draft sits in its run of neighbours — the two facts a row needs to
 * draw itself as part of one card rather than as a card of its own.
 *
 * The list used to be a stack of little white cards with a gap between each,
 * and at seven rows a screen most of what the eye landed on was the gap. A run
 * of plain rows divided by a hairline, inside one rounded surface, is the same
 * information in about two thirds of the height — it is what the Friends tab
 * already does, and what a list of like things is supposed to look like.
 *
 * A **run** is a maximal stretch of single drafts. A day heading ends one, for
 * the obvious reason. So does a spoken batch: that is a card in its own right,
 * with its own expanding contents, and swallowing it into a divided run would
 * make one card look like two things at once.
 */
export function blockEdges(
  items: readonly ReviewFeedItem[],
  index: number,
): { first: boolean; last: boolean } {
  const runs = (item: ReviewFeedItem | undefined): boolean => item?.kind === 'single';
  if (!runs(items[index])) return { first: true, last: true };
  return { first: !runs(items[index - 1]), last: !runs(items[index + 1]) };
}
