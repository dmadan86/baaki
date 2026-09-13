/**
 * The window an automatic pass asks for.
 *
 * Two silent failure modes live here and nowhere else: a window that creeps
 * forward over ground it never covered (an expense lost, with nothing to show
 * it ever existed), and a window that grows without bound after a run of
 * failures (a phone that eventually asks for a decade of messages in one
 * sweep). Both are invisible on a device, so they are pinned here instead.
 *
 * What a pass *does* with the messages is `smsScan.ts` now, and is tested in
 * `smsScan.test.ts` — one scan for the button and the hourly job alike.
 */

import { describe, expect, it } from 'vitest';

import { autoReadWindow, BACKFILL_DAYS, isBackfill } from '@/lib/smsAutoReadPass';

const NOW = '2026-03-10T09:00:00.000Z';

// ────────────────────────────────────────────────── the window ──

describe('what a pass asks the inbox for', () => {
  it('reaches back ninety days the first time and says so', () => {
    expect(isBackfill(null)).toBe(true);
    const window = autoReadWindow({ now: NOW, lastCheckedAt: null });
    expect(window).toEqual({ from: '2025-12-10', to: '2026-03-10' });
  });

  it('reads only what is new once it has read once', () => {
    // The day before the last check, not ninety of them: the whole battery
    // story, and the reason the hourly job is cheap enough to be hourly.
    const window = autoReadWindow({ now: NOW, lastCheckedAt: '2026-03-09T08:30:00.000Z' });
    expect(window).toEqual({ from: '2026-03-08', to: '2026-03-10' });
    expect(isBackfill('2026-03-09T08:30:00.000Z')).toBe(false);
  });

  it('never reaches further back than the backfill horizon', () => {
    // A phone that failed for half a year must not eventually ask for half a
    // year of messages in one sweep.
    const window = autoReadWindow({ now: NOW, lastCheckedAt: '2025-01-01T00:00:00.000Z' });
    expect(window.from).toBe('2025-12-10');
    expect(BACKFILL_DAYS).toBe(90);
  });

  it('survives a clock that was wrong and got fixed', () => {
    // A `lastCheckedAt` in the future would otherwise produce a window that
    // ends before it starts, and a filter that matches nothing for ever.
    const window = autoReadWindow({ now: NOW, lastCheckedAt: '2027-01-01T00:00:00.000Z' });
    expect(window.from <= window.to).toBe(true);
    expect(window.to).toBe('2026-03-10');
  });

  it('treats an unreadable stored time as never having checked', () => {
    expect(autoReadWindow({ now: NOW, lastCheckedAt: 'whenever' })).toEqual(
      autoReadWindow({ now: NOW, lastCheckedAt: null }),
    );
  });
});
