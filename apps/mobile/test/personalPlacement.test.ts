/**
 * Drafts filed under "Just me", and what each one becomes.
 *
 * The row was pinned away on two of the three screens that ask where a draft
 * should go, with a comment explaining that neither had a path to the personal
 * ledger. This planner is that path, and these pin the two things that would
 * quietly lose money if they were wrong: every usable draft becomes exactly one
 * record, and one that cannot be used is *reported* rather than skipped.
 */

import { describe, expect, it } from 'vitest';

import { planPersonalPlacement } from '@/lib/personalPlacement';
import type { CaptureRow } from '@/data/types';

function draft(over: Partial<CaptureRow> = {}): CaptureRow {
  return {
    id: 'capture-1',
    owner_user_id: 'owner',
    description: 'Chai',
    category: null,
    category_meta: null,
    expense_date: '2026-09-14',
    currency: 'INR',
    amount: '4500',
    notes: null,
    photo_path: null,
    raw_text: null,
    parsed: null,
    payment_method: null,
    target_group_id: null,
    location: null,
    status: 'open' as CaptureRow['status'],
    assigned_expense_id: null,
    assigned_group_id: null,
    created_at: '2026-09-14T04:00:00.000Z',
    ...over,
  } as CaptureRow;
}

describe('a draft kept for myself', () => {
  it('becomes one record carrying the draft’s own money and day', () => {
    const plan = planPersonalPlacement({ captures: [draft()], fallbackDescription: 'Unassigned' });
    expect(plan.writes).toHaveLength(1);
    expect(plan.unusable).toEqual([]);
    expect(plan.writes[0]!.data).toMatchObject({
      kind: 'expense',
      currency: 'INR',
      note: 'Chai',
      date: '2026-09-14',
      loanId: null,
      recurringId: null,
    });
  });

  it('takes the draft’s own id, so a retry rewrites rather than duplicates', () => {
    // The guarantee that makes a half-finished run safe to run again.
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'capture-7' })],
      fallbackDescription: 'Unassigned',
    });
    expect(plan.writes[0]!.recordId).toBe('capture-7');
    expect(plan.writes[0]!.captureId).toBe('capture-7');
  });

  it('keeps the category it already had', () => {
    const plan = planPersonalPlacement({
      captures: [draft({ category: 'travel', description: 'Chai' })],
      fallbackDescription: 'Unassigned',
    });
    expect(plan.writes[0]!.data).toMatchObject({ category: 'travel' });
  });

  it('names an unnamed draft rather than filing a blank one', () => {
    const plan = planPersonalPlacement({
      captures: [draft({ description: '   ' })],
      fallbackDescription: 'Unassigned',
    });
    expect(plan.writes[0]!.data).toMatchObject({ note: 'Unassigned' });
  });
});

describe('a pile of them', () => {
  it('writes every one, in the order they were given', () => {
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'a' }), draft({ id: 'b' }), draft({ id: 'c' })],
      fallbackDescription: 'Unassigned',
    });
    expect(plan.writes.map((write) => write.captureId)).toEqual(['a', 'b', 'c']);
    expect(plan.unusable).toEqual([]);
  });

  it('reports the ones it cannot use instead of dropping them', () => {
    // Somebody who sent six and was told six went has no way to notice five did.
    const bad = draft({ id: 'bad', amount: 'not-a-number' });
    const zero = draft({ id: 'zero', amount: '0' });
    const negative = draft({ id: 'negative', amount: '-500' });
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'good' }), bad, zero, negative],
      fallbackDescription: 'Unassigned',
    });
    expect(plan.writes.map((write) => write.captureId)).toEqual(['good']);
    expect(plan.unusable.map((row) => row.id)).toEqual(['bad', 'zero', 'negative']);
  });

  it('has nothing to say about an empty pile', () => {
    const plan = planPersonalPlacement({ captures: [], fallbackDescription: 'Unassigned' });
    expect(plan.writes).toEqual([]);
    expect(plan.unusable).toEqual([]);
  });
});
