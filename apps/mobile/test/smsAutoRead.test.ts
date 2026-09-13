/**
 * Waves reading the inbox by itself, and the three promises that makes.
 *
 * The feature is a background job that writes rows nobody asked for, into a
 * screen somebody will open later and trust. So the things worth pinning are
 * not the happy path — they are the ways it could quietly become something
 * else:
 *
 *   1. **A message it read is never written down.** Same rule as the one-tap
 *      read, same single decision (`bodyForDisplay` inside `planSmsDrafts`),
 *      and this path cannot even express the other option: it passes no bodies
 *      at all and marks every key as read. `smsDrafts.test.ts` pins the rule;
 *      this pins that the automatic path is on the right side of it.
 *
 *   2. **Reading twice writes nothing twice.** An hourly job that duplicated
 *      rows would be discovered as a ruined inbox some weeks later. Two
 *      guarantees are tested: the candidate is dropped before it is written
 *      (the dedupe key is already known), and, when that misses, the draft it
 *      would have made is byte-for-byte the one already there — so the id
 *      derived from it is the same id, and the server answers with the success
 *      it already achieved.
 *
 *   3. **The clock only moves over ground actually covered.** A read that
 *      refused, or a write that would not go down, leaves `lastCheckedAt` alone
 *      so the next pass covers the same days rather than stepping over them.
 */

import { describe, expect, it, vi } from 'vitest';

import { proposeFromSms, type SmsMessage } from '@waves/core';

import {
  autoReadWindow,
  BACKFILL_DAYS,
  isBackfill,
  planAutoReadDrafts,
  runAutoRead,
  type AutoReadDeps,
} from '@/lib/smsAutoReadPass';
import { SmsReadFailure, type SmsReadResult, type SmsWindow } from '@/lib/smsReader';
import type { SmsDraft } from '@/lib/smsDrafts';

const SWIGGY = 'Rs.1,250.00 debited from a/c XX4471 on 02-03-26 at SWIGGY. UPI Ref: 412703998812';
const CAFE = 'Rs.240 debited at BLUE TOKAI on 03-03-26. Ref: 998877665544';
const SALARY = 'Rs.85,000.00 credited to a/c XX4471 on 01-03-26. Ref: 771122334455';

const sms = (body: string, receivedAt = '2026-03-02T10:00:00.000Z'): SmsMessage => ({
  body,
  receivedAt,
  sender: 'AD-HDFCBK',
});

const NOW = '2026-03-10T09:00:00.000Z';

/** A pass with everything stubbed; override one piece per test. */
function deps(overrides: Partial<AutoReadDeps> = {}): AutoReadDeps & {
  written: SmsDraft[];
  saved: string[];
  windows: SmsWindow[];
} {
  const written: SmsDraft[] = [];
  const saved: string[] = [];
  const windows: SmsWindow[] = [];
  const base: AutoReadDeps = {
    now: () => NOW,
    loadLastCheckedAt: async () => null,
    saveLastCheckedAt: async (at) => {
      saved.push(at);
    },
    knownKeys: async () => new Set<string>(),
    read: async (): Promise<SmsReadResult> => ({
      ok: true,
      messages: [sms(SWIGGY), sms(CAFE)],
    }),
    write: async (draft) => {
      written.push(draft);
    },
    ...overrides,
  };
  // The window is recorded by wrapping whatever `read` ended up being, so a
  // test that overrides the read still gets to see what was asked for.
  const read = base.read;
  return {
    ...base,
    read: async (window, maxCount) => {
      windows.push(window);
      return read(window, maxCount);
    },
    written,
    saved,
    windows,
  };
}

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

// ─────────────────────────────────── the rule that cannot drift ──

describe('a message read by the app keeps no text', () => {
  it('makes drafts with no rawText at all', () => {
    const drafts = planAutoReadDrafts({
      messages: [sms(SWIGGY), sms(CAFE)],
      knownKeys: new Set(),
    });
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) expect(draft.rawText).toBeNull();
  });

  it('carries no message body anywhere in the serialised draft', () => {
    // Checked over the whole object rather than the one field it is supposed to
    // be in: the failure this guards against is somebody adding a second place
    // for it, not somebody filling in the first.
    const drafts = planAutoReadDrafts({ messages: [sms(SWIGGY)], knownKeys: new Set() });
    const serialised = JSON.stringify(drafts, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('debited');
    expect(serialised).not.toContain('XX4471');
    expect(serialised).not.toContain(SWIGGY);
  });

  it('marks every draft as having come out of the inbox', () => {
    const drafts = planAutoReadDrafts({ messages: [sms(SWIGGY)], knownKeys: new Set() });
    expect(drafts[0].parsed.channel).toBe('inbox');
    expect(drafts[0].parsed.source).toBe('sms');
  });

  it('leaves money coming in alone', () => {
    const drafts = planAutoReadDrafts({ messages: [sms(SALARY)], knownKeys: new Set() });
    expect(drafts).toEqual([]);
  });
});

// ───────────────────────────────────────── reading twice, safely ──

describe('an hourly job that reads the same message again', () => {
  it('proposes nothing it already has a capture for', () => {
    const known = new Set(proposeFromSms([sms(SWIGGY)]).map((item) => item.dedupeKey));
    const drafts = planAutoReadDrafts({ messages: [sms(SWIGGY), sms(CAFE)], knownKeys: known });
    expect(drafts.map((draft) => draft.description)).toEqual(['BLUE TOKAI']);
  });

  it('writes nothing on the second pass over an unchanged inbox', async () => {
    // The shape of the real thing: the keys the first pass wrote are the keys
    // the second one is told about, because the capture it made is in the
    // mirror by then.
    const known = new Set<string>();
    const first = deps({
      knownKeys: async () => known,
      write: async (draft) => {
        known.add(draft.dedupeKey);
      },
    });
    const one = await runAutoRead(first);
    expect(one.written).toBe(2);
    expect(one.backfill).toBe(true);

    const second = deps({
      loadLastCheckedAt: async () => one.checkedAt,
      knownKeys: async () => known,
      write: async (draft) => {
        known.add(draft.dedupeKey);
      },
    });
    const two = await runAutoRead(second);
    expect(two.written).toBe(0);
    expect(two.backfill).toBe(false);
    expect(second.written).toEqual([]);
  });

  it('makes the identical draft when the dedupe check misses', () => {
    // The second guarantee, for a device whose capture has not synced yet: the
    // draft is the same, so `smsCaptureId` derives the same id from it and the
    // server answers a repeat with the success it already achieved rather than
    // a second row. Nothing in a draft may vary run to run — no timestamp, no
    // random id — or that would stop being true.
    const once = planAutoReadDrafts({ messages: [sms(SWIGGY)], knownKeys: new Set() });
    const twice = planAutoReadDrafts({ messages: [sms(SWIGGY)], knownKeys: new Set() });
    expect(twice).toEqual(once);
    expect(twice[0].dedupeKey).toBe(once[0].dedupeKey);
  });

  it('collapses two copies of one message into one draft', () => {
    const drafts = planAutoReadDrafts({
      messages: [sms(SWIGGY), sms(SWIGGY, '2026-03-02T11:00:00.000Z')],
      knownKeys: new Set(),
    });
    expect(drafts).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────── the clock ──

describe('when the reader may say it has checked', () => {
  it('moves the clock after a read that landed', async () => {
    const pass = deps();
    const outcome = await runAutoRead(pass);
    expect(outcome.read).toBe(true);
    expect(outcome.checkedAt).toBe(NOW);
    expect(pass.saved).toEqual([NOW]);
  });

  it('leaves the clock alone when the inbox refused', async () => {
    const pass = deps({
      read: async (): Promise<SmsReadResult> => ({ ok: false, reason: SmsReadFailure.Denied }),
    });
    const outcome = await runAutoRead(pass);
    expect(outcome).toMatchObject({ read: false, written: 0, failure: SmsReadFailure.Denied });
    expect(outcome.checkedAt).toBeNull();
    expect(pass.saved).toEqual([]);
  });

  it('leaves the clock alone when a draft would not go down', async () => {
    // Otherwise the next pass steps over the day the failure happened on and
    // the expense is gone with no trace — the one failure mode this feature
    // must not have.
    const write = vi
      .fn<(draft: SmsDraft) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disk full'));
    const pass = deps({ write });
    const outcome = await runAutoRead(pass);
    expect(outcome.read).toBe(true);
    // The one that worked still counts, and the other is tried again next pass.
    expect(outcome.written).toBe(1);
    expect(outcome.checkedAt).toBeNull();
    expect(pass.saved).toEqual([]);
  });

  it('asks for a bigger sweep on the backfill than on an hourly pass', async () => {
    const caps: number[] = [];
    const record = async (_window: SmsWindow, maxCount: number): Promise<SmsReadResult> => {
      caps.push(maxCount);
      return { ok: true, messages: [] };
    };
    await runAutoRead(deps({ read: record }));
    await runAutoRead(deps({ read: record, loadLastCheckedAt: async () => NOW }));
    expect(caps[0]).toBeGreaterThan(caps[1]);
  });

  it('reads the days since the last check, not ninety of them', async () => {
    const pass = deps({ loadLastCheckedAt: async () => '2026-03-09T08:30:00.000Z' });
    await runAutoRead(pass);
    expect(pass.windows[0]).toEqual({ from: '2026-03-08', to: '2026-03-10' });
  });
});
