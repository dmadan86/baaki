/**
 * Rows into balances.
 *
 * Not a second implementation. Every number here comes out of @waves/core,
 * which is the same code the app and the edge functions run — the whole reason
 * `packages/core` is forbidden to depend on React or Supabase (TDR §1). If a
 * guest's browser and the payer's phone ever disagreed about who owes what,
 * one of them would be lying to somebody about their money, and there would be
 * no way to say which.
 *
 * What this file does add is the conversion: PostgREST hands back minor units
 * as decimal strings, and they become bigints here rather than anywhere a
 * `Number` could get near them (ADR-003).
 */

import {
  computeNetBalances,
  simplify,
  type CurrencyCode,
  type ExpenseSnapshot,
  type MemberId,
  type SettlementSnapshot,
  type Transfer,
} from '@waves/core';

import type { Expense, Settlement } from './types';

export interface GroupLedger {
  /** memberId → net position in the group's currency. Positive: they are owed. */
  balances: Map<MemberId, bigint>;
  /** Who should pay whom to end up square (ADR-009). */
  transfers: Transfer[];
}

export function toExpenseSnapshot(expense: Expense): ExpenseSnapshot | null {
  const version = expense.currentVersion;
  if (!version) return null;
  return {
    id: expense.id,
    currency: version.currency as CurrencyCode,
    amount: BigInt(version.amount),
    payers: Object.fromEntries(version.payers.map((row) => [row.member_id, BigInt(row.amount)])),
    shares: Object.fromEntries(version.shares.map((row) => [row.member_id, BigInt(row.amount)])),
    date: version.expense_date,
    deletedAt: expense.deleted_at,
  };
}

export function toSettlementSnapshot(settlement: Settlement): SettlementSnapshot {
  return {
    id: settlement.id,
    from: settlement.from_member_id,
    to: settlement.to_member_id,
    currency: settlement.currency as CurrencyCode,
    amount: BigInt(settlement.amount),
    status: settlement.status as SettlementSnapshot['status'],
    at: settlement.initiated_at,
    allocations: settlement.allocations?.map((row) => ({
      expenseId: row.expense_id,
      amount: BigInt(row.amount),
    })),
  };
}

export function computeLedger(
  expenses: readonly Expense[],
  settlements: readonly Settlement[],
  currency: string,
): GroupLedger {
  const snapshots = expenses
    .map(toExpenseSnapshot)
    .filter((snapshot): snapshot is ExpenseSnapshot => snapshot !== null);

  const balances = computeNetBalances(snapshots, settlements.map(toSettlementSnapshot));

  return {
    // One currency is shown, because a guest link opens one group and a group
    // has one default. Anything in another currency still counts in core's
    // answer; it is simply not this view's job to add them together (ADR-003).
    balances: balances.get(currency as CurrencyCode) ?? new Map(),
    transfers: simplify(balances),
  };
}
