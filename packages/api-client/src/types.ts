/**
 * The rows web-lite reads, and nothing more.
 *
 * These are deliberately not the app's types. The app reads a full mirror; a
 * guest on a link reads one group and needs a fraction of it, and asking for
 * columns nobody renders is asking RLS to prove more than it has to.
 */

import type { SplitParams } from '@baaki/core';

export type MemberId = string;

export interface Group {
  id: string;
  name: string | null;
  cover_emoji: string | null;
  default_currency: string;
  simplify_debts: boolean;
}

export interface Member {
  id: MemberId;
  group_id: string;
  profile_id: string | null;
  ghost_name: string | null;
  left_at: string | null;
  profile: { display_name: string | null } | null;
}

export interface ExpenseVersion {
  id: string;
  version_no: number;
  description: string;
  category: string | null;
  expense_date: string;
  currency: string;
  /** Minor units as a decimal string — the wire never carries a JS number for money. */
  amount: string;
  split_type: string;
  split_params: SplitParams;
  payers: { member_id: MemberId; amount: string }[];
  shares: { member_id: MemberId; amount: string }[];
}

export interface Expense {
  id: string;
  group_id: string;
  deleted_at: string | null;
  created_at: string;
  currentVersion: ExpenseVersion | null;
}

export interface Settlement {
  id: string;
  group_id: string;
  from_member_id: MemberId;
  to_member_id: MemberId;
  currency: string;
  amount: string;
  status: string;
  initiated_at: string;
  confirmed_at: string | null;
  allocations?: { expense_id: string; amount: string }[];
}

/** What a link shows before anybody has committed to joining. */
export interface InvitePreview {
  group: {
    id: string;
    name: string;
    cover_emoji: string | null;
    default_currency: string;
  } | null;
  memberCount: number;
  /** Ghost members on the group whose place the arrival can take (ADR-006). */
  claimable: { memberId: string; name: string | null }[];
}

/**
 * What came back from joining.
 *
 * Two shapes, because claiming somebody's place is now a request rather than a
 * join (ADR-006): an admin of the group decides, and until they do the arrival
 * is not a member and there is no `memberId` to give them.
 */
export interface AcceptedInvite {
  group: { id: string; name: string };
  memberId?: MemberId;
  claimed?: boolean;
  /** Waiting on an admin. `memberId` is absent. */
  pending?: boolean;
  claimId?: string;
  /** They had already asked; this is the same request, not a second one. */
  alreadyPending?: boolean;
}

/** The name web-lite shows for somebody. */
export function nameOf(member: Member): string {
  return member.profile?.display_name ?? member.ghost_name ?? 'Someone';
}
