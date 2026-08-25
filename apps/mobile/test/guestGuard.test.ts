import { describe, expect, it, vi } from 'vitest';

import { guestGate, GuestBlock } from '@waves/core';

vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/data/hooks', () => ({ useGroups: () => ({ data: [] }) }));
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ isGuest: false, session: null }) }));

const { createGuestGuard } = await import('../src/lib/guestGuard');

describe('createGuestGuard', () => {
  it('lets full users through without routing to upgrade', () => {
    const send = vi.fn();
    const guard = createGuestGuard(null, send);

    expect(guard.gate).toBeNull();
    expect(guard.blockAddGroup()).toBe(false);
    expect(guard.blockWrite()).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks group creation at the guest group limit but still allows ordinary writes', () => {
    const send = vi.fn();
    const gate = guestGate({
      createdAt: '2026-08-20T00:00:00.000Z',
      groupCount: 1,
      now: new Date('2026-08-21T00:00:00.000Z'),
    });
    const guard = createGuestGuard(gate, send);

    expect(guard.blockAddGroup()).toBe(true);
    expect(send).toHaveBeenCalledWith(GuestBlock.GroupLimit);
    expect(guard.blockWrite()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('blocks every write with trial-expired reason when the guest trial is over', () => {
    const send = vi.fn();
    const gate = guestGate({
      createdAt: '2026-08-01T00:00:00.000Z',
      groupCount: 0,
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    const guard = createGuestGuard(gate, send);

    expect(guard.blockAddGroup()).toBe(true);
    expect(guard.blockWrite()).toBe(true);
    expect(send).toHaveBeenNthCalledWith(1, GuestBlock.TrialExpired);
    expect(send).toHaveBeenNthCalledWith(2, GuestBlock.TrialExpired);
  });

  it('evaluates many guard checks without mutating the gate object', () => {
    const send = vi.fn();
    const gate = guestGate({
      createdAt: '2026-08-20T00:00:00.000Z',
      groupCount: 1,
      now: new Date('2026-08-21T00:00:00.000Z'),
    });
    const snapshot = { ...gate };
    const guard = createGuestGuard(gate, send);

    for (let i = 0; i < 1_000; i += 1) {
      expect(guard.blockAddGroup()).toBe(true);
    }

    expect(gate).toEqual(snapshot);
    expect(send).toHaveBeenCalledTimes(1_000);
  });
});
