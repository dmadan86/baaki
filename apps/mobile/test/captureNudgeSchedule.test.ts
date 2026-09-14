import { syncCaptureNudge } from '@/lib/captureNudge/run';
import { cancelNudges, scheduleNudge } from '@/lib/captureNudge/schedule';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifications = vi.hoisted(() => ({
  requests: [] as { identifier: string; content: { data?: Record<string, unknown> } }[],
  cancelled: [] as string[],
  badgeCounts: [] as number[],
  scheduled: [] as unknown[],
}));

vi.mock('@/lib/push', () => ({
  ensureAndroidChannel: vi.fn(),
  localNotificationsAllowed: async () => true,
  pushSupported: true,
}));

vi.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DATE: 'date' },
  getAllScheduledNotificationsAsync: async () => notifications.requests,
  cancelScheduledNotificationAsync: async (identifier: string) => {
    notifications.cancelled.push(identifier);
  },
  scheduleNotificationAsync: async (input: unknown) => {
    notifications.scheduled.push(input);
    return 'scheduled-id';
  },
  setBadgeCountAsync: async (count: number) => {
    notifications.badgeCounts.push(count);
    return true;
  },
}));

const OUR_NUDGE = { identifier: 'ours', content: { data: { key: 'waves.captures.nudge' } } };
const OTHER_NUDGE = { identifier: 'theirs', content: { data: { key: 'waves.other' } } };

describe('capture nudge scheduler', () => {
  beforeEach(() => {
    notifications.requests = [];
    notifications.cancelled = [];
    notifications.badgeCounts = [];
    notifications.scheduled = [];
  });

  it('clears the app badge when cancelling the waiting-captures reminder', async () => {
    notifications.requests = [OUR_NUDGE, OTHER_NUDGE];

    await cancelNudges();

    expect(notifications.cancelled).toEqual(['ours']);
    expect(notifications.badgeCounts).toEqual([0]);
  });

  it('clears a fired reminder badge even when no scheduled request remains', async () => {
    await syncCaptureNudge({
      ownerId: 'user',
      waitingCount: 0,
      oldestWaitingAt: null,
      locale: 'en',
      now: 1_800_000_000_000,
      text: (count) => ({ title: 'Waiting on you', body: `${count} expenses are waiting.` }),
    });

    expect(notifications.cancelled).toEqual([]);
    expect(notifications.badgeCounts).toEqual([0]);
  });

  it('writes the waiting count onto the scheduled reminder badge', async () => {
    await scheduleNudge({
      fireAt: 1_800_000_000_000,
      count: 4,
      locale: 'en',
      text: { title: 'Waiting on you', body: '4 expenses are waiting.' },
    });

    expect(notifications.scheduled).toHaveLength(1);
    expect(notifications.scheduled[0]).toMatchObject({ content: { badge: 4 } });
  });
});
