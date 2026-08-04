/**
 * Every read and write the app performs, in one file.
 *
 * Reads go straight to PostgREST — RLS decides what comes back, so there is no
 * "am I allowed?" check in the client (ADR-013). Writes that touch money go
 * through the `expense-write` edge function or a SECURITY DEFINER RPC, because
 * the server must own share computation and authorization (TDR §4).
 */

import { randomUUID } from 'expo-crypto';

import type { SplitParams } from '@baaki/core';

import { supabase } from '@/lib/supabase';
import type {
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
        'id, name, type, default_currency, simplify_debts, cover_emoji, archived_at, created_at',
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
        'id, name, type, default_currency, simplify_debts, cover_emoji, archived_at, created_at',
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
      .select('id, group_id, actor_member_id, verb, object_type, object_id, payload, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

/** Activity across every group the user can see — RLS does the filtering. */
export async function fetchRecentActivity(
  limit = 60,
): Promise<
  (ActivityRow & { group: { id: string; name: string; cover_emoji: string | null } | null })[]
> {
  return unwrap(
    await supabase
      .from('activity_log')
      .select(
        `id, group_id, actor_member_id, verb, object_type, object_id, payload, created_at,
         group:groups ( id, name, cover_emoji )`,
      )
      .order('created_at', { ascending: false })
      .limit(limit),
  ) as unknown as (ActivityRow & {
    group: { id: string; name: string; cover_emoji: string | null } | null;
  })[];
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

export async function fetchMemberCounts(): Promise<Map<string, number>> {
  const rows = unwrap(
    await supabase.from('group_members').select('group_id').is('left_at', null),
  ) as { group_id: string }[];
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1);
  return counts;
}

// ──────────────────────────────────────────────────────────── writes ──

export async function createGroup(input: {
  name: string;
  type: GroupType;
  currency: string;
  emoji?: string | null;
  simplify?: boolean;
}): Promise<string> {
  const { data, error } = await supabase.rpc('baaki_create_group', {
    p_name: input.name,
    p_type: input.type,
    p_currency: input.currency,
    p_emoji: input.emoji ?? null,
    p_simplify: input.simplify ?? true,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** ADR-006: a ghost is a real participant who simply hasn't joined yet. */
export async function addGhostMember(groupId: string, name: string): Promise<void> {
  const { error } = await supabase
    .from('group_members')
    .insert({ group_id: groupId, ghost_name: name.trim(), joined_via: 'ghost' });
  if (error) throw new Error(error.message);
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
      splitParams: input.splitParams,
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
