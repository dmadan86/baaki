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

import { planPersonalPlacement, runPersonalPlacement } from '@/lib/personalPlacement';
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

describe('carrying the plan out', () => {
  /** Records the order effects actually happened in, across all drafts. */
  function recorder() {
    const order: string[] = [];
    return {
      order,
      upsert: (write: { captureId: string }) => {
        order.push(`upsert:${write.captureId}`);
        return Promise.resolve();
      },
      close: (captureId: string) => {
        order.push(`close:${captureId}`);
        return Promise.resolve();
      },
    };
  }

  it('queues the record before it closes the draft', async () => {
    // The rule the whole module exists to hold. A draft closed against a record
    // that does not exist is a spend that quietly disappeared.
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'a' })],
      fallbackDescription: 'Unassigned',
    });
    const effects = recorder();
    await runPersonalPlacement({ plan, upsert: effects.upsert, close: effects.close });
    expect(effects.order).toEqual(['upsert:a', 'close:a']);
  });

  it('keeps the draft when its record could not be written', async () => {
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'a' }), draft({ id: 'b' }), draft({ id: 'c' })],
      fallbackDescription: 'Unassigned',
    });
    const closed: string[] = [];
    const outcome = await runPersonalPlacement({
      plan,
      upsert: (write) =>
        write.captureId === 'b' ? Promise.reject(new Error('offline')) : Promise.resolve(),
      close: (captureId) => {
        closed.push(captureId);
        return Promise.resolve();
      },
    });
    // 'b' is never closed — it is still there to try again.
    expect(closed).toEqual(['a', 'c']);
    expect(outcome.done).toEqual(['a', 'c']);
    expect(outcome.failed).toBe(1);
  });

  it('does not let one refusal take the rest down', async () => {
    // The draft after the failure still gets written; the loop carries on.
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'a' }), draft({ id: 'b' })],
      fallbackDescription: 'Unassigned',
    });
    const outcome = await runPersonalPlacement({
      plan,
      upsert: (write) =>
        write.captureId === 'a' ? Promise.reject(new Error('offline')) : Promise.resolve(),
      close: () => Promise.resolve(),
    });
    expect(outcome.done).toEqual(['b']);
  });

  it('counts a draft whose record landed but whose close refused', async () => {
    // Reported rather than claimed: the record exists, so the count of things
    // that "went" must not include a draft still sitting in the list.
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'a' })],
      fallbackDescription: 'Unassigned',
    });
    const outcome = await runPersonalPlacement({
      plan,
      upsert: () => Promise.resolve(),
      close: () => Promise.reject(new Error('offline')),
    });
    expect(outcome.done).toEqual([]);
    expect(outcome.failed).toBe(1);
  });

  it('carries the unusable ones into the failure count', async () => {
    // They never had a write to try, and they must still be reported.
    const plan = planPersonalPlacement({
      captures: [draft({ id: 'good' }), draft({ id: 'bad', amount: 'x' })],
      fallbackDescription: 'Unassigned',
    });
    const outcome = await runPersonalPlacement({
      plan,
      upsert: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
    expect(outcome.done).toEqual(['good']);
    expect(outcome.failed).toBe(1);
  });
});
