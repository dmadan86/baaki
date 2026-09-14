/**
 * Review's two piles.
 *
 * The split is the whole design of the tab, so the rule for which pile a draft
 * falls in — and what the list looks like at nought, one and both — is pinned
 * here rather than left to a screen nobody can run without a phone.
 */

import { describe, expect, it } from 'vitest';

import { CaptureStatus, type CaptureRow } from '../src/data/types';
import {
  buildReviewFeed,
  doubtsAbout,
  openingTab,
  reviewItemKey,
  sectionFor,
  splitByTab,
  tabFor,
} from '../src/lib/reviewFeed';

function capture(
  id: string,
  createdAt: string,
  parsed: Record<string, unknown> | null = null,
): CaptureRow {
  return {
    id,
    owner_user_id: 'user-1',
    description: id,
    category: null,
    category_meta: null,
    expense_date: createdAt.slice(0, 10),
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

describe('sectionFor', () => {
  it('puts anything with a doubt in the second pile and everything else in the first', () => {
    expect(sectionFor(capture('a', '2026-09-10T10:00:00Z'))).toBe('ready');
    expect(sectionFor(capture('b', '2026-09-10T10:00:00Z', sure))).toBe('ready');
    expect(sectionFor(capture('c', '2026-09-10T10:00:00Z', { ...sure, confidence: 0.2 }))).toBe(
      'look',
    );
  });
});

describe('buildReviewFeed', () => {
  it('has nothing to say about an empty inbox', () => {
    expect(buildReviewFeed([])).toEqual({ items: [], counts: { ready: 0, look: 0 } });
  });

  it('draws one heading when only one pile has anything in it', () => {
    const { items, counts } = buildReviewFeed([
      capture('a', '2026-09-10T10:00:00Z'),
      capture('b', '2026-09-10T09:00:00Z'),
    ]);
    expect(counts).toEqual({ ready: 2, look: 0 });
    expect(items).toMatchObject([
      { kind: 'section', section: 'ready', count: 2 },
      { kind: 'single', capture: { id: 'a' } },
      { kind: 'single', capture: { id: 'b' } },
    ]);
    // A screen with one section must look like a screen with one section.
    expect(items.filter((item) => item.kind === 'section')).toHaveLength(1);
  });

  it('draws Ready first, then Worth a look, each with its own count', () => {
    const { items, counts } = buildReviewFeed([
      capture('sure', '2026-09-10T10:00:00Z', sure),
      capture('undated', '2026-09-10T09:00:00Z', { ...sure, dateInferred: true }),
      capture('typed', '2026-09-10T08:00:00Z'),
    ]);
    expect(counts).toEqual({ ready: 2, look: 1 });
    expect(items).toMatchObject([
      { kind: 'section', section: 'ready', count: 2 },
      { kind: 'single', capture: { id: 'sure' } },
      { kind: 'single', capture: { id: 'typed' } },
      { kind: 'section', section: 'look', count: 1 },
      { kind: 'single', capture: { id: 'undated' } },
    ]);
  });

  it('leaves out a day heading when a pile is all one day, and keeps it when it is not', () => {
    const oneDay = buildReviewFeed([
      capture('a', '2026-09-10T10:00:00Z'),
      capture('b', '2026-09-10T09:00:00Z'),
    ]);
    expect(oneDay.items.some((item) => item.kind === 'day')).toBe(false);

    const twoDays = buildReviewFeed([
      capture('a', '2026-09-10T10:00:00Z'),
      capture('b', '2026-09-09T10:00:00Z'),
    ]);
    expect(twoDays.items.filter((item) => item.kind === 'day')).toHaveLength(2);
  });

  it('folds a spoken batch inside its pile and counts it once', () => {
    const { items, counts } = buildReviewFeed([
      capture('spoken-1', '2026-09-10T10:00:00Z', { voiceBatchId: 'v1' }),
      capture('spoken-2', '2026-09-10T09:59:00Z', { voiceBatchId: 'v1' }),
      capture('alone', '2026-09-10T09:00:00Z'),
    ]);
    expect(counts).toEqual({ ready: 2, look: 0 });
    expect(items).toMatchObject([
      { kind: 'section', section: 'ready', count: 2 },
      { kind: 'batch', id: 'v1', items: [{ id: 'spoken-1' }, { id: 'spoken-2' }] },
      { kind: 'single', capture: { id: 'alone' } },
    ]);
  });
});

describe('reviewItemKey', () => {
  it('gives every row a key that is unique across both piles', () => {
    const { items } = buildReviewFeed([
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
