/**
 * The window a message import opens on.
 *
 * The failure this guards against is quiet in both directions: a window that
 * misses the trip proposes none of its payments, and a window that runs to
 * "today" for a trip that ended in March drags in three months of unrelated
 * inbox. The trip's own dates are the answer whenever the group has them.
 */

import { describe, expect, it } from 'vitest';

import { smsWindowFor } from '@/data/smsWindow';

const NOW = new Date('2026-08-10T09:00:00.000Z');

describe('smsWindowFor', () => {
  it('uses the trip dates when the group has both', () => {
    const window = smsWindowFor(
      { start_date: '2026-07-01', end_date: '2026-07-08' },
      [{ created_at: '2026-07-03T10:00:00.000Z' }],
      NOW,
    );
    expect(window).toEqual({ from: '2026-07-01', to: '2026-07-08' });
  });

  it('trims a full timestamp down to the day', () => {
    const window = smsWindowFor(
      { start_date: '2026-07-01T00:00:00.000Z', end_date: '2026-07-08T23:59:59.999Z' },
      [],
      NOW,
    );
    expect(window).toEqual({ from: '2026-07-01', to: '2026-07-08' });
  });

  it('runs an open-ended trip (start only) to today', () => {
    const window = smsWindowFor({ start_date: '2026-08-01', end_date: null }, [], NOW);
    expect(window).toEqual({ from: '2026-08-01', to: '2026-08-10' });
  });

  it('starts a trip with an end but no start at the earliest expense', () => {
    const window = smsWindowFor({ start_date: null, end_date: '2026-07-08' }, [
      { created_at: '2026-07-05T12:00:00.000Z' },
      { created_at: '2026-07-02T08:00:00.000Z' },
      { created_at: '2026-07-06T20:00:00.000Z' },
    ]);
    expect(window.from).toBe('2026-07-02');
    expect(window.to).toBe('2026-07-08');
  });

  it('falls back to the earliest expense when there are no trip dates', () => {
    const window = smsWindowFor(
      null,
      [{ created_at: '2026-06-20T10:00:00.000Z' }, { created_at: '2026-06-14T10:00:00.000Z' }],
      NOW,
    );
    expect(window).toEqual({ from: '2026-06-14', to: '2026-08-10' });
  });

  it('falls back to the last 30 days for a group with no dates and no expenses', () => {
    const window = smsWindowFor(undefined, [], NOW);
    expect(window).toEqual({ from: '2026-07-11', to: '2026-08-10' });
  });

  it('ignores blank and null dates rather than treating them as a window', () => {
    const window = smsWindowFor({ start_date: '   ', end_date: '' }, [], NOW);
    expect(window).toEqual({ from: '2026-07-11', to: '2026-08-10' });
  });

  it('ignores expenses that carry no created_at', () => {
    const window = smsWindowFor(null, [{ created_at: null }, { created_at: undefined }], NOW);
    expect(window.from).toBe('2026-07-11');
  });
});
