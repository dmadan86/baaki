/**
 * Review, cut into the two piles a person actually feels.
 *
 * The tab used to be one flat run of drafts under day headings. That is the
 * right shape for a ledger you read and the wrong one for a list of questions
 * you are trying to empty: every row looked equally unsure, so every row had to
 * be opened. The split here is **what the app is sure of** — the only
 * distinction that changes what a person does next:
 *
 *   * **Ready** — the app has no doubt about this one. A spend you typed, spoke
 *     or photographed, or a bank message it read cleanly. One gesture files it.
 *   * **Worth a look** — the app read this one and was not certain, and says
 *     which part it was unsure of on the row itself.
 *
 * Not two tabs, deliberately. A tab is a place, and a place has to be worth
 * visiting twice; "worth a look" is a pile you want to *end up with none of*.
 * Sections need no navigation, carry their own counts, and disappear when
 * empty — so a screen with one section looks like a screen with one section,
 * rather than a tab bar with a dead half.
 *
 * ## The other cut, which *is* two tabs
 *
 * Confidence is not the only thing that separates these rows, and the second
 * thing does earn a tab where confidence did not:
 *
 *   * **Found for you** — read out of the phone's bank messages. Nobody asked
 *     for these; the app went and got them, and a person arrives wanting to
 *     know what it found while they were not looking.
 *   * **Added by you** — typed, spoken or photographed. Every one of these is
 *     something a person did on purpose and already knows about; they are here
 *     only because they have not been told which group they belong to yet.
 *
 * Those are two errands, not two degrees of one. "What did it find?" and
 * "where do mine go?" are asked at different moments and answered by different
 * gestures, and mixing them meant a morning's bank messages buried the three
 * lunches somebody typed on purpose. Both halves are worth visiting twice,
 * which is the test a tab has to pass and "worth a look" failed.
 *
 * The confidence split lives *inside* each tab, unchanged. Only found rows can
 * ever be doubted — a spend a person typed is never second-guessed — so in
 * practice the second tab shows one section and the first shows two, which is
 * exactly what each deserves.
 *
 * Everything here is pure so the arithmetic of "which pile, how many, in what
 * order" can be pinned by a test with no device (mobile's vitest renders
 * nothing; see vitest.config.ts).
 */

import { SMS_LOW_CONFIDENCE } from '@waves/core';

import { groupByDay } from '@/data/activity';
import type { CaptureRow } from '@/data/types';
import { foldCaptureBatches, type CaptureInboxItem } from '@/lib/captureFeed';

/** Which pile a draft belongs in. */
export type ReviewSectionId = 'ready' | 'look';

/**
 * A row in the Review list: a section heading, a day heading under one, or a
 * draft (alone, or a spoken batch folded into one card).
 */
export type ReviewFeedItem =
  | { kind: 'section'; key: string; section: ReviewSectionId; count: number }
  | { kind: 'day'; key: string; section: ReviewSectionId; createdAt: string }
  | (CaptureInboxItem & { section: ReviewSectionId });

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

/** Which pile one draft falls in. */
export function sectionFor(capture: { parsed?: unknown }): ReviewSectionId {
  return doubtsAbout(capture).length > 0 ? 'look' : 'ready';
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
 * Whichever has something in it, preferring what the app found — that is the
 * half a person cannot have seen yet. Decided once, from the first load that
 * carries rows, and never re-decided: a tab that moves under somebody between
 * renders is worse than one that opened on the emptier half.
 */
export function openingTab(rows: readonly CaptureRow[]): ReviewTabId {
  const split = splitByTab(rows);
  if (split.found.length > 0) return 'found';
  return split.added.length > 0 ? 'added' : 'found';
}

/** How many drafts are in each pile, folded so one spoken batch counts once. */
export interface ReviewCounts {
  readonly ready: number;
  readonly look: number;
}

/**
 * The list, in order: Ready first with its count, then Worth a look with its
 * own. A pile with nothing in it contributes no heading at all.
 *
 * Day headings survive inside a pile, but only when the pile actually spans
 * more than one day — a month pasted in one go still reads as a calendar, while
 * the ordinary case (everything caught today) is not made to carry a "TODAY"
 * that says nothing. Batches are folded *within* a pile, which is safe because
 * only SMS drafts can land in the second one and a spoken batch is never one.
 */
export function buildReviewFeed(rows: readonly CaptureRow[]): {
  items: ReviewFeedItem[];
  counts: ReviewCounts;
} {
  const piles: Record<ReviewSectionId, CaptureRow[]> = { ready: [], look: [] };
  for (const row of rows) piles[sectionFor(row)].push(row);

  const items: ReviewFeedItem[] = [];
  const counts = { ready: 0, look: 0 };

  for (const section of ['ready', 'look'] as const) {
    const pile = piles[section];
    if (pile.length === 0) continue;

    const days = groupByDay(pile);
    const folded = days.map((day) => ({ day, entries: foldCaptureBatches(day.entries) }));
    const count = folded.reduce((sum, day) => sum + day.entries.length, 0);
    counts[section] = count;

    items.push({ kind: 'section', key: `section-${section}`, section, count });
    for (const { day, entries } of folded) {
      if (days.length > 1) {
        const first = day.entries[0];
        if (first) {
          items.push({
            kind: 'day',
            key: `day-${section}-${day.key}`,
            section,
            createdAt: first.created_at,
          });
        }
      }
      for (const entry of entries) items.push({ ...entry, section });
    }
  }

  return { items, counts };
}

/** The key FlashList tracks a row by. Unique across both piles. */
export function reviewItemKey(item: ReviewFeedItem): string {
  switch (item.kind) {
    case 'section':
    case 'day':
      return item.key;
    case 'batch':
      return `batch-${item.section}-${item.id}`;
    case 'single':
      return item.capture.id;
  }
}
