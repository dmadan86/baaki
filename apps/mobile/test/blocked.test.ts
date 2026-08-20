/**
 * The block set, and the two pure questions every render site asks of it.
 *
 * Blocking is display-only: it must change the *name and face* a blocked person
 * shows under, and it must never be mistaken for the viewer themselves. These
 * check exactly that, plus the storage reducers that keep the set one-entry-per
 * -person and survive a corrupt stored value.
 */

import { describe, expect, it } from 'vitest';

import { parseBlocked, removeBlocked, upsertBlocked, type BlockedUser } from '../src/data/blocked';
import { displayName, isBlockedMember } from '../src/data/types';
import type { MemberRow } from '../src/data/types';

const user = (id: string, name = id): BlockedUser => ({ id, name, avatarUrl: null });

const member = (over: Partial<MemberRow>): MemberRow =>
  ({
    id: 'm1',
    group_id: 'g1',
    profile_id: null,
    ghost_name: null,
    role: 'member',
    vpa: null,
    left_at: null,
    ...over,
  }) as MemberRow;

describe('the block reducers', () => {
  it('adds newest first', () => {
    const list = upsertBlocked(upsertBlocked([], user('a')), user('b'));
    expect(list.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('never lists the same person twice, and refreshes their snapshot', () => {
    const list = upsertBlocked([user('a', 'Old')], user('a', 'New'));
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('New');
  });

  it('removes by id and leaves the rest', () => {
    expect(removeBlocked([user('a'), user('b')], 'a').map((entry) => entry.id)).toEqual(['b']);
  });

  it('reads back what was written', () => {
    const list = [user('a', 'Ada'), user('b', 'Bo')];
    expect(parseBlocked(JSON.stringify(list))).toEqual(list);
  });

  it('treats a missing or corrupt store as nobody blocked', () => {
    expect(parseBlocked(null)).toEqual([]);
    expect(parseBlocked('not json')).toEqual([]);
    expect(parseBlocked('{"not":"an array"}')).toEqual([]);
  });

  it('drops entries with no id and fills a missing name', () => {
    const raw = JSON.stringify([{ id: 'a' }, { name: 'no id' }, { id: 'b', name: 'Bo' }]);
    expect(parseBlocked(raw)).toEqual([
      { id: 'a', name: '', avatarUrl: null },
      { id: 'b', name: 'Bo', avatarUrl: null },
    ]);
  });
});

describe('ghosting a blocked person', () => {
  const blocked = new Set(['p-blocked']);
  const real = member({ profile_id: 'p-blocked', profile: { display_name: 'Ravi' } as never });

  it('shows a blocked person by the anonymous name, not their real one', () => {
    expect(displayName(real, 'me', blocked, 'Someone')).toBe('Someone');
    expect(isBlockedMember(real, blocked)).toBe(true);
  });

  it('shows an unblocked person normally', () => {
    const other = member({ profile_id: 'p-ok', profile: { display_name: 'Priya' } as never });
    expect(displayName(other, 'me', blocked, 'Someone')).toBe('Priya');
    expect(isBlockedMember(other, blocked)).toBe(false);
  });

  it('never blocks the viewer against themselves', () => {
    const me = member({ profile_id: 'p-blocked', profile: { display_name: 'Ravi' } as never });
    // Even though this id is in the block set, it is the viewer's own id: "You"
    // wins, so you never see yourself as a ghost.
    expect(displayName(me, 'p-blocked', blocked, 'Someone')).toBe('You');
  });

  it('leaves a plain ghost (no profile) un-blockable', () => {
    const ghost = member({ profile_id: null, ghost_name: 'Sam' });
    expect(isBlockedMember(ghost, blocked)).toBe(false);
    expect(displayName(ghost, 'me', blocked, 'Someone')).toBe('Sam');
  });
});
