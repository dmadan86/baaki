import type { MemberId, SplitParams } from '@baaki/core';

export type GroupType = 'trip' | 'home' | 'couple' | 'event' | 'other';
export type SettlementMethod = 'upi' | 'cash' | 'bank' | 'other';
export type SettlementStatus =
  'initiated' | 'confirmed' | 'auto_confirmed' | 'disputed' | 'cancelled';

export interface GroupRow {
  id: string;
  /** Optional — an unnamed group is labelled by who is in it (see groupLabel). */
  name: string | null;
  type: GroupType;
  default_currency: string;
  simplify_debts: boolean;
  cover_emoji: string | null;
  /** Object path in the private `group-photos` bucket, or null. */
  photo_path: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface MemberRow {
  id: MemberId;
  group_id: string;
  profile_id: string | null;
  ghost_name: string | null;
  role: 'admin' | 'member';
  vpa: string | null;
  left_at: string | null;
  profile?: {
    id: string;
    display_name: string;
    avatar_url: string | null;
    default_vpa: string | null;
  } | null;
}

export interface ExpenseVersionRow {
  id: string;
  version_no: number;
  description: string;
  category: string | null;
  expense_date: string;
  currency: string;
  /** BIGINT arrives as a string from PostgREST — parse, never Number(). */
  amount: string;
  split_type: SplitParams['kind'];
  split_params: SplitParams;
  author_member_id: MemberId | null;
  notes: string | null;
  created_at: string;
  payers: { member_id: MemberId; amount: string }[];
  shares: { member_id: MemberId; amount: string }[];
}

export interface ExpenseRow {
  id: string;
  group_id: string;
  deleted_at: string | null;
  created_at: string;
  currentVersion: ExpenseVersionRow | null;
  /** Set while this row exists only in the local mutation queue (ADR-005). */
  pending?: boolean;
}

export interface SettlementRow {
  id: string;
  group_id: string;
  from_member_id: MemberId;
  to_member_id: MemberId;
  currency: string;
  amount: string;
  method: SettlementMethod;
  status: SettlementStatus;
  note: string | null;
  initiated_at: string;
  confirmed_at: string | null;
  allocations?: { expense_id: string; amount: string }[];
}

/** Who did the thing. Null when the actor has since left the group. */
export interface ActivityActor {
  id: MemberId;
  profile_id: string | null;
  ghost_name: string | null;
  profile: { display_name: string | null } | null;
}

export interface ActivityGroup {
  id: string;
  name: string | null;
  cover_emoji: string | null;
}

export interface ActivityRow {
  id: string;
  group_id: string;
  actor_member_id: MemberId | null;
  actor?: ActivityActor | null;
  verb: string;
  object_type: string;
  object_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * "Ravi", or "You" when it was this person — an activity feed that cannot say
 * who changed an expense is not answering the question it exists for.
 *
 * Matched on profile id rather than member id: the cross-group feed spans
 * groups, and the same person holds a different member id in each one.
 */
export function actorName(
  actor: ActivityActor | null | undefined,
  myProfileId: string | null,
): string {
  if (!actor) return 'Someone';
  if (myProfileId && actor.profile_id === myProfileId) return 'You';
  return actor.profile?.display_name ?? actor.ghost_name ?? 'Someone';
}

export interface BalanceRow {
  group_id: string;
  member_id: MemberId;
  currency: string;
  balance: string;
}

/** Display name for a member, real or ghost. */
export function displayName(member: MemberRow, myProfileId?: string | null): string {
  if (member.profile_id && member.profile_id === myProfileId) return 'You';
  return member.profile?.display_name ?? member.ghost_name ?? 'Someone';
}

/**
 * What to call a group that has no name.
 *
 * The people are the group, so they are the label: "You, Priya and Ravi". It
 * beats "Untitled group" for the same reason a photo of your friends beats a
 * filename — you recognise it without reading it.
 */
export function groupLabel(
  group: Pick<GroupRow, 'name'> | null | undefined,
  members: readonly MemberRow[] = [],
  myProfileId?: string | null,
): string {
  const named = group?.name?.trim();
  if (named) return named;

  const others = members
    .filter((member) => !member.left_at)
    .filter((member) => !(member.profile_id && member.profile_id === myProfileId))
    .map((member) => displayName(member, myProfileId));

  if (others.length === 0) return 'New group';
  if (others.length === 1) return `You and ${others[0]}`;
  if (others.length === 2) return `You, ${others[0]} and ${others[1]}`;
  return `You, ${others[0]} and ${others.length - 1} others`;
}

export function isGhost(member: MemberRow): boolean {
  return member.profile_id === null;
}

export function vpaOf(member: MemberRow): string | null {
  return member.vpa ?? member.profile?.default_vpa ?? null;
}
