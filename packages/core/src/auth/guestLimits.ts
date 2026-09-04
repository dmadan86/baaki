/**
 * How long a guest may stay a guest, and how much they may do before Waves
 * asks them to keep the account (ADR-006 addendum).
 *
 * ADR-006 lets anybody start with no account and upgrade in place, and that is
 * still true — nothing here deletes data or signs anybody out. What it adds is
 * a ceiling. A guest may be in exactly one group, their own or one they were
 * invited to, and may keep writing for ten days; after that the app turns
 * read-only until they attach an email, a phone or a provider. Because the
 * upgrade is in place (same user id), everything made as a guest comes with
 * them the moment they sign up — which is the whole point of gating rather than
 * wiping.
 *
 * Pure, and shared three ways: the mobile app disables the buttons with it, the
 * `sync` edge function refuses the writes with it, and the `waves_create_group`
 * function mirrors the same two numbers in SQL. They agree to the day because
 * two of the three import this file and the third quotes it.
 */

/** A guest may be in this many groups at once — one they made or one they joined. */
export const GUEST_GROUP_LIMIT = 1;

/** Days a guest may keep writing before the app turns read-only. */
export const GUEST_TRIAL_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuestGate {
  /** Past the trial window: reads still work, writes do not. */
  readonly expired: boolean;
  /** Whole days left in the trial, floored at 0 (which is what `expired` says too). */
  readonly daysLeft: number;
  /** Already holds as many groups as a guest may. */
  readonly atGroupLimit: boolean;
  /** May start or join another group right now. */
  readonly canAddGroup: boolean;
  /** May make any write at all — add an expense, settle, edit. */
  readonly canWrite: boolean;
}

/** Why a guest is being asked to sign up, or `null` when nothing blocks them. */
export enum GuestBlock {
  GroupLimit = 'group_limit',
  TrialExpired = 'trial_expired',
}

/**
 * Where a guest stands against both limits.
 *
 * `createdAt` is when the anonymous account was made (Supabase's
 * `user.created_at`); `groupCount` is how many live groups they are in.
 */
export function guestGate(input: {
  createdAt: string | number | Date;
  groupCount: number;
  now?: Date;
}): GuestGate {
  const created = new Date(input.createdAt).getTime();
  const now = (input.now ?? new Date()).getTime();

  // A createdAt that will not parse (an empty string, a malformed date) must
  // not read as "created at the epoch" and expire everyone instantly, nor as
  // NaN and leak a never-ending trial. Treat it as just created: the safe
  // failure is a guest who keeps working, not one locked out by a bad field.
  const endsAt = (Number.isFinite(created) ? created : now) + GUEST_TRIAL_DAYS * DAY_MS;

  const msLeft = endsAt - now;
  const expired = msLeft <= 0;
  const daysLeft = expired ? 0 : Math.ceil(msLeft / DAY_MS);

  // A negative count can only be a bug upstream; clamp so it can never read as
  // "room for one more".
  const atGroupLimit = Math.max(0, input.groupCount) >= GUEST_GROUP_LIMIT;

  return {
    expired,
    daysLeft,
    atGroupLimit,
    canWrite: !expired,
    canAddGroup: !expired && !atGroupLimit,
  };
}

/** The reason to gate a "start or join a group" action, or `null` to allow it. */
export function guestGroupBlock(gate: GuestGate): GuestBlock | null {
  if (gate.expired) return GuestBlock.TrialExpired;
  if (gate.atGroupLimit) return GuestBlock.GroupLimit;
  return null;
}

/** The reason to gate any other write, or `null` to allow it. */
export function guestWriteBlock(gate: GuestGate): GuestBlock | null {
  return gate.expired ? GuestBlock.TrialExpired : null;
}
