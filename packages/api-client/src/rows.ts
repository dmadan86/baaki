/**
 * The fuller rows the web dashboard reads.
 *
 * The guest link view (`types.ts`) asks for one group and a fraction of its
 * columns. The signed-in web client is the whole app in a browser: it lists
 * every group, totals balances across them, and shows a cross-group activity
 * feed. These row shapes mirror the mobile app's (`apps/mobile/src/data/types`)
 * so the two clients read the same columns and cannot disagree about a name or
 * a number.
 */

export type GroupType = 'trip' | 'home' | 'couple' | 'event' | 'other';

export interface GroupRow {
  id: string;
  name: string | null;
  type: GroupType;
  country_code: string | null;
  default_currency: string;
  simplify_debts: boolean;
  cover_emoji: string | null;
  photo_path: string | null;
  start_date: string | null;
  end_date: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface MemberRow {
  id: string;
  group_id: string;
  profile_id: string | null;
  ghost_name: string | null;
  role?: 'admin' | 'member';
  vpa?: string | null;
  left_at: string | null;
  profile?: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
    default_vpa?: string | null;
  } | null;
}

export interface BalanceRow {
  group_id: string;
  member_id: string;
  currency: string;
  /** Positive: this member is owed. Negative: they owe. Minor units, decimal string. */
  balance: string;
}

export interface ActivityActor {
  id: string;
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
  actor_member_id: string | null;
  actor?: ActivityActor | null;
  verb: string;
  object_type: string;
  object_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  /** Present only on the cross-group feed. */
  group?: ActivityGroup | null;
}

export type DisputeStatus = 'open' | 'resolved' | 'withdrawn' | 'rejected';

/**
 * Somebody saying an expense is wrong. Never moves a balance on its own — a
 * share you could remove unilaterally would be a debt you could delete
 * (ADR-004). The table is read-only to clients; every write goes through an RPC.
 */
export interface DisputeRow {
  id: string;
  expense_id: string;
  member_id: string;
  reason: string | null;
  status: DisputeStatus;
  resolved_by_member_id: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** A row in an expense's edit history (ADR-004 keeps every version). */
export interface ExpenseVersionSummary {
  id: string;
  version_no: number;
  description: string;
  amount: string;
  currency: string;
  created_at: string;
  author_member_id: string | null;
  split_type: string;
}

/** One row per person per currency, from the `baaki_people_i_owe` RPC. */
export interface PersonBalanceRow {
  person_key: string;
  profile_id: string | null;
  member_id: string;
  display_name: string;
  avatar_url: string | null;
  is_ghost: boolean;
  currency: string;
  /** Positive: they owe you. Negative: you owe them. Minor units. */
  net: string;
  group_count: number;
  only_group_id: string | null;
}

/** Display name for a member, real or ghost — "You" when it is the reader. */
export function memberName(member: MemberRow, myProfileId?: string | null): string {
  if (member.profile_id && member.profile_id === myProfileId) return 'You';
  return member.profile?.display_name ?? member.ghost_name ?? 'Someone';
}

/** "Ravi", or "You" when it was the reader; "Someone" when the actor has left. */
export function actorName(
  actor: ActivityActor | null | undefined,
  myProfileId: string | null,
): string {
  if (!actor) return 'Someone';
  if (myProfileId && actor.profile_id === myProfileId) return 'You';
  return actor.profile?.display_name ?? actor.ghost_name ?? 'Someone';
}

/**
 * What to call a group that has no name: the people are the label.
 * "You, Priya and Ravi" beats "Untitled group" for the same reason a photo of
 * your friends beats a filename — you recognise it without reading it.
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
    .map((member) => memberName(member, myProfileId));

  if (others.length === 0) return 'New group';
  if (others.length === 1) return `You and ${others[0]}`;
  if (others.length === 2) return `You, ${others[0]} and ${others[1]}`;
  return `You, ${others[0]} and ${others.length - 1} others`;
}
