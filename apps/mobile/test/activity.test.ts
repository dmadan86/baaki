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

import { describeActivity, verbEmoji } from '@/data/activity';
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

describe('the icon', () => {
  it('gives an edit and its conflict the same mark', () => {
    // A superseded row IS an edit; two icons for one thing reads as two events.
    expect(verbEmoji('superseded')).toBe(verbEmoji('edited'));
  });

  it('has something for a verb it has never seen', () => {
    expect(verbEmoji('archived')).toBe('•');
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
