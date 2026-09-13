/**
 * Who Waves already has, read off the mirror.
 *
 * The picker used to offer every contact identically, so adding six people to a
 * trip and then adding a seventh next week meant re-reading the same list with
 * no memory of the six. This is that memory, and it is built entirely out of
 * rows the device already holds: the ghost members in your own groups, each of
 * which carries the one email or number you gave when you invited them.
 *
 * It is deliberately *not* a contact-book upload wearing a different hat. The
 * index is assembled on the phone from the local mirror (ADR-005), matched on
 * the phone by `lib/contactMatch`, and never sent anywhere; the address book is
 * read to find the match and is not stored. Nothing here can say which of your
 * contacts use Waves — only which of them you have already written down
 * yourself, which is a question your own device can answer without telling a
 * server about anybody (ADR-006).
 *
 * Members who joined with a real account carry no address here, because a
 * profile deliberately does not expose an email or a number another member
 * could read. They are matched by name instead, which is why that rule exists
 * at all and why it is confined to rows that have nothing better.
 */

import { useMemo } from 'react';

import { materialiseGroups, materialiseMembers } from '@waves/core';

import { useSync } from '@/sync';
import { useAuth } from '@/lib/auth';
import { buildKnownIndex, type KnownGroupInput, type KnownIndex } from '@/lib/contactMatch';
import { displayName, groupLabel, type GroupRow, type MemberRow } from '@/data/types';
import { isViewer } from './types';

/** Everything the contacts screen needs to know about who it already has. */
export interface KnownContacts {
  /** Matched against an address-book entry to name where somebody already is. */
  readonly index: KnownIndex;
  /** The live membership of each of your groups, for the "which group?" step. */
  readonly membersByGroup: ReadonlyMap<string, readonly MemberRow[]>;
}

/**
 * A mirror read rather than a query, so the picker knows who it already has
 * with no signal — the same rule the rest of the app reads by (ADR-005), and
 * the case that matters most here is a trip abroad with the data off.
 *
 * The index and the per-group membership come out of one pass because the
 * second is what builds the first, and materialising every group's members
 * twice to answer two halves of the same question would be work for nothing.
 */
export function useKnownContacts(): KnownContacts {
  const { mirror, queue } = useSync();
  const { profile } = useAuth();
  const profileId = profile?.id ?? null;

  return useMemo(() => {
    const groups = materialiseGroups(mirror, queue) as unknown as GroupRow[];
    const membersByGroup = new Map<string, readonly MemberRow[]>();
    const inputs: KnownGroupInput[] = [];

    for (const group of groups) {
      const members = materialiseMembers(mirror, queue, {
        groupId: group.id,
      }) as unknown as MemberRow[];
      membersByGroup.set(group.id, members);
      inputs.push({
        id: group.id,
        label: groupLabel(group, members, profileId),
        members: members
          // You are not somebody you can add to a group, so leaving yourself out
          // keeps your own contact card from claiming to be already added.
          .filter((member) => !isViewer(member, profileId))
          .map((member) => ({
            name: displayName(member, profileId),
            email: member.invite_email ?? null,
            phone: member.invite_phone ?? null,
          })),
      });
    }

    return { index: buildKnownIndex(inputs), membersByGroup };
  }, [mirror, queue, profileId]);
}
