/**
 * The two guest ceilings (ADR-006 addendum): one group, ten days.
 *
 * The interesting cases are the boundaries — the day the trial ends, the group
 * that tips over the limit — and the failure modes that must fail *open*, so a
 * broken timestamp keeps a guest working rather than locking them out.
 */

import { describe, expect, it } from 'vitest';

import {
  GUEST_GROUP_LIMIT,
  GUEST_TRIAL_DAYS,
  guestGate,
  guestGroupBlock,
  guestWriteBlock,
} from '../src/auth/guestLimits';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-08-11T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

describe('guestGate — the trial window', () => {
  it('is fully open the moment the account is made', () => {
    const gate = guestGate({ createdAt: now, groupCount: 0, now });
    expect(gate.expired).toBe(false);
    expect(gate.canWrite).toBe(true);
    expect(gate.canAddGroup).toBe(true);
    expect(gate.daysLeft).toBe(GUEST_TRIAL_DAYS);
  });

  it('counts down whole days remaining', () => {
    expect(guestGate({ createdAt: daysAgo(1), groupCount: 0, now }).daysLeft).toBe(
      GUEST_TRIAL_DAYS - 1,
    );
    expect(guestGate({ createdAt: daysAgo(9), groupCount: 0, now }).daysLeft).toBe(1);
  });

  it('still writes on the last hour of the last day', () => {
    const gate = guestGate({ createdAt: daysAgo(GUEST_TRIAL_DAYS - 0.5), groupCount: 0, now });
    expect(gate.expired).toBe(false);
    expect(gate.canWrite).toBe(true);
    expect(gate.daysLeft).toBe(1);
  });

  it('turns read-only once the window has passed', () => {
    const gate = guestGate({ createdAt: daysAgo(GUEST_TRIAL_DAYS + 1), groupCount: 0, now });
    expect(gate.expired).toBe(true);
    expect(gate.canWrite).toBe(false);
    expect(gate.daysLeft).toBe(0);
    // Read-only means no new group either, even the first.
    expect(gate.canAddGroup).toBe(false);
  });

  it('expires exactly at the boundary, not a millisecond after', () => {
    const gate = guestGate({ createdAt: daysAgo(GUEST_TRIAL_DAYS), groupCount: 0, now });
    expect(gate.expired).toBe(true);
  });
});

describe('guestGate — the group ceiling', () => {
  it('lets a guest hold their first group', () => {
    const gate = guestGate({ createdAt: now, groupCount: 0, now });
    expect(gate.atGroupLimit).toBe(false);
    expect(gate.canAddGroup).toBe(true);
  });

  it('blocks the second group but keeps writing in the first', () => {
    const gate = guestGate({ createdAt: now, groupCount: GUEST_GROUP_LIMIT, now });
    expect(gate.atGroupLimit).toBe(true);
    expect(gate.canAddGroup).toBe(false);
    // Still inside the trial, so expenses in the one group they have are fine.
    expect(gate.canWrite).toBe(true);
  });
});

describe('guestGate — failing open on bad input', () => {
  it('treats an unparseable createdAt as just-created rather than expired', () => {
    const gate = guestGate({ createdAt: 'not a date', groupCount: 0, now });
    expect(gate.expired).toBe(false);
    expect(gate.canWrite).toBe(true);
  });

  it('never reads a negative group count as room to spare', () => {
    expect(guestGate({ createdAt: now, groupCount: -3, now }).canAddGroup).toBe(true);
    // (still under the limit) but the clamp holds at the boundary:
    expect(guestGate({ createdAt: now, groupCount: 0, now }).atGroupLimit).toBe(false);
  });
});

describe('block reasons map to the right gate', () => {
  it('names the group limit before the trial when both could apply', () => {
    const atLimit = guestGate({ createdAt: now, groupCount: 1, now });
    expect(guestGroupBlock(atLimit)).toBe('group_limit');
    expect(guestWriteBlock(atLimit)).toBeNull();
  });

  it('reports the expiry for any write once the trial is over', () => {
    const done = guestGate({ createdAt: daysAgo(30), groupCount: 1, now });
    expect(guestGroupBlock(done)).toBe('trial_expired');
    expect(guestWriteBlock(done)).toBe('trial_expired');
  });

  it('blocks nothing for a fresh guest with room', () => {
    const fresh = guestGate({ createdAt: now, groupCount: 0, now });
    expect(guestGroupBlock(fresh)).toBeNull();
    expect(guestWriteBlock(fresh)).toBeNull();
  });
});
