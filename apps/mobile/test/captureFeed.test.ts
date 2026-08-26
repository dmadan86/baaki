import { describe, expect, it } from 'vitest';

import { CaptureStatus, type CaptureRow } from '../src/data/types';
import { buildCaptureFeedItems, foldCaptureBatches } from '../src/lib/captureFeed';

function capture(id: string, createdAt: string, batch?: string): CaptureRow {
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
    parsed: batch ? { voiceBatchId: batch } : null,
    payment_method: null,
    target_group_id: null,
    location: null,
    status: CaptureStatus.Open,
    assigned_expense_id: null,
    assigned_group_id: null,
    created_at: createdAt,
  };
}

describe('foldCaptureBatches', () => {
  it('folds captures from the same voice batch at their first-seen position', () => {
    const rows = [
      capture('a', '2026-08-26T10:00:00Z'),
      capture('b', '2026-08-26T10:01:00Z', 'voice-1'),
      capture('c', '2026-08-26T10:02:00Z', 'voice-1'),
      capture('d', '2026-08-26T10:03:00Z'),
    ];

    expect(foldCaptureBatches(rows)).toMatchObject([
      { kind: 'single', capture: { id: 'a' } },
      { kind: 'batch', id: 'voice-1', items: [{ id: 'b' }, { id: 'c' }] },
      { kind: 'single', capture: { id: 'd' } },
    ]);
  });

  it('collapses a one-item batch back to a standalone row', () => {
    expect(foldCaptureBatches([capture('a', '2026-08-26T10:00:00Z', 'voice-1')])).toMatchObject([
      { kind: 'single', capture: { id: 'a' } },
    ]);
  });
});

describe('buildCaptureFeedItems', () => {
  it('flattens day headings and folded captures for FlashList rendering', () => {
    const items = buildCaptureFeedItems([
      capture('today-a', '2026-08-26T10:00:00Z', 'voice-1'),
      capture('today-b', '2026-08-26T10:01:00Z', 'voice-1'),
      capture('yesterday', '2026-08-25T10:00:00Z'),
    ]);

    expect(items).toMatchObject([
      { kind: 'day', key: 'day-2026-8-26' },
      { kind: 'batch', id: 'voice-1', items: [{ id: 'today-a' }, { id: 'today-b' }] },
      { kind: 'day', key: 'day-2026-8-25' },
      { kind: 'single', capture: { id: 'yesterday' } },
    ]);
  });
});
