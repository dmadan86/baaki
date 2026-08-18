/**
 * React Query hooks + the realtime bridge.
 *
 * Balances are computed twice on purpose: the server keeps trigger-maintained
 * `group_balances`, and the client recomputes the same thing from the expense
 * rows with @waves/core. They must agree. If they ever don't, `useGroupLedger`
 * reports it instead of quietly showing a number that might be wrong — trust in
 * the number is the product (ADR-004).
 */

import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';

import {
  computeNetBalances,
  computePairwiseBalances,
  ghostMerges,
  materialiseArchivedGroups,
  materialiseCaptures,
  materialiseExpenses,
  materialiseGroup,
  materialiseGroups,
  materialiseMemberBudgets,
  materialiseMembers,
  materialisePlanItems,
  materialiseSettlements,
  MutationKind,
  openCaptures,
  openPlanItems,
  overlayPending,
  rowsFor,
  simplify,
  SyncTable,
  type ExpenseSnapshot,
  type MemberId,
  type MirrorExpense,
  type SettlementSnapshot,
  type Transfer,
} from '@waves/core';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { syncEngine, useSync } from '@/sync';
import {
  createGroup,
  disputeExpense,
  fetchAllBalances,
  fetchBalances,
  fetchExpenseVersions,
  fetchDisputes,
  fetchItemClaims,
  fetchOpenReceipts,
  fetchReceipt,
  fetchGroupSpending,
  fetchNotifications,
  fetchMemberClaims,
  decideMemberClaim,
  type PlanItemRow,
  type MemberBudgetRow,
  type GroupBudget,
  markNotificationsRead,
  recordSettlement,
  resolveDispute,
  leaveGroup,
  updateGroup,
  updateMember,
  setMemberRole,
  withdrawDispute,
  type PersonBalanceRow,
  type WriteExpenseInput,
} from './api';
import {
  aggregatePeopleBalances,
  countOthersInGroup,
  type PersonContribution,
} from './peopleBalances';
import { totalsByCurrency } from './totals';
import { SettlementStatus } from './types';
import type {
  ActivityRow,
  CaptureRow,
  ExpenseRow,
  GroupRow,
  MemberRow,
  SettlementRow,
} from './types';

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
  memberClaims: (id: string) => ['group', id, 'member-claims'] as const,
  memberBudgets: (id: string) => ['group', id, 'member-budgets'] as const,
  groupBudget: (id: string) => ['group', id, 'budget'] as const,
};

/**
 * A mirror read, wearing the shape of a query.
 *
 * The screens were written against React Query objects, and there is no reason
 * for every one of them to learn a second vocabulary just because the rows now
 * come off the disk instead of the wire. `isLoading` means "the mirror has not
 * been read from SQLite yet" — a few milliseconds at launch — and never "we are
 * waiting for the network", because nothing here waits for the network.
 */
export interface LocalRead<T> {
  data: T;
  isLoading: boolean;
  isFetching: boolean;
  isError: false;
  refetch: () => void;
}

function useLocalRead<T>(data: T): LocalRead<T> {
  const { hydrated, status, flush } = useSync();
  return {
    data,
    isLoading: !hydrated,
    isFetching: status === 'syncing',
    isError: false,
    refetch: () => void flush(),
  };
}

/**
 * ADR-005: the UI reads local-first, always.
 *
 * These used to be network queries, and the app was offline-first in name only
 * — the queue and the mirror were built and nothing read from them, so a phone
 * with no signal opened on an empty ledger. Rows now come from the mirror the
 * sync engine maintains; the network's only job is to fill it.
 */
export function useGroups(): LocalRead<GroupRow[]> {
  const { mirror, queue } = useSync();
  const groups = useMemo(
    () => materialiseGroups(mirror, queue) as unknown as GroupRow[],
    [mirror, queue],
  );
  return useLocalRead(groups);
}

/**
 * The archived groups, read local-first like everything else (ADR-005). These
 * are the groups `useGroups` hides; the archived screen is their only way back
 * into view, and unarchiving one (an ordinary group.update clearing
 * `archived_at`) drops it out of this list and back into `useGroups` at once.
 */
export function useArchivedGroups(): LocalRead<GroupRow[]> {
  const { mirror, queue } = useSync();
  const groups = useMemo(
    () => materialiseArchivedGroups(mirror, queue) as unknown as GroupRow[],
    [mirror, queue],
  );
  return useLocalRead(groups);
}

/**
 * The server's own derived balances. Deliberately still a network read and
 * deliberately never rendered: this is the independent second opinion that
 * `useGroupLedger` checks its arithmetic against (ADR-004). Reading it from the
 * mirror would make it agree with the local computation by construction, which
 * is the one thing a cross-check must not do.
 */
export function useAllBalances() {
  return useQuery({ queryKey: keys.allBalances, queryFn: fetchAllBalances });
}

/**
 * How much has changed hands through this person, per currency. Not a balance
 * — see `fetchSettledTotals`.
 */
export function useSettledTotals(profileId: string | null): LocalRead<Map<string, bigint>> {
  const { mirror } = useSync();

  const totals = useMemo(() => {
    const mine = new Set(
      (rowsFor(mirror, SyncTable.GroupMembers) as unknown as MemberRow[])
        .filter((member) => member.profile_id === profileId)
        .map((member) => member.id),
    );

    const out = new Map<string, bigint>();
    for (const row of rowsFor(mirror, SyncTable.Settlements) as unknown as SettlementRow[]) {
      if (
        row.status !== SettlementStatus.Confirmed &&
        row.status !== SettlementStatus.AutoConfirmed
      )
        continue;
      if (!mine.has(row.from_member_id) && !mine.has(row.to_member_id)) continue;
      out.set(row.currency, (out.get(row.currency) ?? 0n) + BigInt(row.amount));
    }
    return out;
  }, [mirror, profileId]);

  return useLocalRead(totals);
}

/**
 * Home-screen data: my balance per group, member counts, pending confirmations.
 *
 * Every figure is computed here from mirrored rows rather than read from the
 * server's `group_balances`, so the home screen shows the same numbers with the
 * radio off as with it on — and an expense still sitting in the queue is
 * already in them, because `materialiseExpenses` replays the queue on top.
 */
export function useHomeSummary(profileId: string | null) {
  const { mirror, queue, hydrated, status, lastSyncedAt, flush } = useSync();

  const summary = useMemo(() => {
    const membersByGroup = new Map<string, MemberRow[]>();
    const byGroup = new Map<string, bigint>();
    // Which currency each of those balances is in. Without it the totals below
    // are a pile of numbers with no units.
    const currencyByGroup = new Map<string, string>();
    const awaiting = new Set<string>();

    for (const group of materialiseGroups(mirror, queue) as unknown as GroupRow[]) {
      const currency = group.default_currency ?? 'INR';
      membersByGroup.set(
        group.id,
        materialiseMembers(mirror, queue, { groupId: group.id }) as unknown as MemberRow[],
      );
      const settlements = materialiseSettlements(mirror, queue, {
        groupId: group.id,
      }) as unknown as SettlementRow[];

      const snapshots = materialiseExpenses(mirror, queue, { groupId: group.id })
        .map((expense) => toSnapshot(expense as unknown as ExpenseRow))
        .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);

      const net = computeNetBalances(snapshots, settlements.map(toSettlementSnapshot));
      const mine = (membersByGroup.get(group.id) ?? []).find(
        (member) => member.profile_id === profileId,
      );
      if (mine) {
        byGroup.set(group.id, net.get(currency)?.get(mine.id) ?? 0n);
        currencyByGroup.set(group.id, currency);
      }

      if (settlements.some((settlement) => settlement.status === SettlementStatus.Initiated)) {
        awaiting.add(group.id);
      }
    }

    const totals = totalsByCurrency(
      [...byGroup].map(
        ([groupId, balance]) => [currencyByGroup.get(groupId) ?? 'INR', balance] as const,
      ),
    );

    return { byGroup, membersByGroup, awaiting, totals };
  }, [mirror, queue, profileId]);

  return {
    balanceFor: (groupId: string) => summary.byGroup.get(groupId) ?? 0n,
    membersFor: (groupId: string) => summary.membersByGroup.get(groupId) ?? [],
    memberCountFor: (groupId: string) => summary.membersByGroup.get(groupId)?.length ?? 0,
    hasPending: (groupId: string) => summary.awaiting.has(groupId),
    totals: summary.totals,
    isLoading: !hydrated,
    isFetching: status === 'syncing',
    // The mirror hydrates from disk instantly (ADR-005), but that snapshot can
    // be behind the server — a settlement that cleared your debt may only exist
    // server-side until the session's first pull lands. Painting a confident,
    // colour-coded balance from stale local data means the card can read "you
    // owe" (red) and then flip once the sync reconciles — the exact jump the
    // hero skeleton exists to hide. So the balance is only trustworthy once the
    // first sync of the session has settled. `lastSyncedAt` is in-memory and
    // starts null each launch, so it marks *this session's* first success.
    //
    // Bounded, never a hang: the provider kicks one `flush` on mount, which
    // resolves to either `lastSyncedAt` set (success) or a can't-sync status
    // (offline/metered/error). In those states there is nothing better than the
    // local snapshot, so fall through and show it at once rather than shimmer
    // forever — local-first still wins whenever the network can't answer.
    pendingFirstSync:
      hydrated && lastSyncedAt === null && (status === 'idle' || status === 'syncing'),
    refetch: () => void flush(),
  };
}

/**
 * Newest activity per member in one group, approximated from the mirror: the
 * date of any expense they paid or shared, and the instant of any settlement
 * either side of. The RPC uses expense-version `created_at`; offline the finest
 * timestamp the mirror holds for an expense is its date, which is enough for the
 * "recent activity" sort — it never feeds a balance.
 */
function lastActivityByMember(
  snapshots: readonly ExpenseSnapshot[],
  settlements: readonly SettlementSnapshot[],
): Map<string, string> {
  const latest = new Map<string, string>();
  const bump = (memberId: string, ts: string): void => {
    const current = latest.get(memberId);
    if (current === undefined || ts > current) latest.set(memberId, ts);
  };
  for (const snapshot of snapshots) {
    if (snapshot.deletedAt) continue;
    for (const memberId of Object.keys(snapshot.payers)) bump(memberId, snapshot.date);
    for (const memberId of Object.keys(snapshot.shares)) bump(memberId, snapshot.date);
  }
  for (const settlement of settlements) {
    bump(settlement.from, settlement.at);
    bump(settlement.to, settlement.at);
  }
  return latest;
}

/**
 * How many people you share a group with, whatever the balance.
 *
 * `usePeopleBalances` drops anybody square with you, because a settled person is
 * not a debt. That makes an empty result ambiguous: it is returned both to
 * somebody who has nobody yet and to somebody who has ten friends and owes them
 * all nothing. Those are opposite situations and the Friends screen has to say
 * different things about them, so this counts the people rather than the debts.
 *
 * Counted by member row, not by person: a guest in two groups is two here. That
 * is fine for the only question asked of it — is this number zero — and avoids
 * pulling ghost-merge folding (A38) into a check that does not need it.
 */
export function useKnownPeopleCount(profileId: string | null): LocalRead<number> {
  const { mirror, queue } = useSync();

  const count = useMemo(() => {
    if (!profileId) return 0;
    let total = 0;
    for (const group of materialiseGroups(mirror, queue) as unknown as GroupRow[]) {
      const members = materialiseMembers(mirror, queue, {
        groupId: group.id,
      }) as unknown as MemberRow[];
      total += countOthersInGroup(members, profileId);
    }
    return total;
  }, [mirror, queue, profileId]);

  return useLocalRead(count);
}

/**
 * Who owes you and who you owe, across every group — from the mirror (ADR-005).
 *
 * The local-first twin of `baaki_people_i_owe` (A11/A36/A38). For each group the
 * viewer is in, the pairwise edge that touches them becomes one
 * {@link PersonContribution}; a mirrored ghost merge (A38) supplies the
 * `person_id` that folds a guest seen across groups; `aggregatePeopleBalances`
 * sums it to the same rows the RPC returns. Reading the overlaid rows means a
 * queued expense already counts. Gravatar is skipped offline (a hashed email the
 * client does not hold) — a missing photo falls back to initials, as it already
 * does.
 */
export function usePeopleBalances(profileId: string | null): LocalRead<PersonBalanceRow[]> {
  const { mirror, queue } = useSync();

  const rows = useMemo(() => {
    if (!profileId) return [];

    // member_id → the viewer's recorded merge for that ghost (A38).
    const mergeByMember = new Map(ghostMerges(mirror).map((merge) => [merge.member_id, merge]));

    const contributions: PersonContribution[] = [];
    for (const group of materialiseGroups(mirror, queue) as unknown as GroupRow[]) {
      const members = materialiseMembers(mirror, queue, {
        groupId: group.id,
      }) as unknown as MemberRow[];
      const me = members.find(
        (member) => member.profile_id === profileId && member.left_at === null,
      );
      if (!me) continue;
      const byId = new Map(members.map((member) => [member.id, member] as const));

      const snapshots = materialiseExpenses(mirror, queue, { groupId: group.id })
        .map((expense) => toSnapshot(expense as unknown as ExpenseRow))
        .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);
      const settlementSnapshots = (
        materialiseSettlements(mirror, queue, { groupId: group.id }) as unknown as SettlementRow[]
      ).map(toSettlementSnapshot);

      const activity = lastActivityByMember(snapshots, settlementSnapshots);
      const edges = computePairwiseBalances(snapshots, settlementSnapshots);

      for (const edge of edges) {
        // Keep only the edges I am on, oriented from my side: they owe me is
        // positive, I owe them is negative — the RPC's sign.
        let otherId: string;
        let net: bigint;
        if (edge.from === me.id) {
          otherId = edge.to;
          net = -edge.amount;
        } else if (edge.to === me.id) {
          otherId = edge.from;
          net = edge.amount;
        } else {
          continue;
        }

        const other = byId.get(otherId);
        if (!other) continue;
        const merge = mergeByMember.get(other.id);
        contributions.push({
          groupId: group.id,
          memberId: other.id,
          profileId: other.profile_id,
          displayName:
            other.profile?.display_name ?? merge?.display_name ?? other.ghost_name ?? 'Someone',
          avatarUrl: other.profile?.avatar_url ?? null,
          isGhost: other.profile_id === null,
          currency: edge.currency,
          net,
          lastActivityAt: activity.get(other.id) ?? null,
          mergePersonId: merge?.person_id ?? null,
        });
      }
    }

    return aggregatePeopleBalances(contributions);
  }, [mirror, queue, profileId]);

  return useLocalRead(rows);
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

/**
 * One group, entirely from the mirror.
 *
 * `balances` is the exception and stays a network read — it is the server's
 * independently derived answer, kept only so `useGroupLedger` can notice if the
 * two ever disagree. It is allowed to be absent; a group opens without it.
 */
export function useGroup(groupId: string) {
  const { mirror, queue } = useSync();

  const rows = useMemo(() => {
    const group =
      (materialiseGroups(mirror, queue).find((row) => row.id === groupId) as unknown as
        GroupRow | undefined) ?? null;
    const members = materialiseMembers(mirror, queue, { groupId }) as unknown as MemberRow[];
    const settlements = materialiseSettlements(mirror, queue, {
      groupId,
    }) as unknown as SettlementRow[];
    const activity = (
      rowsFor(mirror, SyncTable.ActivityLog, groupId) as unknown as ActivityRow[]
    ).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    // Server rows, and server rows with the queue replayed on top. Screens want
    // the second; anything checking what the server actually knows wants the
    // first, and conflating them is how a queued expense starts looking real
    // enough to reconcile against.
    const stored = (rowsFor(mirror, SyncTable.Expenses, groupId) as unknown as ExpenseRow[]).sort(
      (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    );
    const withPending = materialiseExpenses(mirror, queue, {
      groupId,
    }) as unknown as ExpenseRow[];

    return { group, members, settlements, activity, stored, withPending };
  }, [mirror, queue, groupId]);

  const group = useLocalRead(rows.group);
  const members = useLocalRead(rows.members);
  const settlements = useLocalRead(rows.settlements);
  const activity = useLocalRead(rows.activity);
  const expenses = useLocalRead(rows.stored);

  const balances = useQuery({
    queryKey: keys.balances(groupId),
    queryFn: () => fetchBalances(groupId),
    enabled: Boolean(groupId),
  });

  return {
    group,
    members,
    // `expenses.data` is what the server has; `expenses.rows` is what to render.
    expenses: { ...expenses, rows: rows.withPending },
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
 * A monotonic suffix so each realtime subscription gets its own channel topic.
 *
 * `supabase.channel(topic)` returns an *existing* channel when one with that
 * topic is still registered, and `removeChannel()` is async and fire-and-forget.
 * So a fast unmount → remount — which is exactly what React does when it freezes
 * a navigated-away screen and reconnects its effects on return — can hand the
 * new effect back the previous, still-subscribed channel; adding a
 * `postgres_changes` callback to an already-subscribed channel throws. A fresh
 * suffix on every mount sidesteps the reuse: the old channel is torn down by its
 * own cleanup while the new one is built clean and unsubscribed.
 */
let realtimeChannelSeq = 0;

/**
 * Live group channel (TDR §1). Any change to the group's rows pulls the group,
 * so a second device sees an expense without a manual refresh.
 *
 * It syncs rather than invalidates: the screen reads the mirror, so a query
 * marked stale would change nothing on it. Realtime's job here is to say "there
 * is something new", not to carry it — the row still arrives through sync,
 * which is the one path that also writes it to disk.
 */
export function useGroupRealtime(groupId: string): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!groupId) return;

    const channel = supabase
      .channel(`group:${groupId}:${++realtimeChannelSeq}`)
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

/**
 * Pull the group, and mark stale the few things still read over the network.
 *
 * Most of what a group screen shows now comes from the mirror, so the sync is
 * the part that matters; the invalidations cover what sync does not carry —
 * the server's cross-check balances, receipts, disputes and spending.
 */
export function invalidateGroup(queryClient: QueryClient, groupId: string): void {
  void syncEngine.flush({ groupIds: [groupId] });
  void queryClient.invalidateQueries({ queryKey: ['group', groupId] });
  void queryClient.invalidateQueries({ queryKey: keys.allBalances });
}

// ─────────────────────────────────────────────────────────── mutations ──

/**
 * bigint does not survive JSON, and the queue is JSON on disk. Amounts go as
 * decimal strings and come back exact — the one thing money may never do here
 * is round-trip through a float.
 */
function serialiseExpense(input: Omit<WriteExpenseInput, 'groupId'>): Record<string, unknown> {
  return {
    description: input.description.trim(),
    category: input.category ?? null,
    expenseDate: input.expenseDate,
    currency: input.currency,
    amount: input.amount.toString(),
    fx: input.fx ?? null,
    splitParams: input.splitParams,
    participants: input.participants,
    payers: Object.fromEntries(
      Object.entries(input.payers).map(([member, amount]) => [member, amount.toString()]),
    ),
    expectedShares: input.expectedShares
      ? Object.fromEntries(
          Object.entries(input.expectedShares).map(([member, share]) => [member, share.toString()]),
        )
      : undefined,
    notes: input.notes ?? null,
    paymentMethod: input.paymentMethod ?? null,
  };
}

/**
 * Every write below queues rather than calls.
 *
 * `mutate` persists the envelope to SQLite before it resolves and returns as
 * soon as it is on disk, so the screen can move on at the speed of the phone
 * and a force-kill on the next line still syncs. They used to call the RPCs
 * directly, which meant every one of them simply failed with no signal —
 * offline the app could read nothing and write nothing.
 *
 * The ids are generated here rather than by the database. A group has to have
 * an id the moment it exists, because the expenses queued behind it reference
 * it, and the server is told to use the one the client already chose.
 */
export function useCreateGroup() {
  const { mutate } = useSync();
  const { profile } = useAuth();
  return useMutation({
    mutationFn: async (input: Parameters<typeof createGroup>[0]) => {
      const groupId = input.groupId ?? randomUUID();
      // Always name the creator's membership id, even when the caller did not,
      // so any expense made in this group offline references a member that will
      // exist with this exact id once the create syncs (the server honours it).
      const creatorMemberId = input.creatorMemberId ?? randomUUID();
      await mutate(MutationKind.GroupCreate, groupId, {
        name: input.name?.trim() || null,
        type: input.type,
        currency: input.currency,
        emoji: input.emoji ?? null,
        simplify: input.simplify ?? true,
        photoPath: input.photoPath ?? null,
        country: input.country ?? null,
        creatorMemberId,
        creatorProfileId: profile?.id ?? null,
      });
      return groupId;
    },
  });
}

export function useWriteExpense(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: async (input: Omit<WriteExpenseInput, 'groupId'>) => {
      const expenseId = input.expenseId ?? randomUUID();
      await mutate(
        input.expenseId ? MutationKind.ExpenseUpdate : MutationKind.ExpenseCreate,
        groupId,
        {
          ...serialiseExpense(input),
          expenseId,
        },
      );
      return expenseId;
    },
  });
}

export function useDeleteExpense(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (expenseId: string) => mutate(MutationKind.ExpenseDelete, groupId, { expenseId }),
  });
}

export function useRestoreExpense(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (expenseId: string) => mutate(MutationKind.ExpenseRestore, groupId, { expenseId }),
  });
}

export function useRecordSettlement(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (input: Parameters<typeof recordSettlement>[0]) =>
      mutate(
        MutationKind.SettlementCreate,
        input.groupId,
        {
          // Chosen here so the overlay has a stable row to show while it waits.
          settlementId: randomUUID(),
          from: input.fromMemberId,
          to: input.toMemberId,
          amount: input.amount.toString(),
          // The enum only knows these four; `rail` carries the truth.
          method: (['upi', 'cash', 'bank', 'other'] as const).includes(
            input.rail as 'upi' | 'cash' | 'bank' | 'other',
          )
            ? input.rail
            : 'other',
          rail: input.rail,
          currency: input.currency ?? null,
          note: input.note ?? null,
          allocations: (input.allocations ?? []).map((allocation) => ({
            expenseId: allocation.expenseId,
            amount: allocation.amount.toString(),
          })),
        },
        input.clientMutationId,
      ),
  });
}

export function useConfirmSettlement(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (settlementId: string) =>
      mutate(MutationKind.SettlementTransition, groupId, { settlementId }),
  });
}

// ─────────────────────────────────────────────── captures / inbox (A34) ──
//
// A capture syncs under a *personal scope*: the owner's own user id sits where a
// group id normally would, so `mutate(kind, ownerId, …)` queues it in a
// per-user order and the server authorises it by ownership. Everything else —
// offline-first, replayed-on-top, force-kill-safe — is the same queue the group
// mutations use.

/** The inbox: this person's open, unassigned captures, newest first. */
export function useCaptures(): LocalRead<CaptureRow[]> {
  const { session } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const { mirror, queue } = useSync();
  const captures = useMemo(
    () =>
      ownerId
        ? (openCaptures(materialiseCaptures(mirror, queue, { ownerId })) as unknown as CaptureRow[])
        : [],
    [mirror, queue, ownerId],
  );
  return useLocalRead(captures);
}

export interface CaptureInput {
  captureId?: string;
  description: string;
  category?: string | null;
  expenseDate: string;
  currency: string;
  amount: bigint;
  notes?: string | null;
  photoPath?: string | null;
  rawText?: string | null;
  parsed?: Record<string, unknown> | null;
  /** 'cash' | 'credit' | 'debit' | 'forex' — how it was paid. Null until chosen. */
  paymentMethod?: string | null;
  /** Intended destination group; null means decide later. */
  targetGroupId?: string | null;
}

/** bigint → decimal string at the queue boundary, like `serialiseExpense`. */
function serialiseCapture(input: CaptureInput, captureId: string): Record<string, unknown> {
  return {
    captureId,
    description: input.description.trim(),
    category: input.category ?? null,
    expenseDate: input.expenseDate,
    currency: input.currency,
    amount: input.amount.toString(),
    notes: input.notes ?? null,
    photoPath: input.photoPath ?? null,
    rawText: input.rawText ?? null,
    parsed: input.parsed ?? null,
    paymentMethod: input.paymentMethod ?? null,
    targetGroupId: input.targetGroupId ?? null,
  };
}

export function useCreateCapture() {
  const { mutate } = useSync();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (input: CaptureInput) => {
      const ownerId = session?.user?.id;
      if (!ownerId) throw new Error('Sign in to capture an expense');
      const captureId = input.captureId ?? randomUUID();
      await mutate(MutationKind.CaptureCreate, ownerId, serialiseCapture(input, captureId));
      return captureId;
    },
  });
}

export function useUpdateCapture() {
  const { mutate } = useSync();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (input: CaptureInput & { captureId: string }) => {
      const ownerId = session?.user?.id;
      if (!ownerId) throw new Error('Sign in first');
      await mutate(MutationKind.CaptureUpdate, ownerId, serialiseCapture(input, input.captureId));
      return input.captureId;
    },
  });
}

export function useDeleteCapture() {
  const { mutate } = useSync();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (captureId: string) => {
      const ownerId = session?.user?.id;
      if (!ownerId) throw new Error('Sign in first');
      await mutate(MutationKind.CaptureDelete, ownerId, { captureId });
      return captureId;
    },
  });
}

/**
 * Close a capture once it has become a real expense. The expense is an ordinary
 * `expense.create` on the group's scope (the add-expense flow already made it);
 * this only marks the capture assigned, which removes it from the inbox.
 */
export function useAssignCapture() {
  const { mutate } = useSync();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (input: { captureId: string; groupId: string; expenseId: string }) => {
      const ownerId = session?.user?.id;
      if (!ownerId) throw new Error('Sign in first');
      await mutate(MutationKind.CaptureAssign, ownerId, {
        captureId: input.captureId,
        groupId: input.groupId,
        expenseId: input.expenseId,
      });
      return input.captureId;
    },
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
  const { mutate } = useSync();
  return useMutation({
    mutationFn: async (
      input: string | { name: string; email?: string | null; phone?: string | null },
    ) => {
      const person = typeof input === 'string' ? { name: input } : input;
      // Chosen here so the expenses queued behind this member can already name
      // them. Adding somebody and immediately splitting a bill with them is one
      // action to a person, and offline it has to work like one.
      const memberId = randomUUID();
      await mutate(MutationKind.MemberAddGhost, groupId, {
        memberId,
        name: person.name,
        email: 'email' in person ? (person.email ?? null) : null,
        phone: 'phone' in person ? (person.phone ?? null) : null,
      });
      return memberId;
    },
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
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (patch: Parameters<typeof updateGroup>[1]) =>
      mutate(MutationKind.GroupUpdate, groupId, patch as Record<string, unknown>),
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

/** Promote a member to admin, or demote back. Guards live in the RPC. */
export function useSetMemberRole(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: 'admin' | 'member' }) =>
      setMemberRole(memberId, role),
    onSuccess: () => invalidateGroup(queryClient, groupId),
  });
}

export function useLeaveGroup(groupId: string) {
  const queryClient = useQueryClient();
  const { forgetGroup } = useSync();
  return useMutation({
    mutationFn: leaveGroup,
    // Leaving hides the group server-side (RLS), so it can never be pulled again
    // to signal its removal — the client must forget it locally, or it lingers
    // on the dashboard forever. Purge the mirror first, then refresh what is left.
    onSuccess: async () => {
      await forgetGroup(groupId);
      invalidateGroup(queryClient, groupId);
    },
  });
}

/** The trip's plan, read from the mirror so it opens with no connection (A23). */
export function usePlanItems(groupId: string): LocalRead<PlanItemRow[]> {
  const { mirror, queue } = useSync();
  const items = useMemo(
    () =>
      openPlanItems(materialisePlanItems(mirror, queue, { groupId })) as unknown as PlanItemRow[],
    [mirror, queue, groupId],
  );
  return useLocalRead(items);
}

/**
 * Personal trip budgets for the group, from the mirror. RLS already decided
 * what the pull returned — the caller's own always, plus anybody who shared
 * theirs — so a private budget belonging to somebody else was never mirrored
 * and cannot leak. The caller's own pending set/clear is overlaid by member id.
 */
export function useMemberBudgets(groupId: string): LocalRead<MemberBudgetRow[]> {
  const { mirror, queue } = useSync();
  const { profile } = useAuth();
  const budgets = useMemo(() => {
    const myMemberId =
      (materialiseMembers(mirror, queue, { groupId }) as unknown as MemberRow[]).find(
        (member) => member.profile_id === profile?.id && member.left_at === null,
      )?.id ?? null;
    return materialiseMemberBudgets(mirror, queue, {
      groupId,
      myMemberId,
    }) as unknown as MemberBudgetRow[];
  }, [mirror, queue, groupId, profile?.id]);
  return useLocalRead(budgets);
}

/** The overall trip budget, read off the mirrored group row (ADR-005). */
export function useGroupBudget(groupId: string): LocalRead<GroupBudget> {
  const { mirror, queue } = useSync();
  const budget = useMemo(() => {
    // materialiseGroup (not materialiseGroups) so an archived trip still shows
    // its budget, and a queued group_budget.set on it is not filtered away.
    const group = materialiseGroup(mirror, queue, groupId) as unknown as GroupRow | undefined;
    const minor = group?.budget_minor;
    return {
      amountMinor: minor === null || minor === undefined ? null : BigInt(minor),
      currency: group?.budget_currency ?? null,
    } as GroupBudget;
  }, [mirror, queue, groupId]);
  return useLocalRead(budget);
}

/** Add a plan item, queued (A23). The client chooses the id so the overlay and
 *  the RPC's replay guard both key on it. */
export function useAddPlanItem(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (input: {
      day: string;
      title: string;
      startsAt?: string | null;
      note?: string | null;
      category?: string | null;
      plannedMinor?: bigint | null;
      currency?: string | null;
    }) =>
      mutate(MutationKind.PlanItemCreate, groupId, {
        itemId: randomUUID(),
        day: input.day,
        title: input.title,
        startsAt: input.startsAt ?? null,
        note: input.note ?? null,
        category: input.category ?? null,
        plannedMinor:
          input.plannedMinor === null || input.plannedMinor === undefined
            ? null
            : input.plannedMinor.toString(),
        currency: input.currency ?? null,
      }),
  });
}

/** Tick a plan item done or undone, queued. */
export function useSetPlanItemDone(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (input: { itemId: string; done: boolean }) =>
      mutate(MutationKind.PlanItemUpdate, groupId, { itemId: input.itemId, done: input.done }),
  });
}

/** Remove a plan item, queued (a soft delete server-side so it propagates). */
export function useRemovePlanItem(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (itemId: string) => mutate(MutationKind.PlanItemDelete, groupId, { itemId }),
  });
}

/** Set the caller's own trip budget, queued. */
export function useSetMyTripBudget(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (input: {
      amountMinor: bigint;
      currency?: string | null;
      visibility: 'private' | 'group';
    }) =>
      mutate(MutationKind.MemberBudgetSet, groupId, {
        amountMinor: input.amountMinor.toString(),
        currency: input.currency ?? null,
        visibility: input.visibility,
      }),
  });
}

/** Clear the caller's own trip budget, queued (soft delete server-side). */
export function useClearMyTripBudget(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: () => mutate(MutationKind.MemberBudgetClear, groupId, {}),
  });
}

/** Set (or clear, with a null amount) the overall trip budget, queued. Admin-only,
 *  enforced by the RPC the edge dispatches to. */
export function useSetGroupBudget(groupId: string) {
  const { mutate } = useSync();
  return useMutation({
    mutationFn: (input: { amountMinor: bigint | null; currency?: string | null }) =>
      mutate(MutationKind.GroupBudgetSet, groupId, {
        amountMinor: input.amountMinor === null ? null : input.amountMinor.toString(),
        currency: input.currency ?? null,
      }),
  });
}

// ────────────────────────── somebody asking to be somebody (ADR-006) ──

/**
 * Claims waiting on this group's admins.
 *
 * Every member asks and only admins get an answer — the function returns
 * nothing to anybody else — which is cheaper than teaching the screen who is
 * an admin, and cannot disagree with the database about it.
 */
export function useMemberClaims(groupId: string) {
  return useQuery({
    queryKey: keys.memberClaims(groupId),
    queryFn: () => fetchMemberClaims(groupId),
    enabled: groupId !== '',
  });
}

/**
 * Answering one.
 *
 * Members are invalidated alongside the claims because approving *is* the
 * claim: a ghost in the list has just become a person, and a screen still
 * showing "not joined yet" next to their name is showing something that
 * stopped being true in the same call.
 */
export function useDecideMemberClaim(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ claimId, approve }: { claimId: string; approve: boolean }) =>
      decideMemberClaim(claimId, approve),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.memberClaims(groupId) });
      invalidateGroup(queryClient, groupId);
    },
  });
}

// ──────────────────────────────── splitting one bill from several phones ──

/**
 * Who has claimed which line, kept live.
 *
 * Realtime rather than polling, because the whole point is four people round a
 * table watching each other's taps appear. `receipt_item_claims` has no
 * `group_id` to filter on, so the filter is the receipt — which is narrower
 * anyway: nobody needs to hear about a bill they are not looking at.
 */
export function useItemClaims(receiptId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!receiptId) return;
    const channel = supabase
      .channel(`receipt:${receiptId}:${++realtimeChannelSeq}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'receipt_item_claims',
          filter: `receipt_id=eq.${receiptId}`,
        },
        () => void queryClient.invalidateQueries({ queryKey: ['claims', receiptId] }),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [receiptId, queryClient]);

  return useQuery({
    queryKey: ['claims', receiptId],
    queryFn: () => fetchItemClaims(receiptId!),
    enabled: Boolean(receiptId),
  });
}

/** One scanned bill, for whoever did not scan it. */
export function useReceipt(receiptId: string | null) {
  return useQuery({
    queryKey: ['receipt', receiptId],
    queryFn: () => fetchReceipt(receiptId!),
    enabled: Boolean(receiptId),
  });
}

/** The bills in this group that are scanned but not yet split. */
export function useOpenReceipts(groupId: string) {
  return useQuery({
    queryKey: ['open-receipts', groupId],
    queryFn: () => fetchOpenReceipts(groupId),
    enabled: groupId !== '',
  });
}
