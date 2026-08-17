import { describe, expect, it } from 'vitest';

import {
  aggregatePeopleBalances,
  countOthersInGroup,
  type PersonContribution,
} from '@/data/peopleBalances';

function contribution(over: Partial<PersonContribution> = {}): PersonContribution {
  return {
    groupId: over.groupId ?? 'g1',
    memberId: over.memberId ?? 'm1',
    profileId: over.profileId ?? null,
    displayName: over.displayName ?? 'Ravi',
    avatarUrl: over.avatarUrl ?? null,
    isGhost: over.isGhost ?? true,
    currency: over.currency ?? 'INR',
    net: over.net ?? 0n,
    lastActivityAt: over.lastActivityAt ?? null,
    mergePersonId: over.mergePersonId ?? null,
  };
}

describe('aggregatePeopleBalances', () => {
  it('keeps the sign: positive = they owe you, negative = you owe', () => {
    const rows = aggregatePeopleBalances([
      contribution({ memberId: 'a', net: 500n }),
      contribution({ memberId: 'b', net: -300n }),
    ]);
    expect(rows.find((r) => r.member_id === 'a')?.net).toBe('500');
    expect(rows.find((r) => r.member_id === 'b')?.net).toBe('-300');
  });

  it('sums one real person across groups into a single row', () => {
    const rows = aggregatePeopleBalances([
      contribution({ groupId: 'g1', memberId: 'm1', profileId: 'p1', net: 200n }),
      contribution({ groupId: 'g2', memberId: 'm2', profileId: 'p1', net: 300n }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.person_key).toBe('p1');
    expect(rows[0]?.net).toBe('500');
    expect(rows[0]?.group_count).toBe(2);
    expect(rows[0]?.only_group_id).toBeNull();
  });

  it('drops anyone who nets to zero across their groups', () => {
    const rows = aggregatePeopleBalances([
      contribution({ groupId: 'g1', profileId: 'p1', net: 400n }),
      contribution({ groupId: 'g2', profileId: 'p1', net: -400n }),
    ]);
    expect(rows).toEqual([]);
  });

  it('folds two ghosts under one recorded merge', () => {
    const rows = aggregatePeopleBalances([
      contribution({ groupId: 'g1', memberId: 'm1', mergePersonId: 'person1', net: 100n }),
      contribution({ groupId: 'g2', memberId: 'm2', mergePersonId: 'person1', net: 150n }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.person_key).toBe('person1');
    expect(rows[0]?.net).toBe('250');
    expect(rows[0]?.is_ghost).toBe(true);
    expect(rows[0]?.group_count).toBe(2);
  });

  it('never folds two unmerged ghosts by name alone', () => {
    const rows = aggregatePeopleBalances([
      contribution({ groupId: 'g1', memberId: 'm1', displayName: 'person1', net: 100n }),
      contribution({ groupId: 'g2', memberId: 'm2', displayName: 'person1', net: 150n }),
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.person_key))).toEqual(new Set(['m1', 'm2']));
  });

  it('is a ghost only when every contribution is (bool_and)', () => {
    // A merge that includes one real-profile row is not a ghost overall.
    const rows = aggregatePeopleBalances([
      contribution({ memberId: 'm1', mergePersonId: 'person1', isGhost: true, net: 10n }),
      contribution({
        groupId: 'g2',
        memberId: 'm2',
        mergePersonId: 'person1',
        isGhost: false,
        profileId: null,
        net: 20n,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_ghost).toBe(false);
  });

  it('keeps currencies as separate rows', () => {
    const rows = aggregatePeopleBalances([
      contribution({ profileId: 'p1', currency: 'INR', net: 100n }),
      contribution({ profileId: 'p1', currency: 'EUR', net: 200n }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.currency === 'INR')?.net).toBe('100');
    expect(rows.find((r) => r.currency === 'EUR')?.net).toBe('200');
  });

  it('sets only_group_id when the person is in exactly one group', () => {
    const rows = aggregatePeopleBalances([
      contribution({ groupId: 'g9', profileId: 'p1', net: 100n }),
    ]);
    expect(rows[0]?.only_group_id).toBe('g9');
    expect(rows[0]?.group_count).toBe(1);
  });

  it('orders by the size of the balance, then name', () => {
    const rows = aggregatePeopleBalances([
      contribution({ memberId: 'small', displayName: 'B', net: 100n }),
      contribution({ memberId: 'big', displayName: 'A', net: -900n }),
      contribution({ memberId: 'mid', displayName: 'C', net: 400n }),
    ]);
    expect(rows.map((r) => r.member_id)).toEqual(['big', 'mid', 'small']);
  });

  it('carries the newest activity and picks a stable representative', () => {
    const rows = aggregatePeopleBalances([
      contribution({
        groupId: 'g1',
        memberId: 'm1',
        profileId: 'p1',
        displayName: 'Ravi',
        lastActivityAt: '2026-01-01T00:00:00Z',
        net: 100n,
      }),
      contribution({
        groupId: 'g2',
        memberId: 'm2',
        profileId: 'p1',
        displayName: 'Ravi',
        lastActivityAt: '2026-03-01T00:00:00Z',
        net: 50n,
      }),
    ]);
    expect(rows[0]?.last_activity_at).toBe('2026-03-01T00:00:00Z');
    expect(rows[0]?.profile_id).toBe('p1');
  });

  it('is empty for no contributions', () => {
    expect(aggregatePeopleBalances([])).toEqual([]);
  });
});

describe('countOthersInGroup', () => {
  const me = { profile_id: 'me', left_at: null };

  it('counts everybody in the group but you', () => {
    expect(countOthersInGroup([me, { profile_id: 'p1', left_at: null }], 'me')).toBe(1);
  });

  it('counts a ghost, who has no profile of their own', () => {
    expect(countOthersInGroup([me, { profile_id: null, left_at: null }], 'me')).toBe(1);
  });

  it('does not count somebody who has left', () => {
    expect(
      countOthersInGroup([me, { profile_id: 'p1', left_at: '2026-01-01T00:00:00Z' }], 'me'),
    ).toBe(0);
  });

  it('counts nobody in a group you are not in', () => {
    expect(countOthersInGroup([{ profile_id: 'p1', left_at: null }], 'me')).toBe(0);
  });

  it('counts nobody in a group you have left, however full it is', () => {
    expect(
      countOthersInGroup(
        [
          { profile_id: 'me', left_at: '2026-01-01T00:00:00Z' },
          { profile_id: 'p1', left_at: null },
          { profile_id: 'p2', left_at: null },
        ],
        'me',
      ),
    ).toBe(0);
  });

  it('counts nobody when you are the only member', () => {
    expect(countOthersInGroup([me], 'me')).toBe(0);
  });
});
