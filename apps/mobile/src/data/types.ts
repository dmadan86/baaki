import { payableFor } from '@waves/core';
import type { CategoryMeta, ExpenseLocation, MemberId, Payable, SplitParams } from '@waves/core';

export enum GroupType {
  Trip = 'trip',
  Home = 'home',
  Couple = 'couple',
  Event = 'event',
  Friends = 'friends',
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
  /** What the group is for, in the maker's own words. Optional, capped at
   *  GROUP_DESCRIPTION_MAX by both the input and a CHECK on the column. NULL,
   *  never '' — an empty string would render as a blank line everywhere this is
   *  shown, where an absent one renders as nothing. */
  description: string | null;
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
  /** Raw token of the group's durable join link (re-showable as a QR), or null
   *  until first created. Member-only (the group row is RLS-scoped). Optional
   *  because the narrow REST selects omit it; the `*` mirror pull carries it. */
  join_token?: string | null;
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
  /** A group-wide tombstone (A49): set when an admin deletes a settled group.
   *  Hides the group from every list — active AND archive — on all members'
   *  devices; the rows stay (ADR-004). */
  deleted_at: string | null;
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
  /** A custom tag's {label, icon, tint} snapshot (extends TDR §8); null for a
   *  built-in category. Lets any member render the tag without the author's catalog. */
  category_meta: CategoryMeta | null;
  expense_date: string;
  currency: string;
  /** BIGINT arrives as a string from PostgREST — parse, never Number(). */
  amount: string;
  split_type: SplitParams['kind'];
  split_params: SplitParams;
  author_member_id: MemberId | null;
  notes: string | null;
  payment_method: string | null;
  /** A view-only link to the owner's own cloud copy of the receipt (E3), or null. */
  receipt_share_url: string | null;
  /** Where the spend happened (A43): a {lat, lng, name} snapshot, or null. */
  location: ExpenseLocation | null;
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
  /** A custom tag's {label, icon, tint} snapshot (extends TDR §8); null for a built-in. */
  category_meta: CategoryMeta | null;
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
  /** Where the spend happened (A43): a {lat, lng, name} snapshot, or null. */
  location: ExpenseLocation | null;
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
  /** Set when the group has been archived — the activity feed shows a badge so a
   *  row from an archived group is recognisable without opening it. Null on a
   *  live group. */
  archived_at: string | null;
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
  blocked?: ReadonlySet<string> | null,
  someoneLabel = 'Someone',
): string {
  if (!actor) return someoneLabel;
  if (myProfileId && actor.profile_id === myProfileId) return 'You';
  // A blocked person is shown as the anonymous ghost everywhere they surface —
  // the feed included — never their real name. Never applied to yourself.
  if (actor.profile_id && blocked?.has(actor.profile_id)) return someoneLabel;
  return actor.profile?.display_name ?? actor.ghost_name ?? someoneLabel;
}

export interface BalanceRow {
  group_id: string;
  member_id: MemberId;
  currency: string;
  balance: string;
}

/**
 * Display name for a member, real or ghost.
 *
 * `blocked` is the set of profile ids the viewer has blocked (device-local, see
 * `data/blocked`). A blocked person is never shown by their real name — they
 * read as the anonymous ghost (`someoneLabel`, the localized `t.misc.someone`)
 * so the block is a genuine change in how they appear, not a cosmetic tag. The
 * viewer is never blocked against themselves, so "You" always wins first. This
 * only touches the label; nothing here reads or moves a balance.
 */
export function displayName(
  member: MemberRow,
  myProfileId?: string | null,
  blocked?: ReadonlySet<string> | null,
  someoneLabel = 'Someone',
): string {
  if (member.profile_id && member.profile_id === myProfileId) return 'You';
  if (member.profile_id && blocked?.has(member.profile_id)) return someoneLabel;
  return member.profile?.display_name ?? member.ghost_name ?? someoneLabel;
}

/**
 * Whether this member is a person the viewer has blocked — used to give them the
 * ghost look (dashed avatar) alongside the ghost name. Only real people (with a
 * profile id) can be blocked; a plain ghost has no cross-group identity to key
 * a block on.
 */
export function isBlockedMember(
  member: Pick<MemberRow, 'profile_id'>,
  blocked?: ReadonlySet<string> | null,
): boolean {
  return Boolean(member.profile_id && blocked?.has(member.profile_id));
}

/**
 * Is this member the person holding the phone?
 *
 * Written out as a function because the obvious spelling is wrong, and wrong in
 * a way nothing catches. `member.profile_id === profile?.id` reads perfectly and
 * behaves perfectly — until the profile has not loaded yet. Then `profile?.id`
 * is `undefined`, `profileId` is passed down as `null`, and the comparison
 * matches **the first ghost in the group**, because a ghost is exactly a member
 * with no `profile_id`.
 *
 * That is not an edge case, it is the first second of every cold start, and it
 * is not a harmless one. The dashboard computes its balances from whichever
 * member it decides is you — so for that second the whole ledger was being read
 * from a ghost's point of view, and the hero said "Net payable −₹82,001" with
 * the sign, the colour, the label and every group row agreeing, before flipping
 * to "Net receivable +₹112,807" when the profile arrived. Nothing about the
 * first number looked provisional; it was simply somebody else's balance shown
 * as yours.
 *
 * `captureBulkAssign.AssignMember` warns about the same trap for payers, having
 * hit it from the other direction. This is the shared, safe spelling: no viewer,
 * no match, ever.
 */
export function isViewer(
  member: Pick<MemberRow, 'profile_id'>,
  profileId: string | null | undefined,
): boolean {
  if (!profileId) return false;
  return member.profile_id === profileId;
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

/**
 * A member with no account behind them — somebody a person added by name.
 *
 * Narrowed to the one field it reads, as `isViewer` is, so it can be asked of
 * anything member-shaped rather than only of a full row. This *is* the
 * definition of a ghost, which is why it is the one place in the app allowed to
 * compare `profile_id` against null directly.
 */
export function isGhost(member: Pick<MemberRow, 'profile_id'>): boolean {
  return member.profile_id === null;
}

/**
 * How this person is paid: the rail, and the handle on it.
 *
 * The precedence lives in `@waves/core` (`payableFor`), because the web settle
 * screen has to answer the same question off the same columns and used to
 * answer it differently — reading `vpa ?? default_vpa` alone, so a payee on any
 * rail but UPI looked like somebody who had given no details. This is the thin
 * wrapper that types it against the mobile row.
 */
export function payableAt(member: MemberRow): Payable | null {
  return payableFor(member);
}
