import type { MemberId, SplitParams } from '@baaki/core';

export type GroupType = 'trip' | 'home' | 'couple' | 'event' | 'other';
export type SettlementMethod = 'upi' | 'cash' | 'bank' | 'other';
export type SettlementStatus =
  'initiated' | 'confirmed' | 'auto_confirmed' | 'disputed' | 'cancelled';

export interface GroupRow {
  id: string;
  name: string;
  type: GroupType;
  default_currency: string;
  simplify_debts: boolean;
  cover_emoji: string | null;
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

export interface ActivityRow {
  id: string;
  group_id: string;
  actor_member_id: MemberId | null;
  verb: string;
  object_type: string;
  object_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
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

export function isGhost(member: MemberRow): boolean {
  return member.profile_id === null;
}

export function vpaOf(member: MemberRow): string | null {
  return member.vpa ?? member.profile?.default_vpa ?? null;
}
