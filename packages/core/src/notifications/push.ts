/**
 * Turning inbox rows into Expo push messages, and reading back what happened.
 *
 * The sending itself is four lines of `fetch` in an edge function. Everything
 * that can actually be got wrong is here, where it can be tested without a
 * network or a phone:
 *
 *   * **Fan-out.** One notification with three devices is three messages, and
 *     the reply comes back as one flat array in send order. Losing track of
 *     which ticket belongs to which token is how a dead device gets a live
 *     token revoked.
 *   * **Language.** The row was written by Postgres, which had no idea who
 *     would read it. A push says the same thing as the inbox, in the same
 *     language, because it is the same notification.
 *   * **Dead tokens.** Expo answers `DeviceNotRegistered` for an app that was
 *     uninstalled. Not revoking those means paying to fail forever; revoking
 *     the wrong one means somebody silently stops getting notifications.
 *
 * Expo takes at most 100 messages per request, so the chunking lives here too.
 */

import { renderNotification, type NotificationFacts } from './render';

/** Expo's cap. Sending more in one request is rejected outright. */
export const EXPO_PUSH_CHUNK = 100;

export interface PushableNotification {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string | null;
  readonly facts?: NotificationFacts;
  /** The recipient's locale — theirs, not the sender's and not the server's. */
  readonly locale?: string | null;
  /** Every live device this person has. */
  readonly tokens: readonly string[];
}

export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly sound: 'default';
  readonly priority: 'high';
  /** Android needs a channel or the notification arrives silent. */
  readonly channelId: 'default';
}

/** Which notification and which device each message in the batch came from. */
export interface PushTarget {
  readonly notificationId: string;
  readonly token: string;
}

export interface PushBatch {
  readonly messages: readonly ExpoPushMessage[];
  readonly targets: readonly PushTarget[];
}

export function buildPushBatch(rows: readonly PushableNotification[]): PushBatch {
  const messages: ExpoPushMessage[] = [];
  const targets: PushTarget[] = [];

  for (const row of rows) {
    const { title, body } = renderNotification(row.kind, row.facts ?? {}, row.locale ?? 'en', {
      title: row.title,
      body: row.body,
    });

    for (const token of row.tokens) {
      messages.push({
        to: token,
        title,
        body,
        // What the app needs to open the right screen when it is tapped.
        data: { notificationId: row.id, kind: row.kind, url: row.deepLink ?? null },
        sound: 'default',
        priority: 'high',
        channelId: 'default',
      });
      targets.push({ notificationId: row.id, token });
    }
  }

  return { messages, targets };
}

export function chunk<T>(items: readonly T[], size = EXPO_PUSH_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export interface ExpoTicket {
  readonly status?: string;
  readonly id?: string;
  readonly message?: string;
  readonly details?: { readonly error?: string };
}

export interface PushOutcome {
  /** Notifications where at least one device accepted the message. */
  readonly delivered: readonly string[];
  /** Notifications where every device refused it. */
  readonly failed: readonly string[];
  /** Tokens belonging to an app that is no longer installed. */
  readonly revoke: readonly string[];
  /**
   * Why the refusals happened, counted by Expo's error code.
   *
   * Without this, a wrong FCM key looks exactly like every phone in the country
   * being switched off: rows go out, tickets come back not-ok, the count of
   * failures climbs, and nothing anywhere says the credentials are the problem.
   * `MismatchSenderId` and `InvalidCredentials` are the two that mean *we* have
   * something to fix rather than the person holding the phone, and they only
   * ever show up here, in the reply to a send.
   */
  readonly problems: readonly PushProblem[];
}

export interface PushProblem {
  /** Expo's `details.error`, or `'unknown'` when it did not give one. */
  readonly error: string;
  readonly count: number;
}

/**
 * The errors that mean the credentials are wrong, not the device.
 *
 * Kept as a list rather than inferred, because the cost of guessing wrong runs
 * one way: a device error mistaken for a config error is noise, and a config
 * error mistaken for a device error is push silently not working for everybody.
 */
export const PUSH_CONFIG_ERRORS: readonly string[] = ['MismatchSenderId', 'InvalidCredentials'];

/** Whether this run's failures point at the FCM/APNs setup rather than at phones. */
export function isPushMisconfigured(problems: readonly PushProblem[]): boolean {
  return problems.some((problem) => PUSH_CONFIG_ERRORS.includes(problem.error));
}

/**
 * Read the tickets against the batch they answer.
 *
 * "Delivered" here means Expo accepted it, which is as much as this layer can
 * ever know — the phone may be off, and the receipt that says so arrives
 * minutes later on a different endpoint. Claiming more than that in the
 * database would be a lie the UI would repeat.
 *
 * A notification counts as delivered if *any* of the person's devices took it.
 * Someone with an old tablet in a drawer should not have every notification
 * marked failed because of it.
 */
export function readPushTickets(
  targets: readonly PushTarget[],
  tickets: readonly ExpoTicket[],
): PushOutcome {
  const accepted = new Set<string>();
  const attempted = new Set<string>();
  const revoke = new Set<string>();
  const problems = new Map<string, number>();

  const note = (error: string): void => {
    problems.set(error, (problems.get(error) ?? 0) + 1);
  };

  targets.forEach((target, index) => {
    attempted.add(target.notificationId);
    const ticket = tickets[index];

    // A short reply is a truncated one; treating a missing ticket as success
    // would mark a notification sent that nobody has seen.
    if (!ticket) {
      note('no_ticket');
      return;
    }

    if (ticket.status === 'ok') {
      accepted.add(target.notificationId);
      return;
    }

    note(ticket.details?.error ?? 'unknown');
    if (ticket.details?.error === 'DeviceNotRegistered') revoke.add(target.token);
  });

  return {
    delivered: [...accepted],
    failed: [...attempted].filter((id) => !accepted.has(id)),
    revoke: [...revoke],
    // Commonest first, then by name, so two identical runs read identically.
    problems: [...problems]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count || a.error.localeCompare(b.error)),
  };
}
