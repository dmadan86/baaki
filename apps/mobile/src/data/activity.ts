/**
 * Turning an activity row into a sentence.
 *
 * This lives outside both feed screens because there are two of them — the
 * cross-group tab and the tab on a group — and a feed that words the same
 * event two different ways is a feed people stop trusting. It was already
 * wrong once: the group tab rendered `verb` and `object_type` raw, so an
 * offline-sync conflict read "Ravi superseded expense_version", which names
 * a table rather than telling the person their edit was replaced.
 *
 * The actor is the point of the whole thing. On a shared ledger "Dinner was
 * edited" answers nothing — "Ravi edited Dinner" does. Written from the
 * reader's point of view, so their own actions read as "You".
 */

import { isCurrencyCode } from '@baaki/core';

import { actorName, type ActivityRow } from './types';

/**
 * An activity `payload` is an untyped JSON blob, so a bad amount must render as
 * no amount, not as a crashed feed. Shared by both feed screens so they parse
 * it the same way. `fallbackCurrency` is the caller's default — 'INR' on the
 * cross-group tab, the group's own currency on a group.
 */
export function parseMoney(
  payload: unknown,
  fallbackCurrency = 'INR',
): { amount: bigint; currency: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.amount !== 'string') return null;
  const trimmed = record.amount.trim();
  if (trimmed === '') return null;
  try {
    const currency =
      typeof record.currency === 'string' && isCurrencyCode(record.currency)
        ? record.currency
        : fallbackCurrency;
    return { amount: BigInt(trimmed), currency };
  } catch {
    return null;
  }
}

export function describeActivity(entry: ActivityRow, myProfileId: string | null): string {
  const { payload } = entry;
  const description = typeof payload.description === 'string' ? payload.description : null;
  const who = actorName(entry.actor, myProfileId);

  switch (entry.verb) {
    case 'added':
      return `${who} added ${description ?? 'an expense'}`;
    case 'edited':
      return `${who} edited ${description ?? 'an expense'}`;
    case 'deleted':
      return `${who} deleted ${description ?? 'an expense'}`;
    case 'restored':
      return `${who} restored ${description ?? 'an expense'}`;
    case 'superseded': {
      // The conflict entry from offline sync (ADR-005). Both edits survive in
      // expense_versions; this row exists so the person whose edit lost can
      // find it and put it back. Saying "superseded expense" told them nothing.
      const replaced =
        typeof payload.supersededDescription === 'string' ? payload.supersededDescription : null;
      return replaced
        ? `${who}'s edit replaced an earlier one — "${replaced}" is still in the history`
        : `${who}'s edit replaced an earlier one`;
    }
    case 'auto_confirmed':
      // Nobody did this, so it does not get an actor. "Someone confirmed" would
      // be a lie about a settlement that resolved by itself.
      return 'A settlement was confirmed automatically after a week';
    case 'disputed': {
      const reason = typeof payload.reason === 'string' ? payload.reason : null;
      const what = description ?? 'an expense';
      return reason
        ? `${who} says ${what} is not right — "${reason}"`
        : `${who} says ${what} is not right`;
    }
    case 'withdrew_dispute':
      return `${who} took back their correction to ${description ?? 'an expense'}`;
    case 'accepted_dispute':
      return `${who} agreed ${description ?? 'an expense'} needs fixing`;
    case 'rejected_dispute':
      return `${who} says ${description ?? 'an expense'} is correct as it stands`;
    case 'settled':
      return `${who} recorded a settlement`;
    case 'confirmed':
      return `${who} confirmed a settlement`;
    case 'joined':
      return `${who} joined`;
    case 'created':
      return `${who} created the group`;
    default:
      // An unknown verb is a row written by a newer build than this one. Say
      // what is known rather than dropping it — a feed with holes in it is
      // worse than a feed with one clumsy line.
      return `${who} ${entry.verb} ${entry.object_type}`;
  }
}

export function verbEmoji(verb: string): string {
  switch (verb) {
    case 'added':
      return '🧾';
    case 'edited':
    case 'superseded':
      return '✏️';
    case 'deleted':
      return '🗑️';
    case 'restored':
      return '↩️';
    case 'settled':
      return '💸';
    case 'confirmed':
    case 'auto_confirmed':
    case 'accepted_dispute':
      return '✅';
    case 'disputed':
      return '🚩';
    case 'withdrew_dispute':
    case 'rejected_dispute':
      return '🤝';
    case 'joined':
      return '👋';
    case 'created':
      return '✨';
    default:
      return '•';
  }
}

/**
 * "19m ago", "yesterday" — a localized relative time for a timeline entry.
 *
 * `Intl.RelativeTimeFormat` does the wording and the plural in every locale, and
 * `numeric: 'auto'` is what turns "1 day ago" into "yesterday". The unit is the
 * largest that leaves a count of at least one, so a three-hour-old event reads
 * in hours, not 180 minutes.
 *
 * Android's Hermes ships `Intl.DateTimeFormat`/`NumberFormat` but not always
 * `RelativeTimeFormat` — reaching for it there is a constructor on `undefined`,
 * which took the whole Activity screen down. So it is feature-detected, and when
 * it is missing the entry falls back to a short absolute date/time, which Hermes
 * always has. Degraded wording, never a crash.
 *
 * `now` is injectable so the two branches are testable without a live clock.
 */
/**
 * The heading over a day's worth of entries — "Today", "Yesterday", "Saturday",
 * then a plain date once the week is out.
 *
 * A feed of forty rows each stamped "3 days ago" is a list you have to read to
 * navigate; the same rows under day headings are a list you can skim. The
 * wording is `Intl`'s in every locale, and `RelativeTimeFormat` is
 * feature-detected for the same reason `relativeTime` detects it — Hermes does
 * not always ship it, and a missing constructor took this screen down once.
 *
 * The comparison is in calendar days in the phone's own timezone, not in
 * elapsed hours: something logged at 23:50 last night is "yesterday" at 00:10,
 * not "an hour ago" under today's heading.
 */
export function dayHeading(locale: string, iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const when = new Date(parsed);
  const midnight = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(when)) / 86_400_000);

  const RTF = Intl.RelativeTimeFormat as typeof Intl.RelativeTimeFormat | undefined;
  if ((days === 0 || days === 1) && typeof RTF === 'function') {
    return capitalize(locale, new RTF(locale, { numeric: 'auto' }).format(-days, 'day'));
  }
  if (days > 1 && days < 7) {
    return capitalize(locale, new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(when));
  }
  const sameYear = when.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(when);
}

/** "yesterday" → "Yesterday", in the locale's own casing rules. */
function capitalize(locale: string, value: string): string {
  const [first] = Array.from(value);
  return first ? first.toLocaleUpperCase(locale) + value.slice(first.length) : value;
}

/** The calendar day an entry belongs to, as a grouping key in local time. */
export function dayKey(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const when = new Date(parsed);
  return `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`;
}

export function relativeTime(locale: string, iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const seconds = Math.round((parsed - now) / 1000);
  const abs = Math.abs(seconds);

  const RTF = Intl.RelativeTimeFormat as typeof Intl.RelativeTimeFormat | undefined;
  if (typeof RTF === 'function') {
    const rtf = new RTF(locale, { numeric: 'auto' });
    if (abs < 60) return rtf.format(Math.round(seconds), 'second');
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
    if (abs < 604800) return rtf.format(Math.round(seconds / 86400), 'day');
    if (abs < 2629800) return rtf.format(Math.round(seconds / 604800), 'week');
    if (abs < 31557600) return rtf.format(Math.round(seconds / 2629800), 'month');
    return rtf.format(Math.round(seconds / 31557600), 'year');
  }

  // Fallback: a short absolute stamp. Same-year events drop the year.
  const withinYear = abs < 31557600;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(withinYear ? {} : { year: 'numeric' }),
    hour: withinYear ? 'numeric' : undefined,
    minute: withinYear ? '2-digit' : undefined,
  }).format(new Date(Date.parse(iso)));
}
