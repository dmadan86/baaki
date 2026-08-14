/**
 * The two-devices rule, and what "at a time" is allowed to mean.
 *
 * The interesting cases are all about time and identity: a phone that went
 * quiet frees its slot, the same phone re-registering is still one phone, and a
 * device signed out from elsewhere is out now rather than in fourteen days.
 */

import { describe, expect, it } from 'vitest';

import {
  DEVICE_ACTIVE_WINDOW_DAYS,
  activeDevices,
  deviceLimitFor,
  deviceLimitStatus,
  isDeviceActive,
  recentDevices,
  type DeviceSession,
} from '../src/session/devices';
import { PlanTier } from '../src/billing/plans';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

function device(over: Partial<DeviceSession> = {}): DeviceSession {
  return {
    deviceId: over.deviceId ?? 'd1',
    label: over.label ?? 'Pixel 8',
    platform: over.platform ?? 'android',
    appVersion: over.appVersion ?? '1.0.0',
    createdAt: over.createdAt ?? daysAgo(1),
    lastSeenAt: over.lastSeenAt ?? daysAgo(0),
    revokedAt: over.revokedAt ?? null,
    ...over,
  };
}

describe('deviceLimitFor', () => {
  it('gives free two and plus more', () => {
    expect(deviceLimitFor(PlanTier.Free)).toBe(2);
    expect(deviceLimitFor(PlanTier.Plus)).toBeGreaterThan(2);
  });
});

describe('isDeviceActive', () => {
  it('counts a device seen inside the window', () => {
    expect(isDeviceActive(device({ lastSeenAt: daysAgo(13) }), NOW)).toBe(true);
  });

  it('counts one seen exactly on the boundary', () => {
    expect(isDeviceActive(device({ lastSeenAt: daysAgo(DEVICE_ACTIVE_WINDOW_DAYS) }), NOW)).toBe(
      true,
    );
  });

  it('drops one a minute past the window', () => {
    const past = new Date(NOW - DEVICE_ACTIVE_WINDOW_DAYS * DAY - 60_000).toISOString();
    expect(isDeviceActive(device({ lastSeenAt: past }), NOW)).toBe(false);
  });

  it('drops a revoked device however recently it was seen', () => {
    expect(isDeviceActive(device({ lastSeenAt: daysAgo(0), revokedAt: daysAgo(0) }), NOW)).toBe(
      false,
    );
  });
});

describe('activeDevices', () => {
  it('counts phones, not rows: the same device id is one device', () => {
    const rows = [
      device({ deviceId: 'a', lastSeenAt: daysAgo(2) }),
      device({ deviceId: 'a', lastSeenAt: daysAgo(0) }),
      device({ deviceId: 'b', lastSeenAt: daysAgo(1) }),
    ];
    const active = activeDevices(rows, NOW);
    expect(active).toHaveLength(2);
    // The winning row for 'a' is the most recently seen one.
    expect(active.find((d) => d.deviceId === 'a')?.lastSeenAt).toBe(daysAgo(0));
  });

  it('excludes the silent and the revoked', () => {
    const rows = [
      device({ deviceId: 'a', lastSeenAt: daysAgo(0) }),
      device({ deviceId: 'b', lastSeenAt: daysAgo(40) }),
      device({ deviceId: 'c', lastSeenAt: daysAgo(0), revokedAt: daysAgo(0) }),
    ];
    expect(activeDevices(rows, NOW).map((d) => d.deviceId)).toEqual(['a']);
  });
});

describe('deviceLimitStatus', () => {
  it('lets a free account sit at exactly two', () => {
    const rows = [device({ deviceId: 'a' }), device({ deviceId: 'b' })];
    const status = deviceLimitStatus(rows, PlanTier.Free, NOW);
    expect(status).toEqual({ limit: 2, activeCount: 2, overLimit: false });
  });

  it('flags the third phone as over the line', () => {
    const rows = [device({ deviceId: 'a' }), device({ deviceId: 'b' }), device({ deviceId: 'c' })];
    expect(deviceLimitStatus(rows, PlanTier.Free, NOW).overLimit).toBe(true);
  });

  it('does not flag three phones on plus', () => {
    const rows = [device({ deviceId: 'a' }), device({ deviceId: 'b' }), device({ deviceId: 'c' })];
    expect(deviceLimitStatus(rows, PlanTier.Plus, NOW).overLimit).toBe(false);
  });

  it('a freed slot brings a would-be-third back under the limit', () => {
    const rows = [
      device({ deviceId: 'a', lastSeenAt: daysAgo(0) }),
      device({ deviceId: 'b', lastSeenAt: daysAgo(40) }), // silent: slot freed
      device({ deviceId: 'c', lastSeenAt: daysAgo(0) }),
    ];
    expect(deviceLimitStatus(rows, PlanTier.Free, NOW).overLimit).toBe(false);
  });
});

describe('recentDevices', () => {
  it('keeps the last three months, newest first, revoked included', () => {
    const rows = [
      device({ deviceId: 'old', lastSeenAt: daysAgo(120) }), // dropped: older than 90d
      device({ deviceId: 'mid', lastSeenAt: daysAgo(40) }),
      device({ deviceId: 'new', lastSeenAt: daysAgo(1) }),
      device({ deviceId: 'gone', lastSeenAt: daysAgo(3), revokedAt: daysAgo(2) }),
    ];
    expect(recentDevices(rows, NOW).map((d) => d.deviceId)).toEqual(['new', 'gone', 'mid']);
  });

  it('has nothing to say about no devices', () => {
    expect(recentDevices([], NOW)).toEqual([]);
  });
});
