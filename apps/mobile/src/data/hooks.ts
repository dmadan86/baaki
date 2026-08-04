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
  simplify,
  type ExpenseSnapshot,
  type MemberId,
  type SettlementSnapshot,
  type Transfer,
} from '@baaki/core';

import { supabase } from '@/lib/supabase';
import {
  addGhostMember,
  confirmSettlement,
  createGroup,
  deleteExpense,
  fetchActivity,
  fetchAllBalances,
  fetchBalances,
  fetchExpenses,
  fetchGroup,
  fetchGroups,
  fetchMemberCounts,
  fetchMembers,
  fetchMyBalances,
  fetchPendingSettlements,
  fetchSettlements,
  recordSettlement,
  restoreExpense,
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
  const counts = useQuery({ queryKey: ['members', 'counts'], queryFn: fetchMemberCounts });
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
    memberCountFor: (groupId: string) => counts.data?.get(groupId) ?? 0,
    hasPending: (groupId: string) => pendingByGroup.has(groupId),
    totals: { net: owed - owing, owed, owing },
    isLoading: balances.isLoading || counts.isLoading,
    isFetching: balances.isFetching || counts.isFetching || pending.isFetching,
    refetch: () => {
      void balances.refetch();
      void counts.refetch();
      void pending.refetch();
    },
  };
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

  return { group, members, expenses, settlements, activity, balances };
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
    const snapshots = (expenses.data ?? [])
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

    // Cross-check against what the database derived independently.
    let mismatch = false;
    if (balances.data) {
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
    expenses.data,
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

export function useAddGhostMember(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => addGhostMember(groupId, name),
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function memberLookup(members: MemberRow[] | undefined): Map<MemberId, MemberRow> {
  return new Map((members ?? []).map((member) => [member.id, member]));
}
