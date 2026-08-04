/**
 * M0 fixture data.
 *
 * The screens are wired to real @baaki/core computations — shares, balances,
 * pairwise edges and simplification are all derived here, never hand-written —
 * so when M1 swaps this module for Supabase queries, the UI does not change.
 */

import {
  computeNetBalances,
  computePairwiseBalances,
  computeShares,
  simplify,
  type ExpenseSnapshot,
  type MemberId,
  type SettlementSnapshot,
  type SplitParams,
  type Transfer,
} from '@baaki/core';
import type { TintName } from '@baaki/ui';

export const ME: MemberId = 'm-madan';

export interface MockMember {
  id: MemberId;
  name: string;
  emoji?: string;
  ghost?: boolean;
  vpa?: string;
}

export interface MockExpenseInput {
  id: string;
  description: string;
  category: string;
  emoji: string;
  amount: bigint;
  date: string;
  payers: Record<MemberId, bigint>;
  participants: MemberId[];
  params?: SplitParams;
  deletedAt?: string | null;
}

export interface MockGroup {
  id: string;
  name: string;
  emoji: string;
  tint: TintName;
  type: 'trip' | 'home' | 'couple' | 'event' | 'other';
  currency: string;
  simplifyDebts: boolean;
  members: MockMember[];
  expenses: MockExpenseInput[];
  settlements: SettlementSnapshot[];
}

const goaMembers: MockMember[] = [
  { id: ME, name: 'Madan', emoji: '🙂', vpa: 'madan@okaxis' },
  { id: 'm-asha', name: 'Asha', vpa: 'asha@ybl' },
  { id: 'm-ravi', name: 'Ravi', vpa: 'ravi@okhdfcbank' },
  { id: 'm-priya', name: 'Priya', ghost: true },
];

const flatMembers: MockMember[] = [
  { id: ME, name: 'Madan', emoji: '🙂', vpa: 'madan@okaxis' },
  { id: 'm-karthik', name: 'Karthik', vpa: 'karthik@ybl' },
  { id: 'm-divya', name: 'Divya' },
];

const coupleMembers: MockMember[] = [
  { id: ME, name: 'Madan', emoji: '🙂' },
  { id: 'm-nila', name: 'Nila', vpa: 'nila@okicici' },
];

export const GROUPS: MockGroup[] = [
  {
    id: 'g-goa',
    name: 'Goa trip',
    emoji: '🏖️',
    tint: 'lilac',
    type: 'trip',
    currency: 'INR',
    simplifyDebts: true,
    members: goaMembers,
    expenses: [
      {
        id: 'e-goa-1',
        description: 'Beach shack dinner',
        category: 'Food',
        emoji: '🍤',
        amount: 428000n,
        date: '2026-07-28',
        payers: { [ME]: 428000n },
        participants: goaMembers.map((member) => member.id),
      },
      {
        id: 'e-goa-2',
        description: 'Villa, 2 nights',
        category: 'Stay',
        emoji: '🏡',
        amount: 1840000n,
        date: '2026-07-27',
        payers: { 'm-asha': 1840000n },
        participants: goaMembers.map((member) => member.id),
      },
      {
        id: 'e-goa-3',
        description: 'Scooter rental',
        category: 'Travel',
        emoji: '🛵',
        amount: 240000n,
        date: '2026-07-29',
        payers: { 'm-ravi': 140000n, [ME]: 100000n },
        participants: [ME, 'm-ravi', 'm-asha'],
      },
      {
        id: 'e-goa-4',
        description: 'Sunset cruise',
        category: 'Fun',
        emoji: '⛵',
        amount: 360000n,
        date: '2026-07-30',
        payers: { 'm-priya': 360000n },
        participants: goaMembers.map((member) => member.id),
      },
    ],
    settlements: [
      {
        id: 's-goa-1',
        from: 'm-ravi',
        to: ME,
        currency: 'INR',
        amount: 120000n,
        status: 'confirmed',
        at: '2026-07-31T09:15:00Z',
      },
      {
        id: 's-goa-2',
        from: 'm-asha',
        to: ME,
        currency: 'INR',
        amount: 50000n,
        status: 'initiated',
        at: '2026-08-02T18:40:00Z',
      },
    ],
  },
  {
    id: 'g-flat',
    name: 'Flat 3B',
    emoji: '🏠',
    tint: 'mint',
    type: 'home',
    currency: 'INR',
    simplifyDebts: false,
    members: flatMembers,
    expenses: [
      {
        id: 'e-flat-1',
        description: 'Electricity bill',
        category: 'Bills',
        emoji: '💡',
        amount: 312500n,
        date: '2026-08-01',
        payers: { 'm-karthik': 312500n },
        participants: flatMembers.map((member) => member.id),
      },
      {
        id: 'e-flat-2',
        description: 'Groceries',
        category: 'Food',
        emoji: '🛒',
        amount: 187300n,
        date: '2026-08-02',
        payers: { [ME]: 187300n },
        participants: flatMembers.map((member) => member.id),
      },
      {
        id: 'e-flat-3',
        description: 'Wifi',
        category: 'Bills',
        emoji: '📶',
        amount: 99900n,
        date: '2026-08-03',
        payers: { 'm-divya': 99900n },
        participants: flatMembers.map((member) => member.id),
      },
    ],
    settlements: [],
  },
  {
    id: 'g-nila',
    name: 'Nila & me',
    emoji: '💜',
    tint: 'pink',
    type: 'couple',
    currency: 'INR',
    simplifyDebts: false,
    members: coupleMembers,
    expenses: [
      {
        id: 'e-nila-1',
        description: 'Movie night',
        category: 'Fun',
        emoji: '🎬',
        amount: 96000n,
        date: '2026-08-03',
        payers: { 'm-nila': 96000n },
        participants: coupleMembers.map((member) => member.id),
      },
    ],
    settlements: [
      {
        id: 's-nila-1',
        from: ME,
        to: 'm-nila',
        currency: 'INR',
        amount: 48000n,
        status: 'confirmed',
        at: '2026-08-03T21:00:00Z',
      },
    ],
  },
];

/** Turn a fixture expense into the snapshot shape @baaki/core consumes. */
export function toSnapshot(group: MockGroup, expense: MockExpenseInput): ExpenseSnapshot {
  const shares = computeShares({
    amount: expense.amount,
    currency: group.currency,
    params: expense.params ?? { kind: 'equal' },
    participants: expense.participants,
    seed: expense.id,
  });
  return {
    id: expense.id,
    currency: group.currency,
    amount: expense.amount,
    payers: expense.payers,
    shares: Object.fromEntries(shares),
    date: expense.date,
    deletedAt: expense.deletedAt ?? null,
  };
}

export function groupSnapshots(group: MockGroup): ExpenseSnapshot[] {
  return group.expenses.map((expense) => toSnapshot(group, expense));
}

export function getGroup(groupId: string): MockGroup | undefined {
  return GROUPS.find((group) => group.id === groupId);
}

export function memberName(group: MockGroup, memberId: MemberId): string {
  if (memberId === ME) return 'You';
  return group.members.find((member) => member.id === memberId)?.name ?? 'Someone';
}

export function memberById(group: MockGroup, memberId: MemberId): MockMember | undefined {
  return group.members.find((member) => member.id === memberId);
}

export interface GroupLedger {
  balances: Map<MemberId, bigint>;
  myBalance: bigint;
  pending: bigint;
  transfers: Transfer[];
  snapshots: ExpenseSnapshot[];
}

export function ledgerFor(group: MockGroup): GroupLedger {
  const snapshots = groupSnapshots(group);
  const net = computeNetBalances(snapshots, group.settlements);
  const withPending = computeNetBalances(snapshots, group.settlements, { includePending: true });
  const balances = net.get(group.currency) ?? new Map<MemberId, bigint>();

  const pairwise = computePairwiseBalances(snapshots, group.settlements);
  const transfers = group.simplifyDebts
    ? simplify(net)
    : pairwise.map((edge) => ({
        from: edge.from,
        to: edge.to,
        currency: edge.currency,
        amount: edge.amount,
      }));

  const myBalance = balances.get(ME) ?? 0n;
  const myPending = (withPending.get(group.currency)?.get(ME) ?? 0n) - myBalance;

  return { balances, myBalance, pending: myPending, transfers, snapshots };
}

/** Net baaki across every group, in INR (single-currency for M0). */
export function overallBalance(): { net: bigint; owed: bigint; owing: bigint } {
  let owed = 0n;
  let owing = 0n;
  for (const group of GROUPS) {
    const { myBalance } = ledgerFor(group);
    if (myBalance > 0n) owed += myBalance;
    else owing += -myBalance;
  }
  return { net: owed - owing, owed, owing };
}

export interface ActivityEntry {
  id: string;
  groupId: string;
  groupName: string;
  emoji: string;
  title: string;
  subtitle: string;
  amount: bigint;
  currency: string;
  at: string;
  kind: 'expense' | 'settlement';
}

export function activityFeed(groupId?: string): ActivityEntry[] {
  const groups = groupId ? GROUPS.filter((group) => group.id === groupId) : GROUPS;
  const entries: ActivityEntry[] = [];

  for (const group of groups) {
    for (const expense of group.expenses) {
      const payer = Object.keys(expense.payers)[0] as MemberId | undefined;
      entries.push({
        id: expense.id,
        groupId: group.id,
        groupName: group.name,
        emoji: expense.emoji,
        title: expense.description,
        subtitle: `${memberName(group, payer ?? ME)} paid · ${group.name}`,
        amount: expense.amount,
        currency: group.currency,
        at: `${expense.date}T12:00:00Z`,
        kind: 'expense',
      });
    }
    for (const settlement of group.settlements) {
      entries.push({
        id: settlement.id,
        groupId: group.id,
        groupName: group.name,
        emoji: settlement.status === 'initiated' ? '⏳' : '✅',
        title: `${memberName(group, settlement.from)} paid ${memberName(group, settlement.to)}`,
        subtitle:
          settlement.status === 'initiated'
            ? `Waiting for confirmation · ${group.name}`
            : `Settled · ${group.name}`,
        amount: settlement.amount,
        currency: settlement.currency,
        at: settlement.at,
        kind: 'settlement',
      });
    }
  }

  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/** What `from` still owes `to`, per expense — feeds the settle sheet. */
export function receivablesBetween(group: MockGroup, from: MemberId, to: MemberId) {
  const snapshots = groupSnapshots(group);
  return snapshots
    .filter((snapshot) => !snapshot.deletedAt)
    .map((snapshot) => {
      const owes = BigInt(snapshot.shares[from] ?? 0n);
      const paidByTo = BigInt(snapshot.payers[to] ?? 0n);
      const share = paidByTo > 0n && owes > 0n ? (owes * paidByTo) / snapshot.amount : 0n;
      const expense = group.expenses.find((item) => item.id === snapshot.id);
      return {
        expenseId: snapshot.id,
        date: snapshot.date,
        amount: share,
        description: expense?.description ?? 'Expense',
        emoji: expense?.emoji ?? '🧾',
      };
    })
    .filter((receivable) => receivable.amount > 0n);
}
