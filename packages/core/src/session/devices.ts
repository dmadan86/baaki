/**
 * How many phones one account may hold at once, and which of them still count.
 *
 * The free tier is two devices at a time. "At a time" is the whole difficulty:
 * GoTrue knows about refresh tokens, not about whether the phone in a drawer is
 * ever coming back, so "simultaneous" here means *seen recently*. A device that
 * has not checked in for {@link DEVICE_ACTIVE_WINDOW_DAYS} days stops occupying
 * a slot on its own, which is what keeps a closed phone from locking somebody
 * out of the account they are holding.
 *
 * None of this is enforced on the device — a client that counted its own
 * devices is a client somebody could edit, the same mistake as trusting a row
 * to say who it belongs to (see `readEntitlement`). The numbers are decided by
 * `baaki_register_device` in the database; this module is the shared vocabulary
 * both sides speak, and the part worth testing without a phone.
 */

import type { PlanTier } from '../billing/plans';

/**
 * The default caps, and only the defaults. As of the device-cap A/B work the
 * real numbers live server-side: the `device_cap_free` / `device_cap_plus`
 * knobs in `app_config`, overridden per account by the `device_cap_free_ab` /
 * `device_cap_plus_ab` experiments, all resolved by `baaki_device_cap` and
 * handed back in the registration `status`. These constants are the floor the
 * database itself falls back to, and the value `deviceLimitFor` returns for a
 * caller that has no server status — never the source of truth for the gate,
 * which reads `status.overLimit`. They match the seeded knob defaults so the
 * fallback and the baseline agree.
 */
/** Two at a time on the house. */
export const FREE_DEVICE_LIMIT = 2;
/** Paid is not "unlimited" — an account signed in on many phones is a shared
 *  password, not a subscriber. Three covers a phone, a tablet, and a spare. */
export const PLUS_DEVICE_LIMIT = 3;
/** A device silent longer than this has given its slot back. */
export const DEVICE_ACTIVE_WINDOW_DAYS = 14;
/** The devices view looks back a quarter and no further (the request was three
 *  months); older rows are history nobody is going to act on. */
export const DEVICE_HISTORY_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * One registered phone. Timestamps are ISO strings because that is what crosses
 * the wire and what SQLite stores; comparisons parse them rather than trusting
 * their order as text.
 */
export interface DeviceSession {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: string;
  readonly appVersion: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  /** Set when this device was signed out from elsewhere; null while it lives. */
  readonly revokedAt: string | null;
  /** True for the phone doing the asking. Decided by device id, not the server. */
  readonly current?: boolean;
}

export function deviceLimitFor(tier: PlanTier): number {
  return tier === 'plus' ? PLUS_DEVICE_LIMIT : FREE_DEVICE_LIMIT;
}

/**
 * Whether a device still counts toward the cap: not revoked, and seen inside
 * the window. A revoked device is out the moment it is revoked, whatever its
 * last-seen says — signing it out is a decision, not a timeout.
 */
export function isDeviceActive(
  session: DeviceSession,
  now: number,
  windowDays: number = DEVICE_ACTIVE_WINDOW_DAYS,
): boolean {
  if (session.revokedAt) return false;
  const seen = Date.parse(session.lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return now - seen <= windowDays * DAY_MS;
}

/**
 * The active devices, one per device id. Rows can repeat a device id — the same
 * phone re-registering keeps the same id — so the most recently seen row wins,
 * and the cap is counted in phones, not rows.
 */
export function activeDevices(
  sessions: readonly DeviceSession[],
  now: number,
  windowDays: number = DEVICE_ACTIVE_WINDOW_DAYS,
): DeviceSession[] {
  const byDevice = new Map<string, DeviceSession>();
  for (const session of sessions) {
    // Resolve the newest row per device *first*, then judge activity: a revoked
    // newer row must suppress an older active row for the same phone, not be
    // skipped so the older one keeps the device alive.
    const held = byDevice.get(session.deviceId);
    if (!held || Date.parse(session.lastSeenAt) > Date.parse(held.lastSeenAt)) {
      byDevice.set(session.deviceId, session);
    }
  }
  return [...byDevice.values()].filter((session) => isDeviceActive(session, now, windowDays));
}

export interface DeviceLimitStatus {
  readonly limit: number;
  readonly activeCount: number;
  /** True when this account is holding more phones than its tier allows. */
  readonly overLimit: boolean;
}

/**
 * The count the gate reads. `overLimit` is strictly greater than the limit: a
 * free account is allowed to be *at* two, and only the phone that makes it three
 * is over.
 */
export function deviceLimitStatus(
  sessions: readonly DeviceSession[],
  tier: PlanTier,
  now: number,
  windowDays: number = DEVICE_ACTIVE_WINDOW_DAYS,
): DeviceLimitStatus {
  const limit = deviceLimitFor(tier);
  const activeCount = activeDevices(sessions, now, windowDays).length;
  return { limit, activeCount, overLimit: activeCount > limit };
}

/**
 * What the devices activity view shows: everything seen in the last quarter,
 * newest first, revoked ones included — being told a device *was* signed out is
 * the point of the list, not noise to filter from it.
 */
export function recentDevices(
  sessions: readonly DeviceSession[],
  now: number,
  historyDays: number = DEVICE_HISTORY_DAYS,
): DeviceSession[] {
  const cutoff = now - historyDays * DAY_MS;
  return sessions
    .filter((session) => {
      const seen = Date.parse(session.lastSeenAt);
      return Number.isFinite(seen) && seen >= cutoff;
    })
    .slice()
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}
