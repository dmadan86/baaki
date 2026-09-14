/**
 * The half that talks to the operating system: read what alarm we hold, drop
 * it, set a new one.
 *
 * ## Local, not a push
 *
 * `scheduleNotificationAsync` with a DATE trigger — the phone setting an alarm
 * on itself. Nothing here goes near `waves_notify`, `notify-fanout` or pg_cron,
 * and the reasons are argued in full in `docs/plan-recurring-money-events.md`
 * §5.1. The short version, for the capture inbox specifically:
 *
 * - The server would have to be told what somebody is holding unfiled and how
 *   long they have held it, in order to decide whether to say anything. Nothing
 *   needs to know that but the phone, which already does.
 * - `notifications.title` and `.body` are plaintext columns read by the fanout,
 *   by the email claim and by the operator console. A reminder about a person's
 *   own unfiled receipts does not belong in a shared table.
 * - There is no per-user time zone anywhere in this schema — only
 *   `groups.time_zone` — so a server job has no hour to fire at. The device has
 *   the only clock that knows what "this evening" means here.
 * - It needs nothing: no FCM/APNs credentials, no EAS project id, no
 *   `push_tokens` row, no Vault secret, no cron. Five things that must all hold
 *   for a server push to land, against one (permission) for this.
 *
 * ## Nothing here throws, and nothing here is required
 *
 * `expo-notifications` is a native module. It is imported the same way
 * `lib/push.ts` imports it — statically, because it is already in every binary
 * this code can reach, and guarded by `pushSupported` before any call, because
 * reaching into it on web throws rather than no-opping and would take the whole
 * app down on the platform this repo uses for visual checks. Every exported
 * function below swallows its own failures and reports a value: a reminder that
 * could not be set is a reminder that does not happen, never a crash in a
 * headless component nobody is looking at.
 *
 * ## Why the OS list is the source of truth
 *
 * What we hold is read back from `getAllScheduledNotificationsAsync` rather
 * than from our own storage, and matched on a `key` inside the payload. A
 * reinstall, a "clear all", another build's leftovers — the list is the only
 * thing that actually knows. Our stored copy records when the last one was
 * *due*, which the list cannot tell us because a fired notification simply
 * disappears from it.
 */

import * as Notifications from 'expo-notifications';

import { ensureAndroidChannel, pushSupported } from '@/lib/push';

import type { PendingNudge } from './plan';

/**
 * Stamped into every reminder this feature schedules, so the sweep below can
 * tell ours from anything else the app might one day schedule — and so a
 * cancel-all never reaches somebody else's notification.
 */
const NUDGE_KEY = 'waves.captures.nudge';

/**
 * Where the tap goes. `routeForNotification` strips `waves://` and hands the
 * rest to the router, so this needs no change to the tap handler in
 * `_layout.tsx` — it routes on `data.url`, not on a notification kind. The
 * `waves://` form matches the majority of the server's own deep links.
 */
const NUDGE_URL = 'waves://captures';

/** Every reminder of ours the OS is currently holding, newest schedule last. */
async function ourRequests(): Promise<Notifications.NotificationRequest[]> {
  if (!pushSupported) return [];
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    return all.filter((request) => {
      const data = request.content.data as { key?: unknown } | undefined;
      return data?.key === NUDGE_KEY;
    });
  } catch {
    // An unreadable list is treated as an empty one. The worst case is that we
    // schedule a duplicate, which the cancel in `scheduleNudge` then clears.
    return [];
  }
}

/**
 * The reminder this phone is holding, or null.
 *
 * If more than one is somehow outstanding — a build that crashed between the
 * cancel and the schedule — the first is reported and `scheduleNudge` clears
 * the rest, because it always cancels everything of ours before adding one.
 */
export async function pendingNudge(): Promise<PendingNudge | null> {
  const [first] = await ourRequests();
  if (!first) return null;
  const data = first.content.data as
    { fireAt?: unknown; count?: unknown; locale?: unknown } | undefined;
  const fireAt = Number(data?.fireAt);
  const count = Number(data?.count);
  const locale = typeof data?.locale === 'string' ? data.locale : '';
  // A payload we cannot read is one we cannot compare against a plan, so it is
  // reported as "something is scheduled, and it is not what you want" — the
  // fire time of 0 can never equal a real slot, so the caller replaces it.
  if (!Number.isFinite(fireAt) || !Number.isFinite(count)) return { fireAt: 0, count: -1, locale };
  return { fireAt, count, locale };
}

/** Drop every reminder of ours. Used by the planner, and by sign-out. */
export async function cancelNudges(): Promise<void> {
  for (const request of await ourRequests()) {
    try {
      await Notifications.cancelScheduledNotificationAsync(request.identifier);
    } catch {
      // One that will not cancel is one that may still fire. Nothing useful to
      // do about it, and stopping here would leave the others standing too.
    }
  }
}

/** What the reminder says. Rendered by the caller, which is where the strings live. */
export interface NudgeText {
  readonly title: string;
  readonly body: string;
}

/**
 * Replace whatever we hold with one reminder at `fireAt`.
 *
 * Returns whether it was actually set, so the caller only writes the "we
 * scheduled this" marker when something really is scheduled — a marker for a
 * reminder that failed would spend the ceiling on silence.
 */
export async function scheduleNudge(input: {
  readonly fireAt: number;
  readonly count: number;
  readonly locale: string;
  readonly text: NudgeText;
}): Promise<boolean> {
  if (!pushSupported) return false;
  await cancelNudges();
  try {
    // Android delivers silently without a channel, which looks exactly like a
    // bug. The shared `default` channel is deliberate rather than a dedicated
    // one at HIGH importance: this is a gentle "you left something", and a
    // heads-up banner that covers whatever somebody is doing is the wrong
    // register for it entirely.
    await ensureAndroidChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: input.text.title,
        body: input.text.body,
        // The count as a number on the icon rather than as words in the title.
        // Android draws it the way Gmail's does (`setNumber`), iOS puts it on
        // the app badge — and either way the title keeps its width for saying
        // what the thing *is*, instead of spending it on a figure that then
        // truncates. It is still in the body, where there is room to say what
        // the number counts; the badge only repeats it at a glance.
        badge: input.count,
        // No amount, and no description of any single draft: a lock screen is
        // readable without unlocking the phone, and the count is the whole of
        // what needs saying.
        data: {
          key: NUDGE_KEY,
          url: NUDGE_URL,
          fireAt: input.fireAt,
          count: input.count,
          locale: input.locale,
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(input.fireAt),
        channelId: 'default',
      },
    });
    return true;
  } catch {
    // A build with no notification permission, an OS that refused the alarm, a
    // module that is not there. None of them are worth a crash, and the person
    // loses a reminder rather than the app.
    return false;
  }
}
