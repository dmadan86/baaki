import type { MemberId, SplitParams } from '@waves/core';

export enum GroupType {
  Trip = 'trip',
  Home = 'home',
  Couple = 'couple',
  Event = 'event',
  Other = 'other',
}
export enum SettlementMethod {
  Upi = 'upi',
  Cash = 'cash',
  Bank = 'bank',
  Other = 'other',
}
export enum SettlementStatus {
  Initiated = 'initiated',
  Confirmed = 'confirmed',
  AutoConfirmed = 'auto_confirmed',
  Disputed = 'disputed',
  Cancelled = 'cancelled',
}

export interface GroupRow {
  id: string;
  /** Optional — an unnamed group is labelled by who is in it (see groupLabel). */
  name: string | null;
  type: GroupType;
  /**
   * ISO-3166 alpha-2 — where this group settles, which decides which payment
   * rails it is offered. Null is a supported state: it falls back to bank,
   * cash and the cross-border wallets.
   */
  country_code: string | null;
  default_currency: string;
  simplify_debts: boolean;
  cover_emoji: string | null;
  /** Object path in the private `group-photos` bucket, or null. */
  photo_path: string | null;
  /** ISO dates, both ends inclusive. Null on a group that is not a trip. */
  start_date: string | null;
  end_date: string | null;
  /** IANA zone the daily reminders are scheduled in — the trip's, not the reader's. */
  time_zone: string;
  remind_daily: boolean;
  /** `HH:MM:SS` local to `time_zone`. */
  remind_morning_at: string;
  remind_evening_at: string;
  archived_at: string | null;
  created_at: string;
  /** The overall trip budget, minor units, or null for "no cap". Set by an admin
   *  and always group-visible; the private per-member caps live elsewhere.
   *  Optional because the narrow contact/group REST selects omit it — the mirror
   *  row (a full `*` pull) always carries it. */
  budget_minor?: string | null;
  budget_currency?: string | null;
  /** True while this row exists only in the local queue (ADR-005). */
  pending?: boolean;
}

export interface MemberRow {
  id: MemberId;
  /** Where their invite goes. A hint for one invited person, not a contact book. */
  invite_email?: string | null;
  /** E.164. */
  invite_phone?: string | null;
  group_id: string;
  profile_id: string | null;
  ghost_name: string | null;
  role: 'admin' | 'member';
  /** The UPI-shaped fields. Superseded by the rail pair; still read as a fallback. */
  vpa: string | null;
  /** Which rail this person is paid on here — a `RailId` from `@waves/core`. */
  payment_rail?: string | null;
  payment_handle?: string | null;
  left_at: string | null;
  profile?: {
    id: string;
    display_name: string;
    avatar_url: string | null;
    default_vpa: string | null;
    payment_rail?: string | null;
    payment_handle?: string | null;
  } | null;
  /** True while this row exists only in the local queue (ADR-005). */
  pending?: boolean;
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

export enum CaptureStatus {
  /** In the inbox, waiting to be assigned to a group. */
  Open = 'open',
  /** Turned into a real expense; kept for the record but out of the inbox. */
  Assigned = 'assigned',
}

/**
 * An expense caught before it has a group (TDR A34).
 *
 * It is personal until it is assigned: owned by one user, synced under that
 * user's own scope rather than any group's, and split among nobody yet. On
 * assignment it becomes an ordinary `expenses` row in the chosen group and this
 * row flips to `assigned`, which is what removes it from the inbox.
 */
export interface CaptureRow {
  id: string;
  owner_user_id: string;
  description: string;
  category: string | null;
  expense_date: string;
  currency: string;
  /** BIGINT arrives as a string from PostgREST — parse, never Number(). */
  amount: string;
  notes: string | null;
  /** Object path in the owner-scoped receipts bucket, or null. */
  photo_path: string | null;
  /** On-device OCR text (A5), kept so assignment can prefill the expense form. */
  raw_text: string | null;
  parsed: Record<string, unknown> | null;
  /** How it was paid: 'cash' | 'credit' | 'debit' | 'forex', or null. */
  payment_method: string | null;
  /** Intended destination group, chosen up front; null means decide later. */
  target_group_id: string | null;
  status: CaptureStatus;
  assigned_expense_id: string | null;
  assigned_group_id: string | null;
  created_at: string;
  /** True while this row exists only in the local queue (ADR-005). */
  pending?: boolean;
}

export enum DisputeStatus {
  Open = 'open',
  Resolved = 'resolved',
  Withdrawn = 'withdrawn',
  Rejected = 'rejected',
}

/**
 * Somebody saying an expense is wrong. Never changes a balance on its own —
 * a share you could remove unilaterally would be a debt you could delete.
 */
export interface DisputeRow {
  id: string;
  expense_id: string;
  member_id: MemberId;
  reason: string | null;
  status: DisputeStatus;
  resolved_by_member_id: MemberId | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
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
  /** True while this row exists only in the local queue (ADR-005). */
  pending?: boolean;
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
 * A row in the inbox (TDR §7.1).
 *
 * `title` and `body` are English and are a fallback: the server wrote them
 * without knowing who would read them or in which language. The real wording
 * comes from `kind` + `payload` through `renderNotification` in @waves/core.
 */
export interface NotificationRow {
  id: string;
  group_id: string | null;
  kind: string;
  title: string;
  body: string;
  deep_link: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
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

/**
 * How this person is paid: the rail, and the handle on it.
 *
 * Per-group first, then their profile default — the same precedence `vpaOf`
 * has always used, because one person can be paid over UPI in one group and
 * over Wise in another. The `vpa` columns are the last fallback: everything
 * written before rails existed is a UPI ID, and the person who typed it should
 * not have to type it again.
 */
export function payableAt(member: MemberRow): { rail: string; handle: string } | null {
  const handle = member.payment_handle ?? member.profile?.payment_handle ?? vpaOf(member) ?? null;
  if (!handle) return null;

  const rail =
    member.payment_rail ??
    member.profile?.payment_rail ??
    // A handle from before rails existed can only have been a UPI ID.
    (vpaOf(member) ? 'upi' : null);
  if (!rail) return null;

  return { rail, handle };
}
