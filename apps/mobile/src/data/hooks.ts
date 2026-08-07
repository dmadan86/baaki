/**
 * React Query hooks + the realtime bridge.
 *
 * Balances are computed twice on purpose: the server keeps trigger-maintained
 * `group_balances`, and the client recomputes the same thing from the expense
 * rows with @baaki/core. They must agree. If they ever don't, `useGroupLedger`
 * reports it instead of quietly showing a number that might be wrong — trust in
 * the number is the product (ADR-004).
 */

import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  computeNetBalances,
  computePairwiseBalances,
  overlayPending,
  simplify,
  type ExpenseSnapshot,
  type MemberId,
  type MirrorExpense,
  type SettlementSnapshot,
  type Transfer,
} from '@baaki/core';

import { supabase } from '@/lib/supabase';
import { useSync } from '@/sync';
import {
  addGhostMember,
  confirmSettlement,
  createGroup,
  deleteExpense,
  disputeExpense,
  fetchActivity,
  fetchAllBalances,
  fetchBalances,
  fetchExpenseVersions,
  fetchDisputes,
  fetchExpenses,
  fetchGroup,
  fetchGroups,
  fetchGroupSpending,
  fetchMembersByGroup,
  fetchMembers,
  fetchMyBalances,
  fetchNotifications,
  fetchPendingSettlements,
  fetchSettlements,
  markNotificationsRead,
  recordSettlement,
  resolveDispute,
  leaveGroup,
  restoreExpense,
  updateGroup,
  updateMember,
  withdrawDispute,
  writeExpense,
  type WriteExpenseInput,
} from './api';
import type { ExpenseRow, MemberRow, SettlementRow } from './types';

export const keys = {
  groups: ['groups'] as const,
  allBalances: ['balances', 'all'] as const,
  group: (id: string) => ['group', id] as const,
  members: (id: string) => ['group', id, 'members'] as const,
  expenses: (id: string) => ['group', id, 'expenses'] as const,
  settlements: (id: string) => ['group', id, 'settlements'] as const,
  activity: (id: string) => ['group', id, 'activity'] as const,
  balances: (id: string) => ['group', id, 'balances'] as const,
  notifications: ['notifications'] as const,
  disputes: (id: string) => ['group', id, 'disputes'] as const,
  spending: (id: string) => ['group', id, 'spending'] as const,
};

export function useGroups() {
  return useQuery({ queryKey: keys.groups, queryFn: fetchGroups });
}

export function useAllBalances() {
  return useQuery({ queryKey: keys.allBalances, queryFn: fetchAllBalances });
}

/** Home-screen data: my balance per group, member counts, pending confirmations. */
export function useHomeSummary(profileId: string | null) {
  const balances = useQuery({
    queryKey: ['balances', 'mine', profileId],
    queryFn: () => fetchMyBalances(profileId as string),
    enabled: Boolean(profileId),
  });
  const members = useQuery({ queryKey: ['members', 'byGroup'], queryFn: fetchMembersByGroup });
  const pending = useQuery({
    queryKey: ['settlements', 'pending'],
    queryFn: fetchPendingSettlements,
  });

  const byGroup = new Map<string, bigint>();
  for (const row of balances.data ?? []) {
    byGroup.set(row.group_id, (byGroup.get(row.group_id) ?? 0n) + BigInt(row.balance));
  }

  let owed = 0n;
  let owing = 0n;
  for (const balance of byGroup.values()) {
    if (balance > 0n) owed += balance;
    else owing += -balance;
  }

  const pendingByGroup = new Set((pending.data ?? []).map((row) => row.group_id));

  return {
    balanceFor: (groupId: string) => byGroup.get(groupId) ?? 0n,
    membersFor: (groupId: string) => members.data?.get(groupId) ?? [],
    memberCountFor: (groupId: string) => members.data?.get(groupId)?.length ?? 0,
    hasPending: (groupId: string) => pendingByGroup.has(groupId),
    totals: { net: owed - owing, owed, owing },
    isLoading: balances.isLoading || members.isLoading,
    isFetching: balances.isFetching || members.isFetching || pending.isFetching,
    refetch: () => {
      void balances.refetch();
      void members.refetch();
      void pending.refetch();
    },
  };
}

/**
 * ADR-005: what the screen shows is the server's rows with the mutation queue
 * replayed on top. Without the overlay an expense the user just entered is
 * invisible until it syncs, which is indistinguishable from losing it.
 */
export function usePendingAware(groupId: string, expenses: ExpenseRow[]): ExpenseRow[] {
  const { queue } = useSync();
  return useMemo(
    () =>
      overlayPending(expenses as unknown as MirrorExpense[], queue, {
        groupId,
      }) as unknown as ExpenseRow[],
    [expenses, queue, groupId],
  );
}

export function useGroup(groupId: string) {
  const group = useQuery({
    queryKey: keys.group(groupId),
    queryFn: () => fetchGroup(groupId),
    enabled: Boolean(groupId),
  });
  const members = useQuery({
    queryKey: keys.members(groupId),
    queryFn: () => fetchMembers(groupId),
    enabled: Boolean(groupId),
  });
  const expenses = useQuery({
    queryKey: keys.expenses(groupId),
    queryFn: () => fetchExpenses(groupId),
    enabled: Boolean(groupId),
  });
  const settlements = useQuery({
    queryKey: keys.settlements(groupId),
    queryFn: () => fetchSettlements(groupId),
    enabled: Boolean(groupId),
  });
  const activity = useQuery({
    queryKey: keys.activity(groupId),
    queryFn: () => fetchActivity(groupId),
    enabled: Boolean(groupId),
  });
  const balances = useQuery({
    queryKey: keys.balances(groupId),
    queryFn: () => fetchBalances(groupId),
    enabled: Boolean(groupId),
  });

  const withPending = usePendingAware(groupId, expenses.data ?? []);

  return {
    group,
    members,
    // `expenses.data` is the server's answer; `expenses.rows` is what to render.
    expenses: { ...expenses, rows: withPending },
    settlements,
    activity,
    balances,
  };
}

export function toSnapshot(expense: ExpenseRow): ExpenseSnapshot | null {
  const version = expense.currentVersion;
  if (!version) return null;
  return {
    id: expense.id,
    currency: version.currency,
    amount: BigInt(version.amount),
    payers: Object.fromEntries(version.payers.map((row) => [row.member_id, BigInt(row.amount)])),
    shares: Object.fromEntries(version.shares.map((row) => [row.member_id, BigInt(row.amount)])),
    date: version.expense_date,
    deletedAt: expense.deleted_at,
  };
}

export function toSettlementSnapshot(row: SettlementRow): SettlementSnapshot {
  return {
    id: row.id,
    from: row.from_member_id,
    to: row.to_member_id,
    currency: row.currency,
    amount: BigInt(row.amount),
    status: row.status,
    at: row.initiated_at,
    allocations: row.allocations?.map((allocation) => ({
      expenseId: allocation.expense_id,
      amount: BigInt(allocation.amount),
    })),
  };
}

export interface GroupLedger {
  balances: Map<MemberId, bigint>;
  transfers: Transfer[];
  myMemberId: MemberId | null;
  myBalance: bigint;
  /** Difference the still-unconfirmed settlements would make (TDR §3.3). */
  pending: bigint;
  /** True when the server's stored balances disagree with our recomputation. */
  mismatch: boolean;
  loading: boolean;
}

export function useGroupLedger(groupId: string, myProfileId: string | null): GroupLedger {
  const { group, members, expenses, settlements, balances } = useGroup(groupId);

  return useMemo(() => {
    const loading =
      group.isLoading || members.isLoading || expenses.isLoading || settlements.isLoading;

    const currency = group.data?.default_currency ?? 'INR';
    const snapshots = expenses.rows
      .map(toSnapshot)
      .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);
    const settlementSnapshots = (settlements.data ?? []).map(toSettlementSnapshot);

    const net = computeNetBalances(snapshots, settlementSnapshots);
    const withPending = computeNetBalances(snapshots, settlementSnapshots, {
      includePending: true,
    });
    const computed = net.get(currency) ?? new Map<MemberId, bigint>();

    const myMemberId =
      (members.data ?? []).find((member) => member.profile_id === myProfileId)?.id ?? null;
    const myBalance = myMemberId ? (computed.get(myMemberId) ?? 0n) : 0n;
    const myPending = myMemberId
      ? (withPending.get(currency)?.get(myMemberId) ?? 0n) - myBalance
      : 0n;

    // Cross-check against what the database derived independently. Skipped
    // while anything is still queued: the server has not seen those expenses
    // yet, so a disagreement is expected rather than a problem to report.
    const anyPending = expenses.rows.some((expense) => expense.pending === true);
    let mismatch = false;
    if (balances.data && !anyPending) {
      const stored = new Map(
        balances.data
          .filter((row) => row.currency === currency)
          .map((row) => [row.member_id, BigInt(row.balance)] as const),
      );
      const everyone = new Set([...stored.keys(), ...computed.keys()]);
      for (const member of everyone) {
        if ((stored.get(member) ?? 0n) !== (computed.get(member) ?? 0n)) {
          mismatch = true;
          break;
        }
      }
    }

    const pairwise = computePairwiseBalances(snapshots, settlementSnapshots);
    const transfers = group.data?.simplify_debts
      ? simplify(net)
      : pairwise.map((edge) => ({
          from: edge.from,
          to: edge.to,
          currency: edge.currency,
          amount: edge.amount,
        }));

    return {
      balances: computed,
      transfers,
      myMemberId,
      myBalance,
      pending: myPending,
      mismatch,
      loading,
    };
  }, [
    group.data,
    group.isLoading,
    members.data,
    members.isLoading,
    expenses.rows,
    expenses.isLoading,
    settlements.data,
    settlements.isLoading,
    balances.data,
    myProfileId,
  ]);
}

/**
 * Live group channel (TDR §1). Any change to the group's rows invalidates the
 * affected queries, so a second device sees an expense without a manual pull.
 */
export function useGroupRealtime(groupId: string): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!groupId) return;

    const channel = supabase
      .channel(`group:${groupId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'expenses', filter: `group_id=eq.${groupId}` },
        () => invalidateGroup(queryClient, groupId),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'settlements', filter: `group_id=eq.${groupId}` },
        () => invalidateGroup(queryClient, groupId),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'group_members', filter: `group_id=eq.${groupId}` },
        () => invalidateGroup(queryClient, groupId),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'activity_log', filter: `group_id=eq.${groupId}` },
        () => invalidateGroup(queryClient, groupId),
      )
      // expense_versions/payers/shares have no group_id column to filter on;
      // the rows above always change alongside them, so this stays cheap.
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [groupId, queryClient]);
}

export function invalidateGroup(queryClient: QueryClient, groupId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['group', groupId] });
  void queryClient.invalidateQueries({ queryKey: keys.groups });
  void queryClient.invalidateQueries({ queryKey: keys.allBalances });
}

// ─────────────────────────────────────────────────────────── mutations ──

export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createGroup,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.groups });
    },
  });
}

export function useWriteExpense(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<WriteExpenseInput, 'groupId'>) => writeExpense({ ...input, groupId }),
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useDeleteExpense(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteExpense,
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useRestoreExpense(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restoreExpense,
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useRecordSettlement(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof recordSettlement>[0]) => recordSettlement(input),
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useConfirmSettlement(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: confirmSettlement,
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

/**
 * The inbox (TDR §7.1).
 *
 * Kept short and refetched rather than paginated: this is what Baaki has said
 * to you lately, not an archive. A read that goes back further than the last
 * fifty things is a report, not a notification list.
 */
export function useNotifications() {
  return useQuery({ queryKey: keys.notifications, queryFn: () => fetchNotifications() });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/**
 * Who has said an expense is wrong, across the group.
 *
 * Fetched per group rather than per expense so the list can mark the rows
 * without a query each. A disagreement nobody sees until they open the expense
 * is a disagreement that festers.
 */
/** Where one group's money went, per member, category, month and currency. */
export function useGroupSpending(groupId: string) {
  return useQuery({
    queryKey: keys.spending(groupId),
    queryFn: () => fetchGroupSpending(groupId),
    enabled: Boolean(groupId),
  });
}

export function useDisputes(groupId: string) {
  return useQuery({
    queryKey: keys.disputes(groupId),
    queryFn: () => fetchDisputes(groupId),
    enabled: Boolean(groupId),
  });
}

export function useDisputeExpense(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disputeExpense,
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useWithdrawDispute(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: withdrawDispute,
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useResolveDispute(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resolveDispute,
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useAddGhostMember(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: string | { name: string; email?: string | null; phone?: string | null }) =>
      typeof input === 'string'
        ? addGhostMember(groupId, input)
        : addGhostMember(groupId, input.name, { email: input.email, phone: input.phone }),
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function memberLookup(members: MemberRow[] | undefined): Map<MemberId, MemberRow> {
  return new Map((members ?? []).map((member) => [member.id, member]));
}

/** Full version history for one expense — the audit trail from ADR-004. */
export function useExpenseVersions(expenseId: string) {
  return useQuery({
    queryKey: ['expense', expenseId, 'versions'],
    queryFn: () => fetchExpenseVersions(expenseId),
    enabled: Boolean(expenseId),
  });
}

export function useUpdateGroup(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof updateGroup>[1]) => updateGroup(groupId, patch),
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useUpdateMember(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      memberId,
      patch,
    }: {
      memberId: string;
      patch: Parameters<typeof updateMember>[1];
    }) => updateMember(memberId, patch),
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useLeaveGroup(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: leaveGroup,
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}
