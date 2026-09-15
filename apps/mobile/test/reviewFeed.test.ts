/**
 * Review's list, and the two tabs it is cut into.
 *
 * Which tab a draft belongs to is the whole design of the screen, and what the
 * list looks like at nought, one and many is the rest of it — both pinned here
 * rather than left to a screen nobody can run without a phone.
 *
 * `doubtsAbout` survives the removal of the Ready / Worth a look headings: the
 * doubt is drawn on the row now, which is where it was always read.
 */

import { describe, expect, it } from 'vitest';

import { CaptureStatus, type CaptureRow } from '../src/data/types';
import {
  blockEdges,
  buildReviewFeed,
  doubtsAbout,
  openingTab,
  reviewItemKey,
  splitByTab,
  tabFor,
  type ReviewFeedItem,
} from '../src/lib/reviewFeed';

function capture(
  id: string,
  createdAt: string,
  parsed: Record<string, unknown> | null = null,
  /** The day the money moved, when it is not the day the row was written. */
  expenseDate?: string,
): CaptureRow {
  return {
    id,
    owner_user_id: 'user-1',
    description: id,
    category: null,
    category_meta: null,
    expense_date: expenseDate ?? createdAt.slice(0, 10),
    currency: 'INR',
    amount: '100',
    notes: null,
    photo_path: null,
    raw_text: null,
    parsed,
    payment_method: null,
    target_group_id: null,
    location: null,
    status: CaptureStatus.Open,
    assigned_expense_id: null,
    assigned_group_id: null,
    created_at: createdAt,
  };
}

/** An SMS draft the parser was happy with. */
const sure = { source: 'sms', confidence: 0.95, dateInferred: false };

describe('doubtsAbout', () => {
  it('says nothing about a draft a person made themselves', () => {
    expect(doubtsAbout(capture('a', '2026-09-10T10:00:00Z'))).toEqual([]);
    expect(doubtsAbout(capture('b', '2026-09-10T10:00:00Z', { voiceBatchId: 'v1' }))).toEqual([]);
  });

  it('names each thing the parser was unsure of, and only those', () => {
    expect(doubtsAbout(capture('a', '2026-09-10T10:00:00Z', sure))).toEqual([]);
    expect(
      doubtsAbout(capture('b', '2026-09-10T10:00:00Z', { ...sure, dateInferred: true })),
    ).toEqual(['date-inferred']);
    expect(doubtsAbout(capture('c', '2026-09-10T10:00:00Z', { ...sure, confidence: 0.4 }))).toEqual(
      ['hard-to-read'],
    );
    expect(
      doubtsAbout(capture('d', '2026-09-10T10:00:00Z', { confidence: 0.4, dateInferred: true })),
    ).toEqual([]);
  });
});

describe('buildReviewFeed', () => {
  it('has nothing to say about an empty inbox', () => {
    expect(buildReviewFeed([])).toEqual([]);
  });

  it('lists the drafts in the order they arrived, with no heading over them', () => {
    // The Ready / Worth a look headings are gone. They said how many, which the
    // tab above already says, and the doubt they stood for is drawn on the row
    // itself — so on a tab a hundred and forty deep they were a band of
    // furniture in front of the thing somebody came to read.
    const items = buildReviewFeed([
      capture('sure', '2026-09-10T10:00:00Z', sure),
      capture('undated', '2026-09-10T09:00:00Z', { ...sure, dateInferred: true }),
      capture('typed', '2026-09-10T08:00:00Z'),
    ]);
    expect(items).toMatchObject([
      { kind: 'single', capture: { id: 'sure' } },
      { kind: 'single', capture: { id: 'undated' } },
      { kind: 'single', capture: { id: 'typed' } },
    ]);
  });

  it('leaves out a day heading when it is all one day, and keeps it when it is not', () => {
    const oneDay = buildReviewFeed([
      capture('a', '2026-09-10T10:00:00Z'),
      capture('b', '2026-09-10T09:00:00Z'),
    ]);
    expect(oneDay.some((item) => item.kind === 'day')).toBe(false);

    const twoDays = buildReviewFeed([
      capture('a', '2026-09-10T10:00:00Z'),
      capture('b', '2026-09-09T10:00:00Z'),
    ]);
    expect(twoDays.filter((item) => item.kind === 'day')).toHaveLength(2);
  });

  it('cuts the days by when the money moved, not by when the row was written', () => {
    // The bug this is here for: one scan writes every message it finds in the
    // same second, so a summer of bank messages all carried the same
    // `created_at` and the list read as one enormous "Today" — a page of dates
    // that were all the same date and none of them the date on the bill.
    const items = buildReviewFeed([
      capture('july', '2026-09-15T04:00:00Z', sure, '2026-07-04'),
      capture('august', '2026-09-15T04:00:00Z', sure, '2026-08-19'),
      capture('september', '2026-09-15T04:00:00Z', sure, '2026-09-02'),
    ]);
    expect(items).toMatchObject([
      { kind: 'day', on: '2026-09-02T12:00:00' },
      { kind: 'single', capture: { id: 'september' } },
      { kind: 'day', on: '2026-08-19T12:00:00' },
      { kind: 'single', capture: { id: 'august' } },
      { kind: 'day', on: '2026-07-04T12:00:00' },
      { kind: 'single', capture: { id: 'july' } },
    ]);
  });

  it('keeps one day as one day however the rows were written', () => {
    const items = buildReviewFeed([
      capture('scanned', '2026-09-15T04:00:00Z', sure, '2026-09-10'),
      capture('typed', '2026-09-10T18:00:00Z', null, '2026-09-10'),
    ]);
    expect(items.some((item) => item.kind === 'day')).toBe(false);
  });

  it('folds a spoken batch into one card', () => {
    const items = buildReviewFeed([
      capture('spoken-1', '2026-09-10T10:00:00Z', { voiceBatchId: 'v1' }),
      capture('spoken-2', '2026-09-10T09:59:00Z', { voiceBatchId: 'v1' }),
      capture('alone', '2026-09-10T09:00:00Z'),
    ]);
    expect(items).toMatchObject([
      { kind: 'batch', id: 'v1', items: [{ id: 'spoken-1' }, { id: 'spoken-2' }] },
      { kind: 'single', capture: { id: 'alone' } },
    ]);
  });
});

describe('reviewItemKey', () => {
  it('gives every row a key of its own', () => {
    const items = buildReviewFeed([
      capture('sure', '2026-09-10T10:00:00Z', sure),
      capture('undated', '2026-09-09T09:00:00Z', { ...sure, dateInferred: true }),
    ]);
    const keys = items.map(reviewItemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('which tab a draft belongs to', () => {
  // Two errands, not two degrees of one: "what did it find?" and "where do
  // mine go?" are asked at different moments, and mixing them meant a
  // morning's bank messages buried the three lunches somebody typed.

  it('puts a bank message in the found tab', () => {
    expect(tabFor(capture('a', '2026-09-14T09:00:00.000Z', sure))).toBe('found');
  });

  it('puts everything a person did in the added tab', () => {
    // Typed: no provenance blob at all.
    expect(tabFor(capture('typed', '2026-09-14T09:00:00.000Z', null))).toBe('added');
    // Spoken and photographed both write a blob, but never source 'sms'.
    expect(tabFor(capture('spoken', '2026-09-14T09:00:00.000Z', { source: 'voice' }))).toBe(
      'added',
    );
    expect(tabFor(capture('shot', '2026-09-14T09:00:00.000Z', { batchId: 'b1' }))).toBe('added');
  });

  it('is not fooled by a blob that is not an object', () => {
    expect(tabFor({ parsed: 'sms' })).toBe('added');
    expect(tabFor({ parsed: undefined })).toBe('added');
  });

  it('splits a mixed pile and keeps each side in order', () => {
    const rows = [
      capture('m1', '2026-09-14T09:00:00.000Z', sure),
      capture('t1', '2026-09-14T09:01:00.000Z', null),
      capture('m2', '2026-09-14T09:02:00.000Z', sure),
    ];
    const split = splitByTab(rows);
    expect(split.found.map((row) => row.id)).toEqual(['m1', 'm2']);
    expect(split.added.map((row) => row.id)).toEqual(['t1']);
  });
});

describe('which tab to open on', () => {
  it('opens on your own drafts, because that is the half that can reach zero', () => {
    // The found pile refills on its own for as long as the app can read bank
    // messages. Opening there makes Review a permanent backlog; opening on the
    // finite half is what lets the screen ever look finished.
    const rows = [
      capture('m1', '2026-09-14T09:00:00.000Z', sure),
      capture('t1', '2026-09-14T09:01:00.000Z', null),
    ];
    expect(openingTab(rows)).toBe('added');
  });

  it('opens on what it found when you have added nothing', () => {
    // Otherwise somebody whose drafts all come from bank messages lands on an
    // empty tab every time.
    expect(openingTab([capture('m1', '2026-09-14T09:00:00.000Z', sure)])).toBe('found');
  });

  it('has a stable answer for an empty list', () => {
    expect(openingTab([])).toBe('added');
  });
});

describe('a run of drafts is one card', () => {
  const day = (key: string): ReviewFeedItem => ({
    kind: 'day',
    key,
    on: '2026-09-10T12:00:00',
  });
  const single = (id: string): ReviewFeedItem => ({
    kind: 'single',
    capture: capture(id, '2026-09-10T10:00:00Z'),
  });
  const batch = (id: string): ReviewFeedItem => ({
    kind: 'batch',
    id,
    items: [capture(`${id}-a`, '2026-09-10T10:00:00Z')],
  });

  it('rounds the first and last of a run, and neither in between', () => {
    const feed = [single('a'), single('b'), single('c')];
    expect(feed.map((_, i) => blockEdges(feed, i))).toEqual([
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: true },
    ]);
  });

  it('a lone draft is both ends of its own run', () => {
    const feed = [single('only')];
    expect(blockEdges(feed, 0)).toEqual({ first: true, last: true });
  });

  it('a day heading starts a new card', () => {
    const feed = [single('a'), day('d2'), single('b'), single('c')];
    expect(blockEdges(feed, 0)).toEqual({ first: true, last: true });
    expect(blockEdges(feed, 2)).toEqual({ first: true, last: false });
    expect(blockEdges(feed, 3)).toEqual({ first: false, last: true });
  });

  it('a spoken batch keeps its own card and breaks the run around it', () => {
    // The batch card expands into its own contents; folding it into a divided
    // run would make one card look like two different things at once.
    const feed = [single('a'), batch('v1'), single('b')];
    expect(blockEdges(feed, 0)).toEqual({ first: true, last: true });
    expect(blockEdges(feed, 1)).toEqual({ first: true, last: true });
    expect(blockEdges(feed, 2)).toEqual({ first: true, last: true });
  });
});
