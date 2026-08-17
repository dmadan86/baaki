/**
 * Who owes you and who you owe, across every group — computed on the device.
 *
 * The local-first twin of the `baaki_people_i_owe` RPC (A11/A36/A38). The RPC
 * takes the pairwise balance between you and each other member in every group
 * you share (`pairwise_balances`), folds the rows that are really one person,
 * and sums per currency. This does the same from the mirror: the caller feeds
 * one {@link PersonContribution} per (group, other member, currency) — the
 * pairwise edge that touches you — computed with the same `@baaki/core`
 * function the group ledger uses, and this aggregates them.
 *
 * The identity rule matches the SQL exactly: a profile id is proof of one
 * human; failing that, a ghost merge the viewer recorded stands in; failing
 * both, a ghost stays keyed to its own group member and never folds by name
 * (the rule A11 set and A38 only bends for an explicit merge).
 */

import type { PersonBalanceRow } from './api';

export interface PersonContribution {
  groupId: string;
  /** The other member's group_member id (per-group). */
  memberId: string;
  /** Their profile id, or null for a ghost. */
  profileId: string | null;
  displayName: string;
  avatarUrl: string | null;
  isGhost: boolean;
  currency: string;
  /** This group's pairwise net: positive = they owe you, negative = you owe. */
  net: bigint;
  /** Newest activity touching them, or null. */
  lastActivityAt: string | null;
  /** The person id of a viewer-recorded ghost merge (A38), else null. */
  mergePersonId: string | null;
}

/** The little of a member row this file needs to count people. */
export interface CountableMember {
  profile_id: string | null;
  left_at: string | null;
}

/**
 * How many other people are in this group with you — nought if you are not in
 * it yourself.
 *
 * This is the question `aggregatePeopleBalances` cannot answer, because it drops
 * anybody square with you: an empty result means either "no friends" or "no
 * debts", and Friends has to tell those apart to know what to say. Somebody who
 * has left is not somebody you are settling up with, and neither are you.
 */
export function countOthersInGroup(members: readonly CountableMember[], profileId: string): number {
  const present = members.filter((member) => member.left_at === null);
  if (!present.some((member) => member.profile_id === profileId)) return 0;
  return present.filter((member) => member.profile_id !== profileId).length;
}

/** COALESCE(profile_id, merge person_id, member_id) — the SQL's person_key. */
function personKey(contribution: PersonContribution): string {
  return contribution.profileId ?? contribution.mergePersonId ?? contribution.memberId;
}

/** Lexicographic max, ignoring null — mirrors the SQL `max(...)`. */
function maxOrNull(current: string | null, next: string | null): string | null {
  if (next === null) return current;
  if (current === null) return next;
  return next > current ? next : current;
}

interface Group {
  person_key: string;
  currency: string;
  profile_id: string | null;
  member_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** bool_and: a person is a ghost only if every row of them is. */
  is_ghost: boolean;
  net: bigint;
  groupIds: Set<string>;
  last_activity_at: string | null;
}

/**
 * Fold per-group contributions into one row per person and currency, exactly as
 * `baaki_people_i_owe` returns them: summed net (a person square in a currency
 * is dropped), a group count with the single group id when there is only one,
 * and the newest activity. Ordered by the size of the balance, then name.
 */
export function aggregatePeopleBalances(
  contributions: readonly PersonContribution[],
): PersonBalanceRow[] {
  const groups = new Map<string, Group>();

  for (const c of contributions) {
    const key = personKey(c);
    const mapKey = `${key}|${c.currency}`;
    let group = groups.get(mapKey);
    if (!group) {
      group = {
        person_key: key,
        currency: c.currency,
        profile_id: null,
        member_id: null,
        display_name: null,
        avatar_url: null,
        is_ghost: true,
        net: 0n,
        groupIds: new Set(),
        last_activity_at: null,
      };
      groups.set(mapKey, group);
    }
    group.net += c.net;
    group.groupIds.add(c.groupId);
    group.profile_id = maxOrNull(group.profile_id, c.profileId);
    group.member_id = maxOrNull(group.member_id, c.memberId);
    group.display_name = maxOrNull(group.display_name, c.displayName);
    group.avatar_url = maxOrNull(group.avatar_url, c.avatarUrl);
    group.is_ghost = group.is_ghost && c.isGhost;
    group.last_activity_at = maxOrNull(group.last_activity_at, c.lastActivityAt);
  }

  const rows: PersonBalanceRow[] = [];
  for (const group of groups.values()) {
    // A person square in this currency is not a debt (SQL: HAVING sum <> 0).
    if (group.net === 0n) continue;
    rows.push({
      person_key: group.person_key,
      profile_id: group.profile_id,
      member_id: group.member_id ?? group.person_key,
      display_name: group.display_name ?? 'Someone',
      avatar_url: group.avatar_url,
      is_ghost: group.is_ghost,
      currency: group.currency,
      net: group.net.toString(),
      group_count: group.groupIds.size,
      only_group_id: group.groupIds.size === 1 ? [...group.groupIds][0]! : null,
      last_activity_at: group.last_activity_at,
    });
  }

  // abs(net) descending, then display name — the SQL's ORDER BY.
  rows.sort((a, b) => {
    const byAmount = absBig(BigInt(b.net)) - absBig(BigInt(a.net));
    if (byAmount !== 0n) return byAmount > 0n ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });
  return rows;
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}
