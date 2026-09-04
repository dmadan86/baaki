/**
 * Every read and write the app performs, in one file.
 *
 * Reads go straight to PostgREST — RLS decides what comes back, so there is no
 * "am I allowed?" check in the client (ADR-013). Writes that touch money go
 * through the `expense-write` edge function or a SECURITY DEFINER RPC, because
 * the server must own share computation and authorization (TDR §4).
 */

import { randomUUID } from 'expo-crypto';

import {
  buildExpenseWriteBody,
  normaliseEmail,
  normalisePhone,
  serialiseSplitParams,
  type CategoryMeta,
  type CurrencyCode,
  type DeviceLimitStatus,
  type DeviceSession,
  type ExpenseLocation,
  type FxRecord,
  type ParsedReceipt,
  type PaymentMethod,
  type ReceiptCheck,
  type SplitParams,
} from '@waves/core';

import { activeStrings } from '@/i18n';
import type { DeviceIdentity } from '@/lib/device';
import { normaliseContactPhone } from '@/lib/phone';
import { imageUrl, putImage, removeImage } from '@/lib/storage';
import { backend } from '@/lib/backend';
import type {
  ActivityGroup,
  ActivityRow,
  BalanceRow,
  ExpenseRow,
  GroupRow,
  GroupType,
  DisputeRow,
  MemberRow,
  SettlementMethod,
  SettlementRow,
} from './types';

const GROUP_SELECT = `
  id, name, type, country_code, default_currency, simplify_debts, cover_emoji, photo_path,
  start_date, end_date, time_zone, remind_daily, remind_morning_at, remind_evening_at,
  archived_at, deleted_at, created_at
`;

// profiles is embedded by its FK column (profile_id): ghost_merges references
// both group_members and profiles, so PostgREST sees two group_members↔profiles
// relationships and an unqualified embed fails ("more than one relationship").
const MEMBER_SELECT = `
  id, group_id, profile_id, ghost_name, role, vpa, payment_rail, payment_handle, left_at,
  profile:profiles!profile_id ( id, display_name, avatar_url, default_vpa, payment_rail, payment_handle )
`;

const EXPENSE_SELECT = `
  id, group_id, deleted_at, created_at,
  currentVersion:expense_versions!expenses_current_version_id_fkey (
    id, version_no, description, category, expense_date, currency, amount,
    split_type, split_params, author_member_id, notes, payment_method, created_at,
    payers:expense_payers ( member_id, amount ),
    shares:expense_shares ( member_id, amount )
  )
`;

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error('No data returned');
  return result.data;
}

// ───────────────────────────────────────────────────────────── groups ──

export async function fetchGroups(): Promise<GroupRow[]> {
  return unwrap(
    await backend
      .from('groups')
      .select(GROUP_SELECT)
      .is('archived_at', null)
      // A deleted group (A49) is a tombstone, not an archive — it never shows,
      // so it is excluded here as well as from the archived list.
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
  );
}

export async function fetchGroup(groupId: string): Promise<GroupRow> {
  return unwrap(await backend.from('groups').select(GROUP_SELECT).eq('id', groupId).single());
}

export async function fetchMembers(groupId: string): Promise<MemberRow[]> {
  return unwrap(
    await backend
      .from('group_members')
      .select(MEMBER_SELECT)
      .eq('group_id', groupId)
      .is('left_at', null)
      .order('created_at', { ascending: true }),
  ) as unknown as MemberRow[];
}

export async function fetchExpenses(
  groupId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<ExpenseRow[]> {
  let query = backend
    .from('expenses')
    .select(EXPENSE_SELECT)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false });
  if (!options.includeDeleted) query = query.is('deleted_at', null);
  return unwrap(await query) as unknown as ExpenseRow[];
}

export async function fetchSettlements(groupId: string): Promise<SettlementRow[]> {
  return unwrap(
    await backend
      .from('settlements')
      .select(
        `id, group_id, from_member_id, to_member_id, currency, amount, method, status, note,
         initiated_at, confirmed_at,
         allocations:settlement_allocations ( expense_id, amount )`,
      )
      .eq('group_id', groupId)
      .order('initiated_at', { ascending: false }),
  ) as unknown as SettlementRow[];
}

export async function fetchActivity(groupId: string, limit = 50): Promise<ActivityRow[]> {
  return unwrap(
    await backend
      .from('activity_log')
      .select(
        `id, group_id, actor_member_id, verb, object_type, object_id, payload, created_at,
         actor:group_members!activity_log_actor_member_id_fkey (
           id, profile_id, ghost_name, profile:profiles!profile_id ( display_name )
         )`,
      )
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ) as unknown as ActivityRow[];
}

/** Activity across every group the user can see — RLS does the filtering. */
export async function fetchRecentActivity(
  limit = 60,
): Promise<(ActivityRow & { group: ActivityGroup | null })[]> {
  return unwrap(
    await backend
      .from('activity_log')
      .select(
        `id, group_id, actor_member_id, verb, object_type, object_id, payload, created_at,
         group:groups ( id, name, cover_emoji, archived_at ),
         actor:group_members!activity_log_actor_member_id_fkey (
           id, profile_id, ghost_name, profile:profiles!profile_id ( display_name )
         )`,
      )
      .order('created_at', { ascending: false })
      .limit(limit),
  ) as unknown as (ActivityRow & { group: ActivityGroup | null })[];
}

/**
 * The server's own balances. The client recomputes the same numbers from the
 * expense rows with @waves/core and compares — a mismatch means something is
 * wrong and the user is told, rather than shown a plausible wrong number.
 */
export async function fetchBalances(groupId: string): Promise<BalanceRow[]> {
  return unwrap(
    await backend
      .from('group_balances')
      .select('group_id, member_id, currency, balance')
      .eq('group_id', groupId),
  );
}

export async function fetchAllBalances(): Promise<BalanceRow[]> {
  return unwrap(
    await backend.from('group_balances').select('group_id, member_id, currency, balance'),
  );
}

/** Just my own balance in each group — one query for the home screen. */
export async function fetchMyBalances(profileId: string): Promise<BalanceRow[]> {
  const rows = unwrap(
    await backend
      .from('group_balances')
      .select('group_id, member_id, currency, balance, member:group_members!inner ( profile_id )')
      .eq('member.profile_id', profileId),
  ) as unknown as (BalanceRow & { member: { profile_id: string } })[];
  return rows.map(({ member: _member, ...row }) => row);
}

/** Groups with a settlement still waiting on someone to confirm (ADR-007). */
export async function fetchPendingSettlements(): Promise<{ group_id: string; id: string }[]> {
  return unwrap(await backend.from('settlements').select('id, group_id').eq('status', 'initiated'));
}

/**
 * How much has actually changed hands through this person, per currency.
 *
 * Both directions count. This is not a balance and must never be shown as one:
 * money paid and money received are the same fact here — that a debt was
 * closed — so it carries no sign and no owed/owe colour.
 *
 * Only settled settlements count. `initiated` means somebody says they paid and
 * nobody has agreed yet (ADR-007), and a number that goes up the moment you
 * claim something is a number that flatters rather than reports.
 *
 * Kept per currency because there is no rate that makes rupees and euros one
 * total, and inventing one here would be the only place in Waves that guesses
 * at money.
 */
export async function fetchSettledTotals(profileId: string): Promise<Map<CurrencyCode, bigint>> {
  const rows = unwrap(
    await backend
      .from('settlements')
      .select(
        `currency, amount,
         from:group_members!settlements_from_member_id_fkey ( profile_id ),
         to:group_members!settlements_to_member_id_fkey ( profile_id )`,
      )
      .in('status', ['confirmed', 'auto_confirmed']),
  ) as unknown as {
    currency: CurrencyCode;
    amount: string | number;
    from: { profile_id: string | null } | null;
    to: { profile_id: string | null } | null;
  }[];

  const totals = new Map<CurrencyCode, bigint>();
  for (const row of rows) {
    // Row-level security already limits this to groups I am in; it does not
    // limit it to settlements I am *part of*, and the two are not the same.
    if (row.from?.profile_id !== profileId && row.to?.profile_id !== profileId) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0n) + BigInt(row.amount));
  }
  return totals;
}

/**
 * Members of every group I am in, one query. Names as well as counts, because
 * a group with no name is labelled by the people in it (`groupLabel`) and the
 * home screen would otherwise have nothing to call it.
 */
export async function fetchMembersByGroup(): Promise<Map<string, MemberRow[]>> {
  const rows = unwrap(
    await backend
      .from('group_members')
      .select(
        'id, group_id, profile_id, ghost_name, role, vpa, left_at, invite_email, invite_phone, profile:profiles!profile_id ( id, display_name, avatar_url, default_vpa )',
      )
      .is('left_at', null)
      .order('created_at', { ascending: true }),
  ) as unknown as MemberRow[];

  const byGroup = new Map<string, MemberRow[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group_id);
    if (list) list.push(row);
    else byGroup.set(row.group_id, [row]);
  }
  return byGroup;
}

// ──────────────────────────────────────────────────────────── writes ──

export async function createGroup(input: {
  /** Optional. A group with no name is labelled by who is in it. */
  name?: string | null;
  type: GroupType;
  currency: string;
  emoji?: string | null;
  simplify?: boolean;
  groupId?: string;
  photoPath?: string | null;
  /**
   * ISO-3166 alpha-2. Decides which payment rails the group is offered. Null
   * falls back to the creator's own country server-side, and then to nothing —
   * which is a supported state, not a broken one.
   */
  country?: string | null;
  /**
   * The creator's own membership id, chosen by the client so an expense created
   * in the same breath (an offline IOU) can name it before the server assigns
   * one. Omitted, the server mints it as before.
   */
  creatorMemberId?: string;
}): Promise<string> {
  const { data, error } = await backend.rpc('waves_create_group', {
    p_name: input.name?.trim() || null,
    p_type: input.type,
    p_currency: input.currency,
    p_emoji: input.emoji ?? null,
    p_simplify: input.simplify ?? true,
    p_group_id: input.groupId ?? null,
    p_photo_path: input.photoPath ?? null,
    p_country: input.country ?? null,
    p_creator_member_id: input.creatorMemberId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

// ────────────────────────────────────────── group photos (Storage) ──

const PHOTO_BUCKET = 'group-photos';

/**
 * Upload a cover photo for a group.
 *
 * The path is always `<groupId>/cover.<ext>`, which is what the storage
 * policies key off: only members of that group can read or write under it.
 * `upsert` because replacing the photo is the common case and a second object
 * per change would quietly eat the free tier (ADR-011).
 */
export async function uploadGroupPhoto(input: {
  groupId: string;
  base64: string;
  mimeType?: string | null;
}): Promise<string> {
  const mime = normaliseImageMime(input.mimeType);
  const path = `${input.groupId}/cover.${imageExt(mime)}`;

  await putImage({
    bucket: PHOTO_BUCKET,
    path,
    base64: input.base64,
    contentType: mime,
    groupId: input.groupId,
  });

  const { error: linkError } = await backend
    .from('groups')
    .update({ photo_path: path })
    .eq('id', input.groupId);
  if (linkError) throw new Error(linkError.message);

  return path;
}

/** Signed because the bucket is private — a group photo is not public data. */
export async function groupPhotoUrl(path: string | null): Promise<string | null> {
  return imageUrl(PHOTO_BUCKET, path);
}

export async function removeGroupPhoto(groupId: string, path: string | null): Promise<void> {
  await removeImage(PHOTO_BUCKET, path);
  const { error } = await backend.from('groups').update({ photo_path: null }).eq('id', groupId);
  if (error) throw new Error(error.message);
}

/**
 * May a real photo be set on this group — or, with no group yet, on the group
 * the caller is about to create? A group photo is a paid feature; a cover emoji
 * stays free. True when anyone in the group is paid (or the group holds a pass);
 * for a new group that is just "is the creator paid".
 *
 * Answered by a SECURITY DEFINER RPC because a member cannot read another
 * member's subscription under RLS — the server returns only the boolean, never
 * whose subscription it was. Pass `null` for the new-group case.
 */
export async function canUploadGroupPhoto(groupId: string | null): Promise<boolean> {
  const { data, error } = await backend.rpc('waves_can_upload_group_photo', {
    p_group_id: groupId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * Whether this group may take one more receipt.
 *
 * A group holds a set number of receipts for free (the number is an admin knob,
 * `app_config.receipt_cap_per_group`); past it, somebody has to pay or add
 * storage. A paid group has no cap. Answered by a SECURITY DEFINER RPC — a
 * member cannot count another's entitlement under RLS — which returns only the
 * boolean. The server enforces the same rule when it records the receipt, so
 * this is the affordance, not the boundary.
 */
export async function canAddReceipt(groupId: string): Promise<boolean> {
  const { data, error } = await backend.rpc('waves_can_add_receipt', {
    p_group_id: groupId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * May the caller add one more gallery receipt to THIS expense? The per-expense
 * twin of `canAddReceipt` (A46): a free group holds a small number of gallery
 * images per expense, paid lifts it. The affordance, not the boundary —
 * `waves_attach_expense_attachment` enforces the same ceiling server-side.
 */
export async function canAddExpenseAttachment(expenseId: string): Promise<boolean> {
  const { data, error } = await backend.rpc('waves_can_add_expense_attachment', {
    p_expense_id: expenseId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * The signed-in caller's own image-storage usage (A44), for the settings meter.
 *
 * `used` counts only the bytes that are charged against a ceiling — a paid
 * account, whose bytes are never counted, reads 0 used — and `cap` is the
 * current free-tier ceiling. Answered by a `SECURITY DEFINER` RPC scoped hard to
 * the caller's own profile, so it reveals nobody else's tally.
 */
export async function myStorageUsage(): Promise<{ usedBytes: number; capBytes: number }> {
  const { data, error } = await backend.rpc('waves_my_storage_usage');
  if (error) throw new Error(error.message);
  const row = (data as { used_bytes: number; cap_bytes: number }[] | null)?.[0];
  return { usedBytes: Number(row?.used_bytes ?? 0), capBytes: Number(row?.cap_bytes ?? 0) };
}

/** The bucket accepts three types; anything else is stored as JPEG. */
function normaliseImageMime(mimeType: string | null | undefined): string {
  if (mimeType === 'image/png' || mimeType === 'image/webp') return mimeType;
  return 'image/jpeg';
}

function imageExt(mime: string): string {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

// ─────────────────────────────────────── capture receipts (Storage, A34) ──

const CAPTURE_BUCKET = 'captures';

/**
 * Upload a capture's receipt photo and return its storage path.
 *
 * Unlike a group photo, this does not write the owning row — a capture is
 * written only through the sync queue, so the path this returns rides in the
 * `capture.create`/`capture.update` payload as `photoPath`. The path is
 * `<ownerUserId>/<captureId>.<ext>`, which is exactly what the owner-only bucket
 * policy keys off (its first segment must equal the caller's own id).
 */
export async function uploadCapturePhoto(input: {
  ownerUserId: string;
  captureId: string;
  base64: string;
  mimeType?: string | null;
}): Promise<string> {
  const mime = normaliseImageMime(input.mimeType);
  const path = `${input.ownerUserId}/${input.captureId}.${imageExt(mime)}`;
  // No group at capture time (a capture is assigned later, A34), so the bytes
  // count against the owner's own ceiling.
  await putImage({ bucket: CAPTURE_BUCKET, path, base64: input.base64, contentType: mime });
  return path;
}

/** Resolve a capture photo path to a displayable signed URL (private bucket). */
export async function capturePhotoUrl(path: string | null): Promise<string | null> {
  return imageUrl(CAPTURE_BUCKET, path);
}

// ─────────────────────────────────────── kept expense bills (Storage, E2) ──

const RECEIPT_BUCKET = 'receipts';

/**
 * The R2 path a group expense's kept bill (E2) lives at: `<groupId>/<expenseId>.jpg`.
 *
 * Deterministic on purpose — both the screen that keeps the bill and the screen
 * that views it later derive the same path from the same two ids, so no column
 * has to remember where the image went. The group segment is what makes it
 * group-readable in R2: the `r2-sign` edge authorises a read for anyone in that
 * group, which is exactly the visibility the old E3 "share with group" toggle
 * used to arrange by hand.
 */
export function expenseReceiptPath(groupId: string, expenseId: string): string {
  return `${groupId}/${expenseId}.jpg`;
}

/**
 * Keep the photographed/attached bill for a group expense (E2) in R2.
 *
 * Uploaded to the private `receipts` bucket under {@link expenseReceiptPath}, so
 * it counts against the group's storage ceiling (ADR-011) and is readable by the
 * group. Returns the stored path. Reuses the same `putImage` seam every other
 * uploader uses — the client holds no R2 credential.
 */
export async function uploadExpenseReceipt(input: {
  groupId: string;
  expenseId: string;
  base64: string;
  mimeType?: string | null;
}): Promise<string> {
  const path = expenseReceiptPath(input.groupId, input.expenseId);
  // The path suffix is fixed at `.jpg` so the viewer can find it without knowing
  // the source format; the real content type still rides so R2 serves it right.
  await putImage({
    bucket: RECEIPT_BUCKET,
    path,
    base64: input.base64,
    contentType: normaliseImageMime(input.mimeType),
    groupId: input.groupId,
  });
  // Record the add in the image audit (A46). Best-effort: the bill is kept even
  // if the line fails to write — the trail is evidence, not a gate.
  await logReceiptEvent(input.groupId, input.expenseId, 'added');
  return path;
}

/**
 * The kept bill has no DB row — its history lives in `expense_image_events`.
 * The upload/remove goes straight to R2, so the client writes the audit line
 * through this RPC, which stamps the actor from the session. The event id is
 * client-chosen so a retry is idempotent. Swallows failure: a missing audit
 * line must never break keeping or removing a bill.
 */
async function logReceiptEvent(
  groupId: string,
  expenseId: string,
  action: 'added' | 'removed',
): Promise<void> {
  const { error } = await backend.rpc('waves_log_receipt_event', {
    p_event_id: randomUUID(),
    p_group_id: groupId,
    p_expense_id: expenseId,
    p_action: action,
  });
  if (error) {
    console.warn('receipt audit log failed', error.message);
  }
}

/**
 * Remove a group expense's kept bill (E2) from R2 and record the removal in the
 * image audit. Best-effort on the bytes (the sweep is the backstop); the audit
 * line is what the group reads later.
 */
export async function removeExpenseReceipt(groupId: string, expenseId: string): Promise<void> {
  await removeImage(RECEIPT_BUCKET, expenseReceiptPath(groupId, expenseId));
  await logReceiptEvent(groupId, expenseId, 'removed');
}

/**
 * Resolve a group expense's kept bill to a displayable signed URL, or null when
 * none was ever kept. Doubles as the existence check — the `r2-sign` edge
 * returns nothing for an object it has no record of, so a null here means "no
 * receipt", and the affordance simply hides.
 */
export async function expenseReceiptUrl(
  groupId: string,
  expenseId: string,
): Promise<string | null> {
  return imageUrl(RECEIPT_BUCKET, expenseReceiptPath(groupId, expenseId));
}

// ───────────────────────────────────────── profile photos (Storage) ──

const AVATAR_BUCKET = 'avatars';

/**
 * Upload your own profile photo.
 *
 * `<profileId>/avatar.<ext>`, which the storage policies key off: you may write
 * only under your own id, and it is readable by people who are in a group with
 * you. `upsert`, so changing your picture replaces the object rather than
 * leaving the old one behind to be paid for forever (ADR-011).
 *
 * `avatar_url` holds the storage path, not a URL — the bucket is private, so
 * what is displayed is a signed URL resolved at read time. Google sign-in fills
 * the same column with a real https URL; `avatarPhotoUrl` tells them apart.
 */
export async function uploadAvatar(input: {
  profileId: string;
  base64: string;
  mimeType?: string | null;
}): Promise<string> {
  const mime = normaliseImageMime(input.mimeType);
  const path = `${input.profileId}/avatar.${imageExt(mime)}`;

  await putImage({ bucket: AVATAR_BUCKET, path, base64: input.base64, contentType: mime });

  const { error: linkError } = await backend
    .from('profiles')
    .update({ avatar_url: path })
    .eq('id', input.profileId);
  if (linkError) throw new Error(linkError.message);

  return path;
}

/**
 * Resolve whatever is in `avatar_url` to something an Image can display.
 *
 * Two kinds of value live in that column: a storage path this app wrote, and an
 * https URL that came from an OAuth provider at sign-up. Signing the second
 * would fail, and returning the first unsigned would 404, so the shape of the
 * value decides.
 */
export async function avatarPhotoUrl(value: string | null): Promise<string | null> {
  if (!value) return null;
  if (/^https?:\/\//.test(value)) return value;
  return imageUrl(AVATAR_BUCKET, value);
}

export async function removeAvatar(profileId: string, value: string | null): Promise<void> {
  // Only ours to delete. A provider URL is not an object in the bucket.
  if (value && !/^https?:\/\//.test(value)) {
    await removeImage(AVATAR_BUCKET, value);
  }
  const { error } = await backend.from('profiles').update({ avatar_url: null }).eq('id', profileId);
  if (error) throw new Error(error.message);
}

/**
 * ADR-006: a ghost is a real participant who simply hasn't joined yet.
 *
 * Goes through an RPC rather than a plain insert so normalisation happens in
 * one place. The same person typed two ways — `Ravi@Example.com` today,
 * `ravi@example.com` last week — must not become two members holding two
 * halves of a balance. The server returns the existing member id when the
 * contact already matches, so adding twice is harmless.
 */
export async function addGhostMember(
  groupId: string,
  name: string,
  contact: { email?: string | null; phone?: string | null } = {},
  accountCountry?: string | null,
): Promise<string> {
  // Read a bare local number in the caller's region before it ever reaches the
  // server, which refuses an uncoded number by design (the `member_contact_hints`
  // guard stays in place as defence in depth). No region and no country code is
  // the one case we genuinely cannot complete — a friendly ask, never raw.
  let phone: string | null;
  try {
    phone = normaliseContactPhone(contact.phone, accountCountry);
  } catch {
    throw new Error(activeStrings().people.phoneNeedsCountryCode);
  }
  const { data, error } = await backend.rpc('waves_add_ghost_member', {
    p_group_id: groupId,
    p_name: name.trim() || null,
    p_member_id: null,
    p_email: contact.email?.trim() || null,
    p_phone: phone,
  });
  if (error) {
    // The database speaks in codes; surface a sentence rather than a raw SQL
    // string. The phone guard should be unreachable now that entry normalises,
    // but keep the friendly line for defence in depth.
    const code = /^([A-Z_]+):/.exec(error.message)?.[1];
    throw new Error(
      code === 'PHONE_NEEDS_COUNTRY_CODE'
        ? activeStrings().people.phoneNeedsCountryCode
        : code === 'NOTHING_TO_ADD'
          ? 'Give a name, an email or a number'
          : error.message,
    );
  }
  return data as string;
}

export interface WriteExpenseInput {
  groupId: string;
  /** Pass an id to append a new version to an existing expense (ADR-004). */
  expenseId?: string;
  description: string;
  category?: string | null;
  expenseDate: string;
  currency: string;
  amount: bigint;
  splitParams: SplitParams;
  participants: string[];
  payers: Record<string, bigint>;
  /** Our local computation, sent so the server can contradict us if we differ. */
  expectedShares?: Record<string, bigint>;
  notes?: string | null;
  /** How the money moved: cash | credit | debit | forex. Optional. */
  paymentMethod?: PaymentMethod | null;
  /** Denormalised custom-tag display (extends TDR §8); null for a built-in. */
  categoryMeta?: CategoryMeta | null;
  /** Where the spend happened (A43); null unless the person opted in. */
  location?: ExpenseLocation | null;
  /** A view-only link to the owner's own cloud copy of the receipt (E3). */
  receiptShareUrl?: string | null;
  /** Links a scanned receipt (ADR-008) to this expense; null when none. */
  receiptId?: string | null;
  /** The rate used, when this expense is not in the group's currency. */
  fx?: FxRecord | null;
  /**
   * The version this edit is based on (ADR-004 / TDR §4.4). Set only for an
   * edit; lets the server turn a concurrent edit into a logged conflict instead
   * of a silent overwrite. Omitted for a create.
   */
  baseVersionNo?: number | null;
  clientMutationId?: string;
}

export interface WriteExpenseResult {
  expenseId: string;
  versionId: string;
  versionNo: number;
  replayed?: boolean;
}

/**
 * Write an expense through the `expense-write` edge function (the direct,
 * online path). The server recomputes every share and owns authorization
 * (TDR §4); the body is built by the one shared serializer the web client and
 * `/sync` also use, so a direct write carries the same fields as a queued one.
 */
export async function writeExpense(input: WriteExpenseInput): Promise<WriteExpenseResult> {
  const { data, error } = await backend.functions.invoke('expense-write', {
    // One shared body builder (`buildExpenseWriteBody` in @waves/core), so this
    // direct write, the web client's direct write and the `/sync` queued write
    // all carry the same fields — including `categoryMeta` and `baseVersionNo`,
    // which this path used to drop (a direct edit lost the custom-tag display and
    // skipped the concurrent-edit conflict check). Exact/adjustment/itemized
    // splits hold minor units and JSON has no bigint, so the split is stringified
    // here before the builder passes it through.
    body: buildExpenseWriteBody({
      groupId: input.groupId,
      expenseId: input.expenseId,
      description: input.description,
      category: input.category ?? null,
      expenseDate: input.expenseDate,
      currency: input.currency,
      amount: input.amount,
      splitParams: serialiseSplitParams(input.splitParams),
      participants: input.participants,
      payers: input.payers,
      expectedShares: input.expectedShares,
      notes: input.notes ?? null,
      paymentMethod: input.paymentMethod ?? null,
      categoryMeta: input.categoryMeta ?? null,
      location: input.location ?? null,
      receiptShareUrl: input.receiptShareUrl ?? null,
      receiptId: input.receiptId ?? null,
      fx: input.fx ?? null,
      baseVersionNo: input.baseVersionNo ?? null,
      // Idempotency key: a retry after a flaky network must not double-post.
      clientMutationId: input.clientMutationId ?? randomUUID(),
    }),
  });

  if (error) {
    // Supabase wraps non-2xx responses; surface the server's own code.
    const detail = await readFunctionError(error);
    throw new Error(detail);
  }
  return data as WriteExpenseResult;
}

async function readFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    // Read before the body, because `json()` consumes it and there is no second
    // chance at the headers afterwards on some runtimes.
    const retryAfter = Number(context.headers?.get?.('Retry-After') ?? '');
    try {
      const body = (await context.json()) as { code?: string; message?: string };

      // The one refusal a person meets while doing nothing wrong, so it is the
      // one that gets said in their own language. Everything else here is a
      // developer-facing code and stays as it is: `NOT_A_MEMBER` in front of
      // somebody is a bug report, and dressing it up as a sentence would hide
      // one.
      if (body?.code === 'RATE_LIMITED') {
        const strings = activeStrings();
        return Number.isFinite(retryAfter) && retryAfter > 60
          ? strings.common.tooFastLater
          : strings.common.tooFastMoment;
      }

      if (body?.message) return body.code ? `${body.code}: ${body.message}` : body.message;
    } catch {
      /* fall through to the generic message */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const { error } = await backend.rpc('waves_delete_expense', { p_expense_id: expenseId });
  if (error) throw new Error(error.message);
}

export async function restoreExpense(expenseId: string): Promise<void> {
  const { error } = await backend.rpc('waves_restore_expense', { p_expense_id: expenseId });
  if (error) throw new Error(error.message);
}

/**
 * One historical version of an expense, rich enough to diff against its
 * neighbour for the edit-history audit: the scalar fields plus the payer and
 * share rows, so "what changed" can name a field and show old → new.
 */
export interface ExpenseVersionAudit {
  id: string;
  version_no: number;
  description: string;
  /** Total, in minor units, as a string (bigint over the wire). */
  amount: string;
  currency: string;
  created_at: string;
  author_member_id: string | null;
  split_type: string;
  category: string | null;
  /** The custom tag snapshot when the category is a user tag; carries its label. */
  category_meta: { label?: string } | null;
  expense_date: string;
  location: ExpenseLocation | null;
  payers: { member_id: string; amount: string }[];
  shares: { member_id: string; amount: string }[];
}

export async function fetchExpenseVersions(expenseId: string): Promise<ExpenseVersionAudit[]> {
  return unwrap(
    await backend
      .from('expense_versions')
      .select(
        'id, version_no, description, amount, currency, created_at, author_member_id, split_type, ' +
          'category, category_meta, expense_date, location, ' +
          'payers:expense_payers ( member_id, amount ), ' +
          'shares:expense_shares ( member_id, amount )',
      )
      .eq('expense_id', expenseId)
      .order('version_no', { ascending: false }),
  ) as unknown as ExpenseVersionAudit[];
}

export async function recordSettlement(input: {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: bigint;
  /**
   * Which rail the money moved on — a `RailId` from `@waves/core`. The coarse
   * `method` enum is derived from it server-side, so a rail the enum has never
   * heard of (Pix, Aani) still records rather than being rejected.
   */
  rail: string;
  currency?: string;
  note?: string | null;
  allocations?: { expenseId: string; amount: bigint }[];
  clientMutationId?: string;
}): Promise<string> {
  const { data, error } = await backend.rpc('waves_record_settlement', {
    p_group_id: input.groupId,
    p_from_member_id: input.fromMemberId,
    p_to_member_id: input.toMemberId,
    p_amount: input.amount.toString(),
    // The enum only knows these four. Everything else is `other` there and
    // itself in `p_rail`.
    p_method: (['upi', 'cash', 'bank', 'other'] as const).includes(input.rail as SettlementMethod)
      ? (input.rail as SettlementMethod)
      : 'other',
    p_rail: input.rail,
    p_currency: input.currency ?? null,
    p_note: input.note ?? null,
    p_allocations: (input.allocations ?? []).map((allocation) => ({
      expenseId: allocation.expenseId,
      amount: allocation.amount.toString(),
    })),
    p_client_mutation_id: input.clientMutationId ?? randomUUID(),
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function confirmSettlement(settlementId: string): Promise<void> {
  const { error } = await backend.rpc('waves_confirm_settlement', {
    p_settlement_id: settlementId,
  });
  if (error) throw new Error(error.message);
}

export async function updateGroup(
  groupId: string,
  patch: Partial<{
    name: string | null;
    type: GroupType;
    cover_emoji: string | null;
    photo_path: string | null;
    simplify_debts: boolean;
    default_currency: string;
    /** ISO-3166 alpha-2 — decides which payment rails the group is offered. */
    country_code: string | null;
    archived_at: string | null;
    start_date: string | null;
    end_date: string | null;
    time_zone: string;
    remind_daily: boolean;
    remind_morning_at: string;
    remind_evening_at: string;
  }>,
): Promise<void> {
  const { error } = await backend.from('groups').update(patch).eq('id', groupId);
  if (error) throw new Error(error.message);
}

// ─────────────────────────────────────── declining an expense (ADR-004) ──
// A decline is a claim, not a mutation: it is recorded and everybody sees it,
// and the numbers move only when somebody edits the expense. Every write goes
// through an RPC — the table itself is read-only to clients, which is what
// stops a dispute being filed in somebody else's name.

export async function fetchDisputes(groupId: string): Promise<DisputeRow[]> {
  return unwrap(
    await backend
      .from('expense_disputes')
      .select(
        'id, expense_id, member_id, reason, status, resolved_by_member_id, resolution_note, created_at, resolved_at, expense:expenses!inner ( group_id )',
      )
      .eq('expense.group_id', groupId)
      .order('created_at', { ascending: false }),
  ) as unknown as DisputeRow[];
}

export async function disputeExpense(input: {
  expenseId: string;
  reason?: string | null;
}): Promise<string> {
  const { data, error } = await backend.rpc('waves_dispute_expense', {
    p_expense_id: input.expenseId,
    p_reason: input.reason?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function withdrawDispute(expenseId: string): Promise<void> {
  const { error } = await backend.rpc('waves_withdraw_dispute', { p_expense_id: expenseId });
  if (error) throw new Error(error.message);
}

export async function resolveDispute(input: {
  disputeId: string;
  accept: boolean;
  note?: string | null;
}): Promise<void> {
  const { error } = await backend.rpc('waves_resolve_dispute', {
    p_dispute_id: input.disputeId,
    p_accept: input.accept,
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(error.message);
}

/** Rename a ghost, or set a per-group VPA override on your own membership. */
export async function updateMember(
  memberId: string,
  patch: Partial<{ ghost_name: string; vpa: string | null }>,
): Promise<void> {
  const { error } = await backend.from('group_members').update(patch).eq('id', memberId);
  if (error) throw new Error(error.message);
}

/**
 * Promote a member to admin, or demote one back. Admin-only and last-admin
 * safety live in the RPC — a role is never a column a client writes, so this
 * cannot go through `updateMember` (a trigger would reject it).
 */
export async function setMemberRole(memberId: string, role: 'admin' | 'member'): Promise<void> {
  const { error } = await backend.rpc('waves_set_member_role', {
    p_member_id: memberId,
    p_role: role,
  });
  if (error) throw new Error(error.message);
}

/** Leaving is a soft exit: history stays, the person stops accruing new shares. */
export async function leaveGroup(memberId: string): Promise<void> {
  const { error } = await backend
    .from('group_members')
    .update({ left_at: new Date().toISOString() })
    .eq('id', memberId);
  if (error) throw new Error(error.message);
}

/**
 * Delete a group for everyone (A49) — Splitwise-style. A group-wide tombstone,
 * not a row delete: the ledger stays append-only (ADR-004), the group simply
 * leaves every member's lists on their next sync.
 *
 * Admin-only and settled-only are enforced in `waves_delete_group`, not here —
 * the button only offers it to an admin of a squared-up group, so the two coded
 * refusals are defence-in-depth. They are turned into a sentence the same way
 * `importLedger` maps its codes.
 */
export async function deleteGroup(groupId: string): Promise<void> {
  const { error } = await backend.rpc('waves_delete_group', { p_group_id: groupId });
  if (error) {
    const code = /^([A-Z_]+):/.exec(error.message)?.[1];
    const strings = activeStrings();
    // Carry the coded reason on the Error so the caller can pick the right
    // localized line in the render locale. The message is still a sentence (not
    // raw PostgREST) for any non-UI consumer / crash report; the unknown case
    // keeps the raw message, which the UI runs through friendlyError so it is
    // never shown verbatim.
    const thrown = new Error(
      code === 'NOT_SETTLED'
        ? strings.group.settleAllFirstBody
        : code === 'NOT_ADMIN'
          ? strings.group.deleteAdminOnly
          : error.message,
    );
    if (code === 'NOT_SETTLED' || code === 'NOT_ADMIN') {
      (thrown as { code?: string }).code = code;
    }
    throw thrown;
  }
}

// ─────────────────────────────────────────────── invites (ADR-006) ──

// Re-exported rather than defined here — `@/lib/webUrl` is the single source
// for the site's domain, shared with the QR scanner's host allowlist so the
// two can never drift apart. See that file for why.
export { INVITE_BASE, groupJoinLink } from '@/lib/webUrl';

export interface MintedInvite {
  inviteId: string;
  token: string;
  expiresAt: string;
  maxUses: number;
  groupName: string;
}

export async function mintInvite(groupId: string, expiresInDays = 7): Promise<MintedInvite> {
  const { data, error } = await backend.functions.invoke('invite-mint', {
    body: { groupId, expiresInDays },
  });
  if (error) throw new Error(await readFunctionError(error));
  return data as MintedInvite;
}

export interface InvitePreview {
  group: { id: string; name: string; cover_emoji: string | null; default_currency: string } | null;
  memberCount: number;
  claimable: { memberId: string; name: string | null }[];
}

export async function previewInvite(token: string): Promise<InvitePreview> {
  const { data, error } = await backend.functions.invoke('invite-accept', {
    body: { token, mode: 'preview' },
  });
  if (error) throw new Error(await readFunctionError(error));
  return data as InvitePreview;
}

/**
 * Two outcomes, because claiming a place is a request now (ADR-006).
 *
 * Joining as somebody new is immediate and comes back with a `memberId`.
 * Claiming a ghost comes back `pending`: an admin of the group has to agree,
 * and until they do the arrival is not in the group. Handing the place over on
 * request would let anybody holding the link inherit that name's whole
 * history.
 */
export type AcceptedInvite =
  | { group: { id: string; name: string }; memberId: string; claimed?: boolean }
  | {
      group: { id: string; name: string };
      pending: true;
      claimId: string;
      alreadyPending: boolean;
    };

export async function acceptInvite(input: {
  token: string;
  claimMemberId?: string | null;
  displayName?: string | null;
}): Promise<AcceptedInvite> {
  const { data, error } = await backend.functions.invoke('invite-accept', {
    body: { ...input, mode: 'join' },
  });
  if (error) throw new Error(await readFunctionError(error));
  return data as AcceptedInvite;
}

// ──────────────────────────── claiming somebody's place (ADR-006) ──

export interface PendingClaim {
  id: string;
  member_id: string;
  ghost_name: string | null;
  requester_name: string | null;
  requested_name: string | null;
  created_at: string;
}

/** What an admin of this group has been asked. Empty for everybody else. */
export async function fetchMemberClaims(groupId: string): Promise<PendingClaim[]> {
  const { data, error } = await backend.rpc('waves_group_member_claims', { p_group_id: groupId });
  if (error) throw new Error(error.message);
  return (data ?? []) as PendingClaim[];
}

/**
 * An admin answering. Approving is the claim itself — one UPDATE inside the
 * function moves the ghost row to the person, so nothing is copied and every
 * share and settlement filed against that name comes with it.
 */
export async function decideMemberClaim(
  claimId: string,
  approve: boolean,
): Promise<{ ok: boolean; reason?: string; status?: string }> {
  const { data, error } = await backend.rpc('waves_decide_member_claim', {
    p_claim_id: claimId,
    p_approve: approve,
  });
  if (error) throw new Error(error.message);
  return (data ?? { ok: false }) as { ok: boolean; reason?: string; status?: string };
}

export interface MyClaim {
  id: string;
  group_id: string;
  group_name: string | null;
  ghost_name: string | null;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  created_at: string;
  decided_at: string | null;
}

/** Carries the group's name: somebody still waiting cannot read the group. */
export async function fetchMyClaims(): Promise<MyClaim[]> {
  const { data, error } = await backend.rpc('waves_my_member_claims');
  if (error) throw new Error(error.message);
  return (data ?? []) as MyClaim[];
}

/** The way out of waiting on an admin who never opens the app. */
export async function withdrawMemberClaim(claimId: string): Promise<boolean> {
  const { data, error } = await backend.rpc('waves_withdraw_member_claim', {
    p_claim_id: claimId,
  });
  if (error) throw new Error(error.message);
  return (data as { ok?: boolean } | null)?.ok === true;
}

/** Links are revocable at any time (ADR-006). */
export async function revokeInvite(inviteId: string): Promise<void> {
  const { error } = await backend
    .from('invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', inviteId);
  if (error) throw new Error(error.message);
}

/**
 * The group's durable join link (WhatsApp-style): a stable, re-showable token,
 * made on first use. Any member may fetch it; it is the same token on every call
 * while it is live, so the QR is stable across opens and devices.
 */
export async function ensureGroupJoinToken(groupId: string): Promise<string> {
  const { data, error } = await backend.rpc('waves_ensure_group_join_token', {
    p_group_id: groupId,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Rotate the durable link (admin only) — the old QR and every shared copy die. */
export async function resetGroupJoinToken(groupId: string): Promise<string> {
  const { data, error } = await backend.rpc('waves_reset_group_join_token', {
    p_group_id: groupId,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

// ──────────────────────────────────────── export (ADR-012) ──

export interface ExportResult {
  filename: string;
  contentType: string;
  content: string;
  /** 'base64' when `content` is binary (PDF); text formats omit it. */
  encoding?: 'utf8' | 'base64';
}

export async function exportData(input: {
  groupId?: string;
  format: 'json' | 'csv' | 'pdf';
  csvSeparator?: string;
}): Promise<ExportResult> {
  const { data, error } = await backend.functions.invoke('export-data', { body: input });
  if (error) throw new Error(await readFunctionError(error));
  return data as ExportResult;
}

// ─────────────────────────────────── Splitwise import (ADR-012) ──

export interface ImportPerson {
  /** The column heading from the file, which is also the key used in each row. */
  name: string;
  /** An existing member to attribute this column to, or null to create a ghost. */
  memberId: string | null;
}

export interface ImportExpense {
  clientMutationId: string;
  description: string;
  category: string | null;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  currency: string;
  amount: bigint;
  payers: Record<string, bigint>;
  shares: Record<string, bigint>;
}

export interface ImportSettlement {
  clientMutationId: string;
  /** Display names, resolved to member ids server-side. */
  from: string;
  to: string;
  currency: string;
  amount: bigint;
  method: string;
  status: string;
  note?: string | null;
  /** ISO timestamp. */
  at: string;
}

export interface ImportResult {
  groupId: string;
  expenses: number;
  ghosts: number;
  settlements?: number;
  /** Of those, the ones that landed pending because somebody else on Waves has to confirm them. */
  settlementsPending?: number;
  members: Record<string, string>;
}

/**
 * Write a parsed file — a Splitwise export or one of ours — into a group.
 *
 * One RPC, so one transaction: a person moving four years of history cannot
 * tell a half-finished import from a complete one, because the balances add up
 * either way — they are just the balances of a smaller group that never
 * existed. Either every ghost and every row lands, or nothing does.
 *
 * `clientMutationId` per row makes a second tap on Import a replay rather than
 * a second copy (ADR-005), so generate them once and reuse them on retry.
 */
export async function importLedger(input: {
  groupId: string;
  people: ImportPerson[];
  expenses: ImportExpense[];
  /** Only a Waves export has these; a Splitwise file has no notion of them. */
  settlements?: ImportSettlement[];
  origin?: 'splitwise' | 'waves';
}): Promise<ImportResult> {
  const { data, error } = await backend.rpc('waves_import_ledger', {
    p_group_id: input.groupId,
    p_people: input.people,
    p_origin: input.origin ?? 'splitwise',
    p_settlements: (input.settlements ?? []).map((settlement) => ({
      clientMutationId: settlement.clientMutationId,
      from: settlement.from,
      to: settlement.to,
      currency: settlement.currency,
      amount: settlement.amount.toString(),
      method: settlement.method,
      status: settlement.status,
      note: settlement.note ?? null,
      at: settlement.at,
    })),
    // Minor units as strings all the way down: a number in JSON is a double,
    // and a double is how a paisa goes missing from a four-year history.
    p_expenses: input.expenses.map((expense) => ({
      clientMutationId: expense.clientMutationId,
      description: expense.description,
      category: expense.category,
      date: expense.date,
      currency: expense.currency,
      amount: expense.amount.toString(),
      payers: Object.fromEntries(
        Object.entries(expense.payers).map(([name, value]) => [name, value.toString()]),
      ),
      shares: Object.fromEntries(
        Object.entries(expense.shares).map(([name, value]) => [name, value.toString()]),
      ),
    })),
  });

  if (error) {
    const code = /^([A-Z_]+):/.exec(error.message)?.[1];
    throw new Error(
      code === 'NOT_A_MEMBER'
        ? 'You are not in that group'
        : code === 'NO_PEOPLE'
          ? 'That file named nobody to import'
          : error.message,
    );
  }
  return data as ImportResult;
}

// ─────────────────────────────── notification preferences (ADR-010) ──

export interface NotificationPrefs {
  /** Push only for things that involve me — the default that stops the spam. */
  involvesMe: boolean;
  groupActivityDigest: boolean;
  settlementRequests: boolean;
  nudges: boolean;
  weeklyEmail: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  involvesMe: true,
  groupActivityDigest: true,
  settlementRequests: true,
  nudges: true,
  weeklyEmail: false,
};

export async function fetchNotificationPrefs(profileId: string): Promise<NotificationPrefs> {
  const { data, error } = await backend
    .from('profiles')
    .select('notification_prefs')
    .eq('id', profileId)
    .single();
  if (error) throw new Error(error.message);
  return { ...DEFAULT_NOTIFICATION_PREFS, ...((data?.notification_prefs ?? {}) as object) };
}

export async function saveNotificationPrefs(
  profileId: string,
  prefs: NotificationPrefs,
): Promise<void> {
  const { error } = await backend
    .from('profiles')
    .update({ notification_prefs: prefs })
    .eq('id', profileId);
  if (error) throw new Error(error.message);
}

// ───────────────────────── turning a guest into a real account (ADR-006) ──
// You can use Waves without giving it anything. Adding an email or a phone
// number later is what makes the account reachable from a second device — it
// does not create a new account, so nothing entered as a guest is lost.

export enum ContactChannel {
  Email = 'email',
  Phone = 'phone',
}

/**
 * Attach a contact to the current (possibly anonymous) user. Supabase sends a
 * six-digit code; nothing changes until `confirmContact` verifies it.
 */
export async function startAddingContact(channel: ContactChannel, value: string): Promise<void> {
  // Normalised here rather than sent as typed. A number without a country code
  // is refused with a sentence somebody can act on, instead of whatever the
  // auth service says about it — and it is the same rule the invite columns
  // enforce in the database, so one form cannot accept what another rejects.
  const normalised = channel === 'email' ? normaliseEmail(value) : normalisePhone(value);
  const { error } =
    channel === 'email'
      ? await backend.auth.updateUser({ email: normalised })
      : await backend.auth.updateUser({ phone: normalised });
  if (error) throw new Error(describeAuthError(error.message, channel));
}

export async function confirmContact(
  channel: ContactChannel,
  value: string,
  token: string,
): Promise<void> {
  const normalised = channel === 'email' ? normaliseEmail(value) : normalisePhone(value);
  const { error } = await backend.auth.verifyOtp(
    channel === 'email'
      ? { email: normalised, token: token.trim(), type: 'email_change' }
      : { phone: normalised, token: token.trim(), type: 'phone_change' },
  );
  if (error) throw new Error(error.message);
}

/**
 * Both failures here are project configuration rather than anything the person
 * did wrong, and the raw messages ("Manual linking is disabled") would send
 * them looking for a mistake they did not make.
 */
function describeAuthError(message: string, channel: ContactChannel): string {
  if (/manual linking/i.test(message)) {
    return 'Linking a contact is switched off for this Waves server. Nothing is lost — carry on as a guest.';
  }
  if (channel === 'phone' && /provider|sms|not enabled|unsupported/i.test(message)) {
    return 'This Waves server cannot send SMS yet. Try an email address instead.';
  }
  return message;
}

// ─────────────────────────────── receipt scanning (ADR-008) ──

export interface ScanResult {
  receiptId: string;
  status: 'parsed' | 'needs_review';
  parsed: ParsedReceipt;
  check: ReceiptCheck;
  quota: { used: number; limit: number };
}

/**
 * Upload a receipt photo and have it read.
 *
 * The image goes to the private `receipts` bucket first so the model is fed by
 * the edge function rather than by a URL we hand out — and so a scan that fails
 * can be retried without asking the user to photograph the bill again.
 */
export async function scanReceipt(input: {
  groupId: string;
  base64: string;
  mimeType?: string | null;
  currency?: string;
}): Promise<ScanResult> {
  const receiptId = randomUUID();
  const mime = normaliseImageMime(input.mimeType);
  const path = `${input.groupId}/${receiptId}.${imageExt(mime)}`;

  await putImage({
    bucket: 'receipts',
    path,
    base64: input.base64,
    contentType: mime,
    groupId: input.groupId,
  });

  const { data, error } = await backend.functions.invoke('receipt-parse', {
    body: {
      groupId: input.groupId,
      receiptId,
      storagePath: path,
      source: 'camera',
      currency: input.currency ?? 'INR',
    },
  });
  if (error) throw new Error(await readFunctionError(error));
  return data as ScanResult;
}

/** A pasted Swiggy/Zomato/WhatsApp bill — no photograph involved. */
export async function scanReceiptText(input: {
  groupId: string;
  rawText: string;
  currency?: string;
  /**
   * Where the text came from. A photo read by on-device OCR is still a camera
   * scan — calling it a paste would quietly merge two different behaviours in
   * the usage metering.
   */
  source?: 'camera' | 'gallery' | 'text_paste';
}): Promise<ScanResult> {
  const { data, error } = await backend.functions.invoke('receipt-parse', {
    body: {
      groupId: input.groupId,
      rawText: input.rawText,
      source: input.source ?? 'text_paste',
      currency: input.currency ?? 'INR',
    },
  });
  if (error) throw new Error(await readFunctionError(error));
  return data as ScanResult;
}

export async function fetchScanQuota(): Promise<{
  used: number;
  limit: number;
  remaining: number;
}> {
  const { data, error } = await backend.rpc('waves_receipt_scan_quota');
  if (error) throw new Error(error.message);
  return data as { used: number; limit: number; remaining: number };
}

// ───────────────────────────────────────────── exchange rates ──

/**
 * Today's mid-market rate, as the exact rational that gets stored on the
 * expense.
 *
 * This can fail — no network, no published rate for the pair — and that is not
 * an error worth blocking on. Typing the rate always works, and for a card
 * transaction it is the more accurate answer anyway, because the bank's rate
 * includes a markup no reference rate will ever match.
 */
export async function fetchFxRate(from: string, to: string): Promise<FxRecord> {
  const { data, error } = await backend.functions.invoke(
    `fx-rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { method: 'GET' },
  );
  if (error) throw new Error(await readFunctionError(error));
  return data as FxRecord;
}

// ────────────────────────────────────── people you owe / who owe you ──

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
  /** Newest expense/settlement touching this person; null if none is visible. */
  last_activity_at: string | null;
}

/**
 * Every person you are not square with, across every group.
 *
 * One row per person *per currency* — a single total would need a rate nobody
 * chose (ADR-003) — and ghosts are never merged across groups, because a name
 * is not proof that two records are one human.
 */
export async function fetchPeopleBalances(): Promise<PersonBalanceRow[]> {
  const { data, error } = await backend.rpc('waves_people_i_owe');
  if (error) throw new Error(error.message);
  return (data ?? []) as PersonBalanceRow[];
}

/** One group's worth of a single person's balance, for the person-detail screen. */
export interface PersonGroupBalanceRow {
  group_id: string;
  group_name: string | null;
  cover_emoji: string | null;
  currency: string;
  /** Positive: they owe you in this group. Negative: you owe them. Minor units. */
  net: string;
  is_ghost: boolean;
  display_name: string;
}

/**
 * One person, un-collapsed: their balance in each group, so tapping somebody who
 * spans more than one group on the Friends list has somewhere to go. Same
 * identity and same viewer-scoped edges as {@link fetchPeopleBalances}; the
 * server keys on the same `person_key` the list rolls people up under.
 */
export async function fetchPersonGroupBalances(
  personKey: string,
): Promise<PersonGroupBalanceRow[]> {
  const { data, error } = await backend.rpc('waves_person_group_balances', {
    p_person_key: personKey,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as PersonGroupBalanceRow[];
}

/**
 * Fold a set of ghosts into one merged person for this viewer (Friends screen).
 *
 * A direct server RPC — the Friends balances are a server query, not the local
 * mirror, so there is nothing to queue offline. The merge is per-viewer and
 * never rewrites the ledger; see the `waves_merge_ghosts` migration for the
 * safety argument. `memberIds` must be at least two distinct ghosts you share a
 * group with; `name` is the merged person's name. Throws with the RPC's own
 * message so the caller can map it to something a person can read (see
 * `mergeErrorMessage`).
 */
export async function mergeGhosts(memberIds: string[], name: string): Promise<void> {
  const { error } = await backend.rpc('waves_merge_ghosts', {
    p_member_ids: memberIds,
    p_name: name,
  });
  if (error) throw new Error(error.message);
}

/**
 * Tap somebody who owes you on the shoulder about it (ADR-010).
 *
 * The server does the deciding: it only sends when they genuinely owe you in
 * this group and currency, at most once a day, and never to a ghost. All the
 * client passes is who, where, and in which currency — the amount and the
 * wording are the server's to keep honest. The `NUDGE_RATE_LIMIT` message that
 * comes back on a second nudge the same day is a normal outcome, not a fault,
 * and the screen says so gently rather than in red.
 */
export async function nudgeToSettle(input: {
  groupId: string;
  toMemberId: string;
  currency: string;
}): Promise<void> {
  const { error } = await backend.rpc('waves_nudge_to_settle', {
    p_group_id: input.groupId,
    p_to_member_id: input.toMemberId,
    p_currency: input.currency,
  });
  if (error) throw new Error(error.message);
}

// ─────────────────────────────────────────────── where the money went ──

export interface SpendingRow {
  member_id: string;
  currency: string;
  /** Always set — an expense with no category comes back as 'other'. */
  category: string;
  /** A custom tag's {label, icon, tint} snapshot when the category is a user
   *  tag (extends TDR §8), so insights can label and colour its bar. Absent from
   *  the server RPC's rows; only the local twin fills it. */
  category_meta?: CategoryMeta | null;
  /** First day of the month, 'YYYY-MM-DD'. */
  month: string;
  /** This member's share of that category, in minor units. */
  share_amount: string;
  expense_count: number;
}

/**
 * One group's spending, at the finest grain the charts need (TDR §8).
 *
 * Per member, per category, per month, per currency — deliberately not summed
 * server-side, because the same rows answer both "what did this group spend"
 * and "what did I spend", and the second cannot be recovered from the first.
 */
export async function fetchGroupSpending(groupId: string): Promise<SpendingRow[]> {
  const { data, error } = await backend.rpc('waves_group_spending', { p_group_id: groupId });
  if (error) throw new Error(error.message);
  return (data ?? []) as SpendingRow[];
}

// ────────────────────────────────────────── which builds may still run ──

export interface ReleaseRow {
  platform: string;
  latest_version: string;
  minimum_version: string;
  store_url: string;
  message: string | null;
}

/**
 * The version policy for one store.
 *
 * Readable signed out on purpose: this runs before the sign-in screen, because
 * a client too old to be trusted with the ledger is too old to sign in to it.
 */
export async function fetchReleasePolicy(platform: 'ios' | 'android'): Promise<ReleaseRow | null> {
  const { data, error } = await backend
    .from('app_releases')
    .select('platform, latest_version, minimum_version, store_url, message')
    .eq('platform', platform)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ReleaseRow | null) ?? null;
}

// ───────────────────────────────────────────── the trip plan (timeline) ──

export interface PlanItemRow {
  id: string;
  group_id: string;
  day: string;
  starts_at: string | null;
  title: string;
  note: string | null;
  category: string | null;
  planned_minor: string | null;
  currency: string;
  done_at: string | null;
  expense_id: string | null;
  position: number;
}

export async function fetchPlanItems(groupId: string): Promise<PlanItemRow[]> {
  const { data, error } = await backend
    .from('trip_plan_items')
    .select(
      'id, group_id, day, starts_at, title, note, category, planned_minor, currency, done_at, expense_id, position',
    )
    .eq('group_id', groupId)
    // Soft-deleted rows are tombstones for sync (ADR-005); a direct read wants
    // only what is live. The pull query stays unfiltered so it can propagate them.
    .is('deleted_at', null)
    .order('day', { ascending: true })
    .order('position', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlanItemRow[];
}

export async function addPlanItem(input: {
  groupId: string;
  day: string;
  title: string;
  startsAt?: string | null;
  note?: string | null;
  plannedMinor?: bigint | null;
  currency?: string | null;
  /** Chosen here so a retry after a dropped connection replays (ADR-005). */
  itemId?: string;
}): Promise<string> {
  const { data, error } = await backend.rpc('waves_add_plan_item', {
    p_group_id: input.groupId,
    p_day: input.day,
    p_title: input.title,
    p_starts_at: input.startsAt ?? null,
    p_note: input.note ?? null,
    p_category: null,
    p_planned_minor: input.plannedMinor?.toString() ?? null,
    p_currency: input.currency ?? null,
    p_item_id: input.itemId ?? randomUUID(),
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function setPlanItemDone(itemId: string, done: boolean): Promise<void> {
  const { error } = await backend.rpc('waves_update_plan_item', {
    p_item_id: itemId,
    p_done: done,
  });
  if (error) throw new Error(error.message);
}

export async function removePlanItem(itemId: string): Promise<void> {
  const { error } = await backend.rpc('waves_remove_plan_item', { p_item_id: itemId });
  if (error) throw new Error(error.message);
}

// ─────────────────────────────────────────────────────────── trip budgets ──

/**
 * A member's personal trip budget. The read is governed by RLS: a `private`
 * row belonging to somebody else is never returned here, so this list is
 * already what the caller is allowed to see — the client does no filtering of
 * its own, because a client that filtered would be trusted to, and it is not.
 */
export interface MemberBudgetRow {
  id: string;
  group_id: string;
  member_id: string;
  amount_minor: string;
  currency: string;
  visibility: 'private' | 'group';
}

export async function fetchMemberBudgets(groupId: string): Promise<MemberBudgetRow[]> {
  const { data, error } = await backend
    .from('trip_member_budgets')
    .select('id, group_id, member_id, amount_minor, currency, visibility')
    .eq('group_id', groupId)
    // Live budgets only; a cleared one is a soft-delete tombstone (ADR-005).
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  return (data ?? []) as MemberBudgetRow[];
}

/** The overall trip budget, read straight off the group. NULL amount is unset. */
export interface GroupBudget {
  amountMinor: bigint | null;
  currency: string | null;
}

export async function fetchGroupBudget(groupId: string): Promise<GroupBudget> {
  const { data, error } = await backend
    .from('groups')
    .select('budget_minor, budget_currency')
    .eq('id', groupId)
    .single();
  if (error) throw new Error(error.message);
  return {
    amountMinor: data?.budget_minor == null ? null : BigInt(data.budget_minor),
    currency: data?.budget_currency ?? null,
  };
}

/** Set or change the caller's own budget, and whether the group can see it. */
export async function setMyTripBudget(input: {
  groupId: string;
  amountMinor: bigint;
  currency?: string | null;
  visibility: 'private' | 'group';
}): Promise<void> {
  const { error } = await backend.rpc('waves_set_my_trip_budget', {
    p_group_id: input.groupId,
    p_amount_minor: input.amountMinor.toString(),
    p_currency: input.currency ?? null,
    p_visibility: input.visibility,
  });
  if (error) throw new Error(error.message);
}

export async function clearMyTripBudget(groupId: string): Promise<void> {
  const { error } = await backend.rpc('waves_clear_my_trip_budget', { p_group_id: groupId });
  if (error) throw new Error(error.message);
}

/** Admin only, enforced in the RPC. NULL amount clears the overall budget. */
export async function setGroupBudget(input: {
  groupId: string;
  amountMinor: bigint | null;
  currency?: string | null;
}): Promise<void> {
  const { error } = await backend.rpc('waves_set_group_budget', {
    p_group_id: input.groupId,
    p_amount_minor: input.amountMinor == null ? null : input.amountMinor.toString(),
    p_currency: input.currency ?? null,
  });
  if (error) throw new Error(error.message);
}

// ──────────────────────────────── splitting one bill from several phones ──

export interface ItemClaimRow {
  item_index: number;
  member_id: string;
  revision: number;
}

/**
 * Who has claimed what on a scanned bill, right now.
 *
 * Released claims are left out: a tombstone is evidence that somebody let a
 * line go, which is not the same as never having taken it, and the CRDT needs
 * the difference even though the screen does not.
 */
export async function fetchItemClaims(receiptId: string): Promise<ItemClaimRow[]> {
  const { data, error } = await backend.rpc('waves_item_claims', { p_receipt_id: receiptId });
  if (error) throw new Error(error.message);
  return (data ?? []) as ItemClaimRow[];
}

/**
 * Claim or release one line.
 *
 * `forMemberId` is left out for your own lines — the server resolves who you
 * are and will not take it as an argument. It is only ever sent for a ghost
 * member, who has no phone to tap with and no other way onto the bill.
 */
export async function setItemClaim(input: {
  receiptId: string;
  itemIndex: number;
  claimed: boolean;
  forMemberId?: string | null;
}): Promise<void> {
  const { error } = await backend.rpc('waves_set_item_claim', {
    p_receipt_id: input.receiptId,
    p_item_index: input.itemIndex,
    p_claimed: input.claimed,
    p_for_member_id: input.forMemberId ?? null,
  });
  if (error) throw new Error(error.message);
}

export interface OpenReceiptRow {
  id: string;
  created_at: string;
  parsed: ParsedReceipt | null;
  claimed: number;
  items: number;
}

/** The bills scanned in this group that nobody has turned into an expense yet. */
export async function fetchOpenReceipts(groupId: string): Promise<OpenReceiptRow[]> {
  const { data, error } = await backend.rpc('waves_open_receipts', { p_group_id: groupId });
  if (error) throw new Error(error.message);
  return (data ?? []) as OpenReceiptRow[];
}

/** One scanned bill, for the person who did not scan it. */
export async function fetchReceipt(
  receiptId: string,
): Promise<{ id: string; group_id: string; parsed: ParsedReceipt | null } | null> {
  const { data, error } = await backend
    .from('receipts')
    .select('id, group_id, parsed')
    .eq('id', receiptId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as { id: string; group_id: string; parsed: ParsedReceipt | null } | null;
}

/**
 * Hand the corrected lines to everybody else and open the bill for claiming.
 *
 * Refused once anybody has claimed, because a claim is stored against a line's
 * index — renumbering afterwards would move somebody else's dinner.
 */
export async function publishReceiptItems(
  receiptId: string,
  items: { label: string; total: number }[],
): Promise<void> {
  const { error } = await backend.rpc('waves_publish_receipt_items', {
    p_receipt_id: receiptId,
    p_items: items,
  });
  if (error) throw new Error(error.message);
}

// ────────────────────────────────────────────────── promotions ──

/**
 * What `waves_redeem_promo` answers with.
 *
 * Every wrong code comes back as a verdict rather than an exception, because
 * each one is a different sentence to say to somebody — expired is not the same
 * as already used, and neither is a crash. The only thing that raises is being
 * signed out, which is a bug in the caller.
 */
export type PromoOutcome =
  | { ok: true; tier: string; days: number; until: string }
  | { ok: false; reason: 'UNKNOWN_CODE' | 'EXPIRED' | 'EXHAUSTED' | 'ALREADY_REDEEMED' };

/**
 * Redeem a promotion code.
 *
 * The grant itself is written by the function, not from here: `subscriptions`
 * is not writable by a client, and a paywall a client can insert its own row
 * into is a paywall with a door in the back.
 */
export async function redeemPromoCode(code: string): Promise<PromoOutcome> {
  const { data, error } = await backend.rpc('waves_redeem_promo', { p_code: code });
  if (error) throw new Error(error.message);
  return data as PromoOutcome;
}

// ────────────────────────────────────── feedback, and leaving ──

/** A star rating is one of five whole values, or null when none was given. */
export type FeedbackRating = 1 | 2 | 3 | 4 | 5;

export async function submitFeedback(input: {
  message: string;
  kind: 'general' | 'bug' | 'idea';
  /** 1–5 where the person offered one; null when they wrote without rating. */
  rating: FeedbackRating | null;
  appVersion: string | null;
  platform: string;
}): Promise<void> {
  const { error } = await backend.rpc('waves_submit_feedback', {
    p_message: input.message,
    p_kind: input.kind,
    p_rating: input.rating,
    p_app_version: input.appVersion,
    p_platform: input.platform,
  });
  if (error) throw new Error(error.message);
}

export interface ErasurePreview {
  groups_count: number;
  expenses_authored: number;
  settlements_involved: number;
  outstanding_currencies: string[];
}

/** What erasure would leave behind, so the screen can say so before the button. */
export async function erasurePreview(): Promise<ErasurePreview | null> {
  const { data, error } = await backend.rpc('waves_my_erasure_preview');
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ErasurePreview[];
  return rows[0] ?? null;
}

/**
 * Erase the person, keep the ledger.
 *
 * Goes through the `account-delete` edge function rather than the RPC directly,
 * because the two halves of erasure need two different keys. The function runs
 * `waves_delete_my_account` as the caller — every membership becomes an unnamed
 * ghost, the profile and everything personal hanging off it is deleted — and
 * then removes the auth identity with the service key, which no client holds.
 * The RPC alone left an account that could still sign in to nothing; this does
 * not. The caller still signs out afterwards, and only after the data is gone.
 */
export async function deleteMyAccount(
  reason: string | null,
): Promise<{ memberships_anonymised?: number }> {
  const { data, error } = await backend.functions.invoke('account-delete', {
    body: { reason },
  });
  if (error) throw new Error(await readFunctionError(error));
  return (data ?? {}) as { memberships_anonymised?: number };
}

// ─────────────────────────────────────────────────────────────── devices ──

/**
 * Register (or refresh) this phone and learn where the account stands against
 * its device cap. The counting and the tier are the database's to decide — this
 * only reports the answer back up (`overLimit` drives the gate).
 */
export async function registerDevice(identity: DeviceIdentity): Promise<DeviceLimitStatus> {
  const { data, error } = await backend.rpc('waves_register_device', {
    p_device_id: identity.deviceId,
    p_label: identity.label,
    p_platform: identity.platform,
    p_app_version: identity.appVersion,
  });
  if (error) throw new Error(error.message);
  return data as DeviceLimitStatus;
}

/** The caller's devices seen in the last three months, newest first. */
export async function fetchDevices(): Promise<DeviceSession[]> {
  const { data, error } = await backend.rpc('waves_list_devices');
  if (error) throw new Error(error.message);
  return (data ?? []) as DeviceSession[];
}

/**
 * Mark every other device revoked in the table. The caller pairs this with
 * `backend.auth.signOut({ scope: 'others' })`, which tears down the actual
 * sessions; doing both keeps the devices list honest about what just happened.
 */
export async function signOutOtherDevices(currentDeviceId: string): Promise<number> {
  const { data, error } = await backend.rpc('waves_sign_out_other_devices', {
    p_device_id: currentDeviceId,
  });
  if (error) throw new Error(error.message);
  return (data ?? 0) as number;
}

/**
 * The country codes an operator has switched off (`country_settings`, a
 * denylist set from the admin console). Anon-readable on purpose, so the
 * phone-entry picker can filter its list before there is ever a session.
 *
 * A missing table or any failure yields an empty list — the picker then offers
 * every market the app stocks, which is exactly the denylist's own default, so
 * a first-run project or an offline phone is never locked out of phone sign-in.
 */
export async function disabledCountries(): Promise<string[]> {
  const { data, error } = await backend
    .from('country_settings')
    .select('code')
    .eq('enabled', false);
  if (error) return [];
  return (data ?? []).map((row) => (row as { code: string }).code);
}
