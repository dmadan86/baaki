/**
 * Reading local-first (ADR-005).
 *
 * "UI reads local-first, always" means the screen renders from the mirror plus
 * the queue, never from a network response. The sync engine is what eventually
 * changes the mirror; nothing here waits on a request, so a group opens at the
 * speed of SQLite whether or not there is any signal.
 */

import { useMemo } from 'react';

import {
  computeNetBalances,
  liveExpenses,
  materialiseExpenses,
  rowsFor,
  simplify,
  toExpenseSnapshot,
  type ExpenseSnapshot,
  type MemberId,
  type MirrorExpense,
  type SettlementSnapshot,
  type Transfer,
} from '@baaki/core';

import type { GroupRow, MemberRow, SettlementRow } from '@/data/types';

import { useSync } from './provider';

export interface LocalGroup {
  group: GroupRow | null;
  members: MemberRow[];
  expenses: MirrorExpense[];
  settlements: SettlementRow[];
  /** Rows we have locally that the server has not confirmed yet. */
  pending: number;
}

export function useLocalGroups(): GroupRow[] {
  const { mirror } = useSync();
  return useMemo(
    () =>
      (rowsFor(mirror, 'groups') as unknown as GroupRow[])
        .filter((group) => !group.archived_at)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [mirror],
  );
}

export function useLocalGroup(groupId: string): LocalGroup {
  const { mirror, queue } = useSync();

  return useMemo(() => {
    const group = (mirror.tables.groups[groupId] as unknown as GroupRow | undefined) ?? null;
    const members = (rowsFor(mirror, 'group_members', groupId) as unknown as MemberRow[]).filter(
      (member) => !member.left_at,
    );
    const settlements = rowsFor(mirror, 'settlements', groupId) as unknown as SettlementRow[];
    const expenses = materialiseExpenses(mirror, queue, { groupId });

    return {
      group,
      members,
      expenses,
      settlements,
      pending: queue.filter((item) => item.groupId === groupId).length,
    };
  }, [mirror, queue, groupId]);
}

export interface OfflineLedger {
  balances: Map<MemberId, bigint>;
  transfers: Transfer[];
  myMemberId: MemberId | null;
  myBalance: bigint;
  expenses: MirrorExpense[];
  members: MemberRow[];
  group: GroupRow | null;
  /** Unsynced mutations touching this group. */
  pending: number;
}

/**
 * The same numbers `useGroupLedger` computes online, from local data instead.
 * Both call the identical @baaki/core functions, so going offline changes what
 * the app knows — never what it calculates.
 */
export function useOfflineLedger(groupId: string, myProfileId: string | null): OfflineLedger {
  const local = useLocalGroup(groupId);

  return useMemo(() => {
    const currency = local.group?.default_currency ?? 'INR';

    const snapshots = liveExpenses(local.expenses)
      .map(toExpenseSnapshot)
      .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);

    const settlementSnapshots: SettlementSnapshot[] = local.settlements.map((row) => ({
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
    }));

    const net = computeNetBalances(snapshots, settlementSnapshots);
    const balances = net.get(currency) ?? new Map<MemberId, bigint>();
    const myMemberId =
      local.members.find((member) => member.profile_id === myProfileId)?.id ?? null;

    return {
      balances,
      transfers: simplify(new Map([[currency, balances]])),
      myMemberId,
      myBalance: myMemberId ? (balances.get(myMemberId) ?? 0n) : 0n,
      expenses: local.expenses,
      members: local.members,
      group: local.group,
      pending: local.pending,
    };
  }, [local, myProfileId]);
}
