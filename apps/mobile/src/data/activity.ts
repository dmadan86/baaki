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

import type Ionicons from '@expo/vector-icons/Ionicons';

import { isCurrencyCode } from '@waves/core';

import { actorName, type ActivityRow, type ExpenseVersionRow } from './types';

import type { MemberId } from '@waves/core';

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

/**
 * What one expense did to one person's balance — what they put in beyond their
 * own share (positive: they lent), or their share of what somebody else put in
 * (negative: they borrowed).
 *
 * `null` means they are in neither column: an expense between other people in
 * the group. That is a blank on the row, not a zero — a zero would read as "you
 * are square on this one", which is a different sentence.
 *
 * Shared by the group ledger and both activity feeds, so the coloured figure on
 * an expense row means the same thing wherever it is read.
 */
export function myStake(
  version: ExpenseVersionRow | null | undefined,
  memberId: MemberId | null,
): bigint | null {
  if (!version || !memberId) return null;
  const paid = version.payers.find((row) => row.member_id === memberId)?.amount;
  const share = version.shares.find((row) => row.member_id === memberId)?.amount;
  const paidN = BigInt(paid ?? 0);
  const shareN = BigInt(share ?? 0);
  // Not involved is "put nothing in, owe nothing" — which covers both the member
  // absent from the bill entirely AND a member written into the split with a zero
  // share (an excluded party some imports still list). Either way there is no
  // stake, so the row must read "not involved", not "all settled" — a settled
  // square is what you get when you paid and owed the *same non-zero* amount.
  if (paidN === 0n && shareN === 0n) return null;
  return paidN - shareN;
}

export function describeActivity(
  entry: ActivityRow,
  myProfileId: string | null,
  blocked?: ReadonlySet<string> | null,
  someoneLabel = 'Someone',
): string {
  const { payload } = entry;
  const description = typeof payload.description === 'string' ? payload.description : null;
  const who = actorName(entry.actor, myProfileId, blocked, someoneLabel);

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
    case 'cancelled':
      return `${who} cancelled a recorded payment`;
    case 'settle_disputed': {
      const reason = typeof payload.reason === 'string' ? payload.reason : null;
      return reason
        ? `${who} says a payment didn't reach them — "${reason}"`
        : `${who} says a payment didn't reach them`;
    }
    case 'joined':
      return `${who} joined`;
    case 'created': {
      // The group's name at creation, carried on the payload. Nameless groups
      // (ADR: nameless_groups) leave it null, so those still read "the group".
      const name =
        typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null;
      return name ? `${who} created ${name}` : `${who} created the group`;
    }
    default:
      // An unknown verb is a row written by a newer build than this one. Say
      // what is known rather than dropping it — a feed with holes in it is
      // worse than a feed with one clumsy line.
      return `${who} ${entry.verb} ${entry.object_type}`;
  }
}

/**
 * The feed row's first line — the *event*, not the actor.
 *
 * `describeActivity` writes a full sentence ("Ravi added Dinner") and stays the
 * row's accessibility label, because a screen reader wants the whole thing in
 * one utterance. But a sighted reader skims, and a column of sentences all
 * starting with a name is slow to scan — the thing that varies row to row (what
 * happened) is buried mid-sentence. So the visible title leads with the event
 * and the actor drops to the metadata line beneath it: "Dinner added" over
 * "Ravi · Goa Trip · 2h ago". One event still reads one way in both feeds,
 * which is why this lives here beside the sentence and the icon.
 *
 * English to match `describeActivity`, which is itself not yet localized — this
 * is not the change that closes that gap.
 */
export function activityHeadline(entry: ActivityRow): string {
  const { payload } = entry;
  const description = typeof payload.description === 'string' ? payload.description : null;
  // Verb first, description second. An imported description can itself be a whole
  // clause ("Hethu paid Madan D."), and suffixing the verb onto that reads as a
  // dangling "... added". Leading with the verb keeps our word anchored and reads
  // cleanly whatever the description is. Lower-case fallback since it now trails
  // a capitalised verb.
  const what = description ?? 'expense';

  switch (entry.verb) {
    case 'added':
      return `Added ${what}`;
    case 'edited':
      return `Edited ${what}`;
    case 'deleted':
      return `Deleted ${what}`;
    case 'restored':
      return `Restored ${what}`;
    case 'superseded':
      return 'Edit replaced';
    case 'disputed':
      return `Flagged ${what}`;
    case 'withdrew_dispute':
      return 'Correction withdrawn';
    case 'accepted_dispute':
      return 'Correction accepted';
    case 'rejected_dispute':
      return 'Marked correct';
    case 'settled':
      return 'Settlement recorded';
    case 'confirmed':
      return 'Settlement confirmed';
    case 'auto_confirmed':
      return 'Settlement auto-confirmed';
    case 'cancelled':
      return 'Payment cancelled';
    case 'settle_disputed':
      return 'Payment rejected';
    case 'joined':
      return 'Joined the group';
    case 'created': {
      const name =
        typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null;
      return name ? `Created ${name}` : 'Group created';
    }
    case 'imported':
      return 'Group imported';
    case 'auto_archived':
      return 'Group archived';
    default:
      // A verb from a newer build. Say what is known rather than dropping the row.
      return `${entry.verb} ${entry.object_type}`;
  }
}

/**
 * Where a feed row should open.
 *
 * Every entry defaulted to the group screen, which answers "which group" but not
 * "which thing" — tapping "Dinner edited" and landing on the group list, not on
 * Dinner, is a dead end. The server stamps each row with the object it is about
 * (`object_type` + `object_id`), so an expense event opens the expense and a
 * join opens the member. A settlement has no detail screen of its own, so it
 * (and a group-level event) opens the group, where the confirm cards live. A
 * missing id or an unknown type falls back to the group — the old behaviour,
 * never a broken link. A stale id lands on the app's existing not-found state,
 * the same as any other deep link into a since-deleted row.
 */
export function activityTarget(entry: ActivityRow): string {
  const group = `/group/${entry.group_id}`;
  if (!entry.object_id) return entry.object_type === 'member' ? `${group}/members` : group;
  switch (entry.object_type) {
    case 'expense':
      return `${group}/expense/${entry.object_id}`;
    case 'member':
      return `${group}/member/${entry.object_id}`;
    default:
      // settlement, group, and anything a newer build adds: the group screen.
      return group;
  }
}

/**
 * The verb as one monochrome Ionicons line glyph — the node both feeds hang off.
 * It lives here for the same reason the wording does: two feeds drawing the same
 * event two different ways is a feed people stop trusting. Rendered in a
 * soft-brand circle, one accent, matching the dashboard's icon language exactly.
 * (Replaced an emoji-per-verb map, whose stickers clashed with the line icons
 * the rest of the app uses.)
 */
export function verbIcon(verb: string): React.ComponentProps<typeof Ionicons>['name'] {
  switch (verb) {
    case 'added':
      return 'receipt-outline';
    case 'edited':
    case 'superseded':
      return 'create-outline';
    case 'deleted':
      return 'trash-outline';
    case 'restored':
      return 'arrow-undo-outline';
    case 'settled':
      return 'card-outline';
    case 'confirmed':
    case 'auto_confirmed':
    case 'accepted_dispute':
    case 'withdrew_dispute':
    case 'rejected_dispute':
      return 'checkmark-circle-outline';
    case 'disputed':
    case 'settle_disputed':
      return 'flag-outline';
    case 'cancelled':
      return 'close-circle-outline';
    case 'joined':
      return 'person-add-outline';
    case 'created':
      return 'sparkles-outline';
    default:
      return 'ellipse-outline';
  }
}

/** The pastel tint keys an activity tile can wear (a subset of the app's tint family). */
export type ActivityTint = 'mint' | 'coral' | 'sky' | 'lilac';

/**
 * The soft tile colour for an activity verb, so the feed is skimmable by hue:
 * mint for money arriving and for confirmations, coral for a delete or a
 * dispute, sky for something added or someone joining, lilac (the brand-leaning
 * neutral) for edits, creation and anything a newer build introduces. Shared by
 * both feeds — the group Activity tab and the cross-group one — so an event
 * wears the same colour wherever it is shown. The caller maps the key through
 * `theme.tint[...]`, keeping this free of the UI theme.
 */
export function verbTint(verb: string): ActivityTint {
  switch (verb) {
    case 'settled':
    case 'confirmed':
    case 'auto_confirmed':
    case 'accepted_dispute':
    case 'restored':
    case 'withdrew_dispute':
      return 'mint';
    case 'deleted':
    case 'disputed':
    case 'settle_disputed':
    case 'cancelled':
    case 'rejected_dispute':
      return 'coral';
    case 'added':
    case 'joined':
      return 'sky';
    case 'edited':
    case 'superseded':
    case 'created':
    default:
      return 'lilac';
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

/**
 * Any feed cut into calendar days, newest first, order otherwise untouched —
 * the caller's own query already sorts it, so this only draws the lines
 * between days. Shared by the activity feed and the captures inbox, which
 * both read as "a list of things that happened" and both want the same day
 * headings rather than each inventing its own.
 */
export function groupByDay<T extends { created_at: string }>(
  entries: readonly T[],
): { key: string; entries: T[] }[] {
  const sections: { key: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.created_at);
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else sections.push({ key, entries: [entry] });
  }
  return sections;
}

/**
 * The earliest and latest calendar day present in a feed, each as a local Date
 * anchored at noon (a date-only value a picker is happy to seed from). Null for
 * an empty feed.
 *
 * This is what the Activity filter clamps its range picker to: the selectable
 * span is exactly the feed's own start and end, so a day before the first event
 * or after the last cannot be picked. The bounds come from the rows'
 * `created_at` read in the phone's own timezone — the same convention
 * `groupByDay`/`dayHeading` bucket by — so the picker and the day headings
 * agree on which day a timestamp belongs to. Noon, not midnight, so the anchor
 * can never slip to the neighbouring day when the picker re-reads it locally.
 */
export function activityDateSpan(
  entries: readonly { created_at: string }[],
): { earliest: Date; latest: Date } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const parsed = Date.parse(entry.created_at);
    if (!Number.isFinite(parsed)) continue;
    if (parsed < min) min = parsed;
    if (parsed > max) max = parsed;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const noon = (ms: number): Date => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  };
  return { earliest: noon(min), latest: noon(max) };
}

/**
 * The rows whose calendar day falls within `[start, end]` inclusive, compared
 * in the phone's own timezone so the cut agrees with the day headings above it.
 * The bounds are taken at day granularity — a row's time of day never trims it —
 * and the two ends are ordered defensively, so a range picked end-first still
 * yields the same window. A pure cut on the already-loaded feed: no fetch, the
 * whole history is on the phone (the mirror).
 */
export function filterByDayRange<T extends { created_at: string }>(
  entries: readonly T[],
  start: Date,
  end: Date,
): T[] {
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const lo = Math.min(midnight(start), midnight(end));
  const hi = Math.max(midnight(start), midnight(end));
  return entries.filter((entry) => {
    const parsed = Date.parse(entry.created_at);
    if (!Number.isFinite(parsed)) return false;
    const when = new Date(parsed);
    const day = new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
    return day >= lo && day <= hi;
  });
}

export function relativeTime(
  locale: string,
  iso: string,
  now: number = Date.now(),
  // A pre-built formatter the caller can hand in. Constructing an
  // `Intl.RelativeTimeFormat` is dear, and a virtualized feed re-runs this per
  // row as it recycles — so a screen builds one per locale and passes it, the
  // same hoist the expense feed's date formatter uses. Omitted, it builds one.
  formatter?: Intl.RelativeTimeFormat,
): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const seconds = Math.round((parsed - now) / 1000);
  const abs = Math.abs(seconds);

  const RTF = Intl.RelativeTimeFormat as typeof Intl.RelativeTimeFormat | undefined;
  const rtf =
    formatter ?? (typeof RTF === 'function' ? new RTF(locale, { numeric: 'auto' }) : undefined);
  if (rtf) {
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

/**
 * The per-row stamp in the day-grouped activity feed.
 *
 * The feed is cut into day sections with a date heading over each ("Today",
 * "Yesterday", "Thursday", "28 August"), so the row already knows its day. A
 * relative "yesterday" or "3 days ago" on the row just says the heading again —
 * and a full "Aug 28, 8:12 PM" repeats it with the clock bolted on. So the split
 * is by age, not by what the device can format:
 *
 *  - under a day old → a relative "4 hours ago" / "20 minutes ago": the row's
 *    own freshness, which the heading does not carry;
 *  - a day or more old → the clock time alone ("8:16 PM"): the heading above
 *    already places the day, so the row never repeats it as "yesterday" or a
 *    weekday or a date.
 *
 * The relative half needs `Intl.RelativeTimeFormat` (backfilled by the Intl
 * polyfill on Hermes); without it, everything falls to the clock time, which is
 * still never the redundant date. `relativeTime`, used by screens that are not
 * day-grouped and do want the day word, is left as it is.
 *
 * `formatter`/`now` mirror `relativeTime` so a virtualized feed can hoist one
 * formatter per locale and stay testable without a live clock.
 */
const ONE_DAY_SECONDS = 86_400;

export function activityTimestamp(
  locale: string,
  iso: string,
  now: number = Date.now(),
  formatter?: Intl.RelativeTimeFormat,
): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;

  const RTF = Intl.RelativeTimeFormat as typeof Intl.RelativeTimeFormat | undefined;
  const canRelative = Boolean(formatter) || typeof RTF === 'function';
  const abs = Math.abs(Math.round((parsed - now) / 1000));
  // Under a day, and only if we can word it relatively: the freshness stamp.
  if (canRelative && abs < ONE_DAY_SECONDS) return relativeTime(locale, iso, now, formatter);

  // A day or more old, or no relative formatter: the clock time only. The day
  // sits in the section heading above, so the row must not repeat it.
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(parsed),
  );
}
