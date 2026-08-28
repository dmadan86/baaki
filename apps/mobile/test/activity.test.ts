/**
 * The wording of the activity feed.
 *
 * This exists because the feed drifted once already: two screens each carried
 * their own copy of this logic, one was fixed and the other was not, and the
 * group tab went on rendering "Ravi superseded expense_version" — a table name
 * shown to somebody whose edit had just been thrown away. There is now one
 * function, and these tests are what keeps it one.
 *
 * The cases worth pinning are the ones where a plausible-looking line tells
 * the reader something untrue or useless: an unattributed action, somebody
 * else's name on your own action, and the sync-conflict entry.
 */

import { describe, expect, it } from 'vitest';

import {
  activityDateSpan,
  activityHeadline,
  activityTarget,
  activityTimestamp,
  dayHeading,
  dayKey,
  describeActivity,
  filterByDayRange,
  relativeTime,
  verbIcon,
} from '@/data/activity';
import type { ActivityActor, ActivityRow } from '@/data/types';

const RAVI: ActivityActor = {
  id: 'member-ravi',
  profile_id: 'profile-ravi',
  ghost_name: null,
  profile: { display_name: 'Ravi' },
};

const ME: ActivityActor = {
  id: 'member-asha',
  profile_id: 'profile-asha',
  ghost_name: null,
  profile: { display_name: 'Asha' },
};

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'activity-1',
    group_id: 'group-1',
    actor_member_id: RAVI.id,
    actor: RAVI,
    verb: 'added',
    object_type: 'expense',
    object_id: 'expense-1',
    payload: {},
    created_at: '2026-08-06T10:00:00.000Z',
    ...over,
  };
}

describe('who did it', () => {
  it('names the person', () => {
    expect(describeActivity(row({ payload: { description: 'Dinner' } }), 'profile-asha')).toBe(
      'Ravi added Dinner',
    );
  });

  it('says "You" for the reader, not their own name', () => {
    expect(
      describeActivity(row({ actor: ME, payload: { description: 'Dinner' } }), 'profile-asha'),
    ).toBe('You added Dinner');
  });

  it('says "You" only to the person who did it', () => {
    expect(
      describeActivity(row({ actor: ME, payload: { description: 'Dinner' } }), 'profile-ravi'),
    ).toBe('Asha added Dinner');
  });

  it('falls back to a ghost name for somebody without an account', () => {
    const ghost: ActivityActor = {
      id: 'member-ghost',
      profile_id: null,
      ghost_name: 'Priya',
      profile: null,
    };
    expect(describeActivity(row({ actor: ghost }), 'profile-asha')).toBe('Priya added an expense');
  });

  it('still says something when the actor cannot be read', () => {
    // A row whose actor is gone is still an event that happened; dropping it
    // would leave a hole in a ledger's history.
    expect(describeActivity(row({ actor: null, actor_member_id: null }), 'profile-asha')).toBe(
      'Someone added an expense',
    );
  });

  it('does not claim an anonymous row is the reader', () => {
    expect(describeActivity(row({ actor: null }), null)).toBe('Someone added an expense');
  });
});

describe('what happened', () => {
  it.each([
    ['added', 'Ravi added Dinner'],
    ['edited', 'Ravi edited Dinner'],
    ['deleted', 'Ravi deleted Dinner'],
    ['restored', 'Ravi restored Dinner'],
  ])('%s', (verb, expected) => {
    expect(describeActivity(row({ verb, payload: { description: 'Dinner' } }), 'me')).toBe(
      expected,
    );
  });

  it('falls back when the payload carries no description', () => {
    expect(describeActivity(row({ verb: 'edited' }), 'me')).toBe('Ravi edited an expense');
  });

  it('explains a sync conflict instead of naming a table', () => {
    // ADR-005: both edits survive in expense_versions. This line is how the
    // person whose edit lost finds out it is recoverable.
    const line = describeActivity(
      row({ verb: 'superseded', object_type: 'expense_version', payload: {} }),
      'me',
    );
    expect(line).toBe("Ravi's edit replaced an earlier one");
    expect(line).not.toContain('expense_version');
  });

  it('names the edit that was replaced when the payload has it', () => {
    expect(
      describeActivity(
        row({ verb: 'superseded', payload: { supersededDescription: 'Dinner' } }),
        'me',
      ),
    ).toBe('Ravi\'s edit replaced an earlier one — "Dinner" is still in the history');
  });

  it.each([
    ['settled', 'Ravi recorded a settlement'],
    ['confirmed', 'Ravi confirmed a settlement'],
    ['joined', 'Ravi joined'],
    ['created', 'Ravi created the group'],
  ])('%s', (verb, expected) => {
    expect(describeActivity(row({ verb }), 'me')).toBe(expected);
  });

  it('names the group when the create payload carries one', () => {
    expect(describeActivity(row({ verb: 'created', payload: { name: 'Goa Trip' } }), 'me')).toBe(
      'Ravi created Goa Trip',
    );
  });

  it('shows a verb it does not know rather than nothing', () => {
    // Written by a newer build than this one — an offline queue can replay
    // months late (ADR-005), so this is reachable in a released app.
    expect(describeActivity(row({ verb: 'archived', object_type: 'group' }), 'me')).toBe(
      'Ravi archived group',
    );
  });

  it('ignores a description that is not a string', () => {
    expect(describeActivity(row({ payload: { description: 42 } }), 'me')).toBe(
      'Ravi added an expense',
    );
  });
});

/**
 * The row's visible title.
 *
 * `describeActivity` writes the spoken sentence; this is the line a sighted
 * reader skims. It must lead with the event, never the actor — the actor lives
 * on the metadata line — so a column of rows is scannable by "what happened"
 * rather than by whose name comes first.
 */
describe('activityHeadline', () => {
  it('leads with the event, not the actor', () => {
    expect(activityHeadline(row({ payload: { description: 'Dinner' } }))).toBe('Added Dinner');
    // The actor's name never appears in the title, whoever it is.
    expect(activityHeadline(row({ payload: { description: 'Dinner' } }))).not.toContain('Ravi');
  });

  it.each([
    ['added', 'Added Dinner'],
    ['edited', 'Edited Dinner'],
    ['deleted', 'Deleted Dinner'],
    ['restored', 'Restored Dinner'],
    ['disputed', 'Flagged Dinner'],
  ])('%s leads with the verb, then the description', (verb, expected) => {
    expect(activityHeadline(row({ verb, payload: { description: 'Dinner' } }))).toBe(expected);
  });

  it('does not dangle the verb off a sentence-like imported description', () => {
    // The real case from a Splitwise import: the description is itself a clause.
    expect(activityHeadline(row({ payload: { description: 'Hethu paid Madan D.' } }))).toBe(
      'Added Hethu paid Madan D.',
    );
  });

  it('falls back to a lower-case noun when the payload names nothing', () => {
    expect(activityHeadline(row({ verb: 'edited' }))).toBe('Edited expense');
  });

  it.each([
    ['settled', 'Settlement recorded'],
    ['confirmed', 'Settlement confirmed'],
    ['auto_confirmed', 'Settlement auto-confirmed'],
    ['joined', 'Joined the group'],
    ['created', 'Group created'],
  ])('words the non-expense event %s', (verb, expected) => {
    expect(activityHeadline(row({ verb }))).toBe(expected);
  });

  it('names the group in the title when a create carries one', () => {
    expect(activityHeadline(row({ verb: 'created', payload: { name: 'Goa Trip' } }))).toBe(
      'Created Goa Trip',
    );
  });

  it('shows an unknown verb rather than dropping the row', () => {
    expect(activityHeadline(row({ verb: 'archived', object_type: 'group' }))).toBe(
      'archived group',
    );
  });
});

/**
 * Where a tapped row opens.
 *
 * A feed row is a doorway to the thing that happened, not just to the group it
 * happened in: an expense event opens the expense, a join opens the member. A
 * type with no detail screen (a settlement, a group event) or a row missing its
 * id falls back to the group — never a broken link.
 */
describe('activityTarget', () => {
  it('opens the expense for an expense event', () => {
    expect(activityTarget(row({ object_type: 'expense', object_id: 'expense-1' }))).toBe(
      '/group/group-1/expense/expense-1',
    );
  });

  it('opens the member for a join', () => {
    expect(
      activityTarget(row({ verb: 'joined', object_type: 'member', object_id: 'member-9' })),
    ).toBe('/group/group-1/member/member-9');
  });

  it('opens the group for a settlement — it has no detail screen', () => {
    expect(
      activityTarget(row({ verb: 'settled', object_type: 'settlement', object_id: 'settle-1' })),
    ).toBe('/group/group-1');
  });

  it('opens the group for a group-level event', () => {
    expect(
      activityTarget(row({ verb: 'created', object_type: 'group', object_id: 'group-1' })),
    ).toBe('/group/group-1');
  });

  it('falls back to the members list for a member row with no id', () => {
    expect(activityTarget(row({ object_type: 'member', object_id: null }))).toBe(
      '/group/group-1/members',
    );
  });

  it('falls back to the group when the object id is missing', () => {
    expect(activityTarget(row({ object_type: 'expense', object_id: null }))).toBe('/group/group-1');
  });
});

describe('the icon', () => {
  it('gives an edit and its conflict the same mark', () => {
    // A superseded row IS an edit; two icons for one thing reads as two events.
    expect(verbIcon('superseded')).toBe(verbIcon('edited'));
  });

  it('has something for a verb it has never seen', () => {
    expect(verbIcon('archived')).toBe('ellipse-outline');
  });
});

/**
 * Disagreeing with an expense.
 *
 * The wording carries the design: a decline is somebody's position, not a
 * change to the ledger. The feed has to read as a conversation rather than as
 * an accounting event, because that is what it is — and it must not imply the
 * numbers moved, since they did not.
 */
describe('somebody says an expense is wrong', () => {
  it('quotes the reason, which is the whole point of the entry', () => {
    expect(
      describeActivity(
        row({ verb: 'disputed', payload: { description: 'Dinner', reason: 'I left early' } }),
        null,
      ),
    ).toBe('Ravi says Dinner is not right — "I left early"');
  });

  it('still says something useful with no reason given', () => {
    expect(
      describeActivity(row({ verb: 'disputed', payload: { description: 'Dinner' } }), null),
    ).toBe('Ravi says Dinner is not right');
  });

  it('reads as agreement rather than defeat when it is accepted', () => {
    expect(
      describeActivity(row({ verb: 'accepted_dispute', payload: { description: 'Dinner' } }), null),
    ).toBe('Ravi agreed Dinner needs fixing');
  });

  it('reads as a position rather than a verdict when it is not', () => {
    expect(
      describeActivity(row({ verb: 'rejected_dispute', payload: { description: 'Dinner' } }), null),
    ).toBe('Ravi says Dinner is correct as it stands');
  });

  it('names nobody for a settlement that confirmed itself', () => {
    // "Someone confirmed" would be a lie about a thing that happened because a
    // week passed and nobody said anything.
    const line = describeActivity(row({ verb: 'auto_confirmed', payload: {} }), null);
    expect(line).not.toContain('Ravi');
    expect(line).toContain('automatically');
  });
});

describe('how long ago', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  const ago = (seconds: number): string =>
    relativeTime('en', new Date(now - seconds * 1000).toISOString(), now);

  it('words a recent event in minutes, not seconds', () => {
    // 19 minutes reads in minutes; the largest unit with a count of at least one.
    expect(ago(19 * 60)).toBe('19 minutes ago');
  });

  it('turns a day into "yesterday" (numeric: auto)', () => {
    expect(ago(24 * 3600)).toBe('yesterday');
  });

  it('never throws when Intl.RelativeTimeFormat is missing (Android Hermes)', () => {
    // The exact crash that took the Activity screen down: `new
    // Intl.RelativeTimeFormat` is a constructor on `undefined` there. The
    // fallback must produce a string, not blow up.
    const mutable = Intl as unknown as { RelativeTimeFormat?: typeof Intl.RelativeTimeFormat };
    const original = mutable.RelativeTimeFormat;
    try {
      delete mutable.RelativeTimeFormat;
      const stamp = relativeTime('en', new Date(now - 19 * 60 * 1000).toISOString(), now);
      expect(typeof stamp).toBe('string');
      expect(stamp.length).toBeGreaterThan(0);
      expect(stamp).not.toContain('undefined');
    } finally {
      mutable.RelativeTimeFormat = original;
    }
  });
});

/**
 * The stamp on a day-grouped feed row.
 *
 * The feed is cut into day sections with a date heading, so the row must not
 * repeat the day. Under a day old it reads relatively ("4 hours ago"); a day or
 * more old it drops to the clock time, never "yesterday" / a weekday / a date —
 * that day word is the heading's job, and doubling it is exactly the noise this
 * function exists to remove.
 */
describe('activityTimestamp', () => {
  const now = Date.parse('2026-08-15T12:00:00Z');
  const at = (seconds: number): string =>
    activityTimestamp('en', new Date(now - seconds * 1000).toISOString(), now);

  it('reads relatively while under a day old', () => {
    expect(at(4 * 3600)).toBe('4 hours ago');
    expect(at(19 * 60)).toBe('19 minutes ago');
  });

  it('drops to the clock time once a day or more old — never "yesterday"', () => {
    // A day heading sits above this row; repeating the day in it is the noise.
    const stamp = at(24 * 3600);
    expect(stamp).not.toContain('yesterday');
    // A wall-clock time, not a date: no month name, no day word.
    expect(stamp).not.toMatch(/aug|august|day/i);
    expect(stamp).toMatch(/\d{1,2}:\d{2}/);
  });

  it('shows the clock time for an event several days back, not a weekday', () => {
    const stamp = at(3 * 24 * 3600);
    expect(stamp).toMatch(/\d{1,2}:\d{2}/);
    expect(stamp).not.toMatch(/day|aug/i);
  });

  it('falls back to the clock time, never the date, when RelativeTimeFormat is missing', () => {
    const mutable = Intl as unknown as { RelativeTimeFormat?: typeof Intl.RelativeTimeFormat };
    const original = mutable.RelativeTimeFormat;
    try {
      delete mutable.RelativeTimeFormat;
      // Even a fresh event has no relative wording available now, so it too is a
      // clock time — still never the redundant date.
      const stamp = activityTimestamp('en', new Date(now - 4 * 3600 * 1000).toISOString(), now);
      expect(stamp).toMatch(/\d{1,2}:\d{2}/);
      expect(stamp).not.toMatch(/aug|ago/i);
      expect(stamp).not.toContain('undefined');
    } finally {
      mutable.RelativeTimeFormat = original;
    }
  });
});

/**
 * The day headings over the feed.
 *
 * The heading is what makes a long feed skimmable, so the two cases that must
 * not drift are the boundary ones: something logged just before midnight is
 * "Yesterday" ten minutes later, not "an hour ago" filed under today, and a
 * missing `Intl.RelativeTimeFormat` on Hermes degrades the wording rather than
 * taking the screen down.
 */
describe('dayHeading', () => {
  const now = Date.parse('2026-08-15T12:00:00');

  it('names today and yesterday, capitalized', () => {
    expect(dayHeading('en', new Date(now - 2 * 3600 * 1000).toISOString(), now)).toBe('Today');
    expect(dayHeading('en', '2026-08-14T23:50:00', now)).toBe('Yesterday');
  });

  it('counts calendar days, not elapsed hours', () => {
    // Ten minutes old, but on the other side of midnight.
    const justAfterMidnight = Date.parse('2026-08-15T00:10:00');
    expect(dayHeading('en', '2026-08-14T23:50:00', justAfterMidnight)).toBe('Yesterday');
  });

  it('uses the weekday inside the week and a date beyond it', () => {
    expect(dayHeading('en', '2026-08-11T09:00:00', now)).toBe('Tuesday');
    expect(dayHeading('en', '2026-07-04T09:00:00', now)).toContain('July');
  });

  it('does not throw when Intl.RelativeTimeFormat is missing (Android Hermes)', () => {
    const mutable = Intl as unknown as { RelativeTimeFormat?: typeof Intl.RelativeTimeFormat };
    const original = mutable.RelativeTimeFormat;
    try {
      delete mutable.RelativeTimeFormat;
      const heading = dayHeading('en', new Date(now - 3600 * 1000).toISOString(), now);
      expect(typeof heading).toBe('string');
      expect(heading).not.toContain('undefined');
    } finally {
      mutable.RelativeTimeFormat = original;
    }
  });

  it('keys entries by local calendar day', () => {
    expect(dayKey('2026-08-15T00:10:00')).toBe(dayKey('2026-08-15T23:50:00'));
    expect(dayKey('2026-08-14T23:50:00')).not.toBe(dayKey('2026-08-15T00:10:00'));
  });
});

/**
 * The date filter over the feed.
 *
 * The two properties that must hold are the picker clamp — the selectable span
 * is exactly the feed's own start and end — and the cut agreeing with the day
 * headings: a row is kept by its calendar day, so its time of day never trims
 * it, and a range picked end-first still works.
 */
describe('activityDateSpan', () => {
  const at = (iso: string) => ({ created_at: iso });

  it('returns the earliest and latest calendar day in the feed', () => {
    const span = activityDateSpan([
      at('2026-08-10T09:00:00'),
      at('2026-08-06T23:00:00'),
      at('2026-08-14T01:00:00'),
    ]);
    expect(span).not.toBeNull();
    // Anchored at local noon on the first and last day present.
    expect(span?.earliest.getFullYear()).toBe(2026);
    expect(span?.earliest.getMonth()).toBe(7); // August (0-based)
    expect(span?.earliest.getDate()).toBe(6);
    expect(span?.earliest.getHours()).toBe(12);
    expect(span?.latest.getDate()).toBe(14);
    expect(span?.latest.getHours()).toBe(12);
  });

  it('is null for an empty feed — nothing to clamp', () => {
    expect(activityDateSpan([])).toBeNull();
  });

  it('skips unparseable timestamps', () => {
    const span = activityDateSpan([at('not-a-date'), at('2026-08-09T10:00:00')]);
    expect(span?.earliest.getDate()).toBe(9);
    expect(span?.latest.getDate()).toBe(9);
  });
});

describe('filterByDayRange', () => {
  const at = (id: string, iso: string) => ({ id, created_at: iso });
  const day = (iso: string) => new Date(`${iso}T12:00:00`);

  const feed = [
    at('a', '2026-08-05T08:00:00'),
    at('b', '2026-08-08T23:30:00'),
    at('c', '2026-08-10T00:10:00'),
    at('d', '2026-08-14T15:00:00'),
  ];

  it('keeps only the rows whose day is inside the range, inclusive', () => {
    const kept = filterByDayRange(feed, day('2026-08-08'), day('2026-08-10')).map((r) => r.id);
    expect(kept).toEqual(['b', 'c']);
  });

  it('treats a single day as a one-day range regardless of the time of day', () => {
    // Row c is at 00:10 — still kept when the picked day is 2026-08-10.
    const kept = filterByDayRange(feed, day('2026-08-10'), day('2026-08-10')).map((r) => r.id);
    expect(kept).toEqual(['c']);
  });

  it('orders the ends defensively — an end-first range works the same', () => {
    const forward = filterByDayRange(feed, day('2026-08-05'), day('2026-08-08')).map((r) => r.id);
    const backward = filterByDayRange(feed, day('2026-08-08'), day('2026-08-05')).map((r) => r.id);
    expect(backward).toEqual(forward);
    expect(forward).toEqual(['a', 'b']);
  });

  it('returns nothing when the range misses every row', () => {
    expect(filterByDayRange(feed, day('2026-08-11'), day('2026-08-13'))).toEqual([]);
  });
});
