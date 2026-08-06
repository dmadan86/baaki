/**
 * Every read and write the app performs, in one file.
 *
 * Reads go straight to PostgREST — RLS decides what comes back, so there is no
 * "am I allowed?" check in the client (ADR-013). Writes that touch money go
 * through the `expense-write` edge function or a SECURITY DEFINER RPC, because
 * the server must own share computation and authorization (TDR §4).
 */

import { decode } from 'base64-arraybuffer';
import { randomUUID } from 'expo-crypto';

import {
  serialiseSplitParams,
  type FxRecord,
  type ParsedReceipt,
  type ReceiptCheck,
  type SplitParams,
} from '@baaki/core';

import { supabase } from '@/lib/supabase';
import type {
  ActivityGroup,
  ActivityRow,
  BalanceRow,
  ExpenseRow,
  GroupRow,
  GroupType,
  MemberRow,
  SettlementMethod,
  SettlementRow,
} from './types';

const MEMBER_SELECT = `
  id, group_id, profile_id, ghost_name, role, vpa, left_at,
  profile:profiles ( id, display_name, avatar_url, default_vpa )
`;

const EXPENSE_SELECT = `
  id, group_id, deleted_at, created_at,
  currentVersion:expense_versions!expenses_current_version_id_fkey (
    id, version_no, description, category, expense_date, currency, amount,
    split_type, split_params, author_member_id, notes, created_at,
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
    await supabase
      .from('groups')
      .select(
        'id, name, type, default_currency, simplify_debts, cover_emoji, photo_path, archived_at, created_at',
      )
      .is('archived_at', null)
      .order('created_at', { ascending: false }),
  );
}

export async function fetchGroup(groupId: string): Promise<GroupRow> {
  return unwrap(
    await supabase
      .from('groups')
      .select(
        'id, name, type, default_currency, simplify_debts, cover_emoji, photo_path, archived_at, created_at',
      )
      .eq('id', groupId)
      .single(),
  );
}

export async function fetchMembers(groupId: string): Promise<MemberRow[]> {
  return unwrap(
    await supabase
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
  let query = supabase
    .from('expenses')
    .select(EXPENSE_SELECT)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false });
  if (!options.includeDeleted) query = query.is('deleted_at', null);
  return unwrap(await query) as unknown as ExpenseRow[];
}

export async function fetchSettlements(groupId: string): Promise<SettlementRow[]> {
  return unwrap(
    await supabase
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
    await supabase
      .from('activity_log')
      .select(
        `id, group_id, actor_member_id, verb, object_type, object_id, payload, created_at,
         actor:group_members!activity_log_actor_member_id_fkey (
           id, profile_id, ghost_name, profile:profiles ( display_name )
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
    await supabase
      .from('activity_log')
      .select(
        `id, group_id, actor_member_id, verb, object_type, object_id, payload, created_at,
         group:groups ( id, name, cover_emoji ),
         actor:group_members!activity_log_actor_member_id_fkey (
           id, profile_id, ghost_name, profile:profiles ( display_name )
         )`,
      )
      .order('created_at', { ascending: false })
      .limit(limit),
  ) as unknown as (ActivityRow & { group: ActivityGroup | null })[];
}

/**
 * The server's own balances. The client recomputes the same numbers from the
 * expense rows with @baaki/core and compares — a mismatch means something is
 * wrong and the user is told, rather than shown a plausible wrong number.
 */
export async function fetchBalances(groupId: string): Promise<BalanceRow[]> {
  return unwrap(
    await supabase
      .from('group_balances')
      .select('group_id, member_id, currency, balance')
      .eq('group_id', groupId),
  );
}

export async function fetchAllBalances(): Promise<BalanceRow[]> {
  return unwrap(
    await supabase.from('group_balances').select('group_id, member_id, currency, balance'),
  );
}

/** Just my own balance in each group — one query for the home screen. */
export async function fetchMyBalances(profileId: string): Promise<BalanceRow[]> {
  const rows = unwrap(
    await supabase
      .from('group_balances')
      .select('group_id, member_id, currency, balance, member:group_members!inner ( profile_id )')
      .eq('member.profile_id', profileId),
  ) as unknown as (BalanceRow & { member: { profile_id: string } })[];
  return rows.map(({ member: _member, ...row }) => row);
}

/** Groups with a settlement still waiting on someone to confirm (ADR-007). */
export async function fetchPendingSettlements(): Promise<{ group_id: string; id: string }[]> {
  return unwrap(
    await supabase.from('settlements').select('id, group_id').eq('status', 'initiated'),
  );
}

/**
 * Members of every group I am in, one query. Names as well as counts, because
 * a group with no name is labelled by the people in it (`groupLabel`) and the
 * home screen would otherwise have nothing to call it.
 */
export async function fetchMembersByGroup(): Promise<Map<string, MemberRow[]>> {
  const rows = unwrap(
    await supabase
      .from('group_members')
      .select(
        'id, group_id, profile_id, ghost_name, role, vpa, left_at, invite_email, invite_phone, profile:profiles ( id, display_name, avatar_url, default_vpa )',
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
}): Promise<string> {
  const { data, error } = await supabase.rpc('baaki_create_group', {
    p_name: input.name?.trim() || null,
    p_type: input.type,
    p_currency: input.currency,
    p_emoji: input.emoji ?? null,
    p_simplify: input.simplify ?? true,
    p_group_id: input.groupId ?? null,
    p_photo_path: input.photoPath ?? null,
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
  const path = `${input.groupId}/cover.${mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'}`;

  const { error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, decode(input.base64), { contentType: mime, upsert: true });
  if (error) throw new Error(error.message);

  const { error: linkError } = await supabase
    .from('groups')
    .update({ photo_path: path })
    .eq('id', input.groupId);
  if (linkError) throw new Error(linkError.message);

  return path;
}

/** Signed because the bucket is private — a group photo is not public data. */
export async function groupPhotoUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 60 * 60);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function removeGroupPhoto(groupId: string, path: string | null): Promise<void> {
  if (path) await supabase.storage.from(PHOTO_BUCKET).remove([path]);
  const { error } = await supabase.from('groups').update({ photo_path: null }).eq('id', groupId);
  if (error) throw new Error(error.message);
}

/** The bucket accepts three types; anything else is stored as JPEG. */
function normaliseImageMime(mimeType: string | null | undefined): string {
  if (mimeType === 'image/png' || mimeType === 'image/webp') return mimeType;
  return 'image/jpeg';
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
): Promise<string> {
  const { data, error } = await supabase.rpc('baaki_add_ghost_member', {
    p_group_id: groupId,
    p_name: name.trim() || null,
    p_member_id: null,
    p_email: contact.email?.trim() || null,
    p_phone: contact.phone?.trim() || null,
  });
  if (error) {
    // The database speaks in codes; surface them rather than a raw SQL string.
    const code = /^([A-Z_]+):/.exec(error.message)?.[1];
    throw new Error(
      code === 'PHONE_NEEDS_COUNTRY_CODE'
        ? 'That number needs a country code, like +91'
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
  /** The rate used, when this expense is not in the group's currency. */
  fx?: FxRecord | null;
  clientMutationId?: string;
}

export interface WriteExpenseResult {
  expenseId: string;
  versionId: string;
  versionNo: number;
  replayed?: boolean;
}

export async function writeExpense(input: WriteExpenseInput): Promise<WriteExpenseResult> {
  const { data, error } = await supabase.functions.invoke('expense-write', {
    body: {
      groupId: input.groupId,
      expenseId: input.expenseId,
      description: input.description,
      category: input.category ?? null,
      expenseDate: input.expenseDate,
      currency: input.currency,
      amount: input.amount.toString(),
      // Exact, adjustment and itemized splits hold minor units, and JSON has
      // no bigint — stringify throws on one rather than rounding it. Without
      // this an itemized bill could not be saved at all.
      splitParams: serialiseSplitParams(input.splitParams),
      participants: input.participants,
      payers: Object.fromEntries(
        Object.entries(input.payers).map(([id, value]) => [id, value.toString()]),
      ),
      expectedShares: input.expectedShares
        ? Object.fromEntries(
            Object.entries(input.expectedShares).map(([id, value]) => [id, value.toString()]),
          )
        : undefined,
      notes: input.notes ?? null,
      fx: input.fx ?? null,
      // Idempotency key: a retry after a flaky network must not double-post.
      clientMutationId: input.clientMutationId ?? randomUUID(),
    },
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
    try {
      const body = (await context.json()) as { code?: string; message?: string };
      if (body?.message) return body.code ? `${body.code}: ${body.message}` : body.message;
    } catch {
      /* fall through to the generic message */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const { error } = await supabase.rpc('baaki_delete_expense', { p_expense_id: expenseId });
  if (error) throw new Error(error.message);
}

export async function restoreExpense(expenseId: string): Promise<void> {
  const { error } = await supabase.rpc('baaki_restore_expense', { p_expense_id: expenseId });
  if (error) throw new Error(error.message);
}

export async function fetchExpenseVersions(expenseId: string) {
  return unwrap(
    await supabase
      .from('expense_versions')
      .select(
        'id, version_no, description, amount, currency, created_at, author_member_id, split_type',
      )
      .eq('expense_id', expenseId)
      .order('version_no', { ascending: false }),
  );
}

export async function recordSettlement(input: {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: bigint;
  method: SettlementMethod;
  currency?: string;
  note?: string | null;
  allocations?: { expenseId: string; amount: bigint }[];
  clientMutationId?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('baaki_record_settlement', {
    p_group_id: input.groupId,
    p_from_member_id: input.fromMemberId,
    p_to_member_id: input.toMemberId,
    p_amount: input.amount.toString(),
    p_method: input.method,
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
  const { error } = await supabase.rpc('baaki_confirm_settlement', {
    p_settlement_id: settlementId,
  });
  if (error) throw new Error(error.message);
}

export async function updateGroup(
  groupId: string,
  patch: Partial<{
    name: string | null;
    cover_emoji: string | null;
    photo_path: string | null;
    simplify_debts: boolean;
    default_currency: string;
    archived_at: string | null;
  }>,
): Promise<void> {
  const { error } = await supabase.from('groups').update(patch).eq('id', groupId);
  if (error) throw new Error(error.message);
}

/** Rename a ghost, or set a per-group VPA override on your own membership. */
export async function updateMember(
  memberId: string,
  patch: Partial<{ ghost_name: string; vpa: string | null }>,
): Promise<void> {
  const { error } = await supabase.from('group_members').update(patch).eq('id', memberId);
  if (error) throw new Error(error.message);
}

/** Leaving is a soft exit: history stays, the person stops accruing new shares. */
export async function leaveGroup(memberId: string): Promise<void> {
  const { error } = await supabase
    .from('group_members')
    .update({ left_at: new Date().toISOString() })
    .eq('id', memberId);
  if (error) throw new Error(error.message);
}

// ─────────────────────────────────────────────── invites (ADR-006) ──

export interface MintedInvite {
  inviteId: string;
  token: string;
  expiresAt: string;
  maxUses: number;
  groupName: string;
}

export async function mintInvite(groupId: string, expiresInDays = 7): Promise<MintedInvite> {
  const { data, error } = await supabase.functions.invoke('invite-mint', {
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
  const { data, error } = await supabase.functions.invoke('invite-accept', {
    body: { token, mode: 'preview' },
  });
  if (error) throw new Error(await readFunctionError(error));
  return data as InvitePreview;
}

export async function acceptInvite(input: {
  token: string;
  claimMemberId?: string | null;
  displayName?: string | null;
}): Promise<{ group: { id: string; name: string }; memberId: string; claimed?: boolean }> {
  const { data, error } = await supabase.functions.invoke('invite-accept', {
    body: { ...input, mode: 'join' },
  });
  if (error) throw new Error(await readFunctionError(error));
  return data as { group: { id: string; name: string }; memberId: string; claimed?: boolean };
}

/** Links are revocable at any time (ADR-006). */
export async function revokeInvite(inviteId: string): Promise<void> {
  const { error } = await supabase
    .from('invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', inviteId);
  if (error) throw new Error(error.message);
}

// ──────────────────────────────────────── export (ADR-012) ──

export interface ExportResult {
  filename: string;
  contentType: string;
  content: string;
}

export async function exportData(input: {
  groupId?: string;
  format: 'json' | 'csv';
  csvSeparator?: string;
}): Promise<ExportResult> {
  const { data, error } = await supabase.functions.invoke('export-data', { body: input });
  if (error) throw new Error(await readFunctionError(error));
  return data as ExportResult;
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
  const { data, error } = await supabase
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
  const { error } = await supabase
    .from('profiles')
    .update({ notification_prefs: prefs })
    .eq('id', profileId);
  if (error) throw new Error(error.message);
}

// ───────────────────────── turning a guest into a real account (ADR-006) ──
// You can use Baaki without giving it anything. Adding an email or a phone
// number later is what makes the account reachable from a second device — it
// does not create a new account, so nothing entered as a guest is lost.

export type ContactChannel = 'email' | 'phone';

/**
 * Attach a contact to the current (possibly anonymous) user. Supabase sends a
 * six-digit code; nothing changes until `confirmContact` verifies it.
 */
export async function startAddingContact(channel: ContactChannel, value: string): Promise<void> {
  const trimmed = value.trim();
  const { error } =
    channel === 'email'
      ? await supabase.auth.updateUser({ email: trimmed })
      : await supabase.auth.updateUser({ phone: trimmed });
  if (error) throw new Error(describeAuthError(error.message, channel));
}

export async function confirmContact(
  channel: ContactChannel,
  value: string,
  token: string,
): Promise<void> {
  const trimmed = value.trim();
  const { error } = await supabase.auth.verifyOtp(
    channel === 'email'
      ? { email: trimmed, token: token.trim(), type: 'email_change' }
      : { phone: trimmed, token: token.trim(), type: 'phone_change' },
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
    return 'Linking a contact is switched off for this Baaki server. Nothing is lost — carry on as a guest.';
  }
  if (channel === 'phone' && /provider|sms|not enabled|unsupported/i.test(message)) {
    return 'This Baaki server cannot send SMS yet. Try an email address instead.';
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
  const mime = input.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const path = `${input.groupId}/${receiptId}.${mime === 'image/png' ? 'png' : 'jpg'}`;

  const { error: uploadError } = await supabase.storage
    .from('receipts')
    .upload(path, decode(input.base64), { contentType: mime, upsert: true });
  if (uploadError) throw new Error(uploadError.message);

  const { data, error } = await supabase.functions.invoke('receipt-parse', {
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
  const { data, error } = await supabase.functions.invoke('receipt-parse', {
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
  const { data, error } = await supabase.rpc('baaki_receipt_scan_quota');
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
  const { data, error } = await supabase.functions.invoke(
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
}

/**
 * Every person you are not square with, across every group.
 *
 * One row per person *per currency* — a single total would need a rate nobody
 * chose (ADR-003) — and ghosts are never merged across groups, because a name
 * is not proof that two records are one human.
 */
export async function fetchPeopleBalances(): Promise<PersonBalanceRow[]> {
  const { data, error } = await supabase.rpc('baaki_people_i_owe');
  if (error) throw new Error(error.message);
  return (data ?? []) as PersonBalanceRow[];
}
