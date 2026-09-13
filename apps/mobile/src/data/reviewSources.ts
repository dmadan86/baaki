/**
 * The two things Review reads off the local mirror that nothing else did.
 *
 * Both are one pass over rows the app already holds, so they cost no request
 * and are right with no network (ADR-005). The rules they feed are pure and
 * live elsewhere — `lib/merchantDestination.ts` decides what a destination may
 * claim, and this only gathers what it decides over.
 */

import { useMemo } from 'react';

import { materialiseCaptures, materialiseLedgerGroupIds, rowsFor, SyncTable } from '@waves/core';

import { useAuth } from '@/lib/auth';
import {
  buildMerchantDestinations,
  type FiledExpense,
  type MerchantDestinations,
} from '@/lib/merchantDestination';
import { useSync } from '@/sync';

/** A week, in milliseconds — the window the zero state speaks about. */
const A_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Merchant → the group its money goes to, from the ledger this device holds.
 *
 * Soft-deleted expenses and groups the viewer no longer has a ledger for are
 * left out — the same two exclusions `useDestinationUsage` makes, for the same
 * reasons: a tombstone is not a filing, and a group you left is not somewhere a
 * chip may point.
 */
export function useMerchantDestinations(): MerchantDestinations {
  const { mirror } = useSync();
  return useMemo(() => {
    const ledgerGroupIds = materialiseLedgerGroupIds(mirror, []);
    const filed: FiledExpense[] = [];
    for (const row of rowsFor(mirror, SyncTable.Expenses)) {
      const expense = row as unknown as {
        group_id: string;
        deleted_at: string | null;
        created_at: string;
        currentVersion: { description?: string | null } | null;
      };
      if (expense.deleted_at || !ledgerGroupIds.has(expense.group_id)) continue;
      const description = expense.currentVersion?.description;
      if (!description) continue;
      filed.push({ groupId: expense.group_id, description, at: String(expense.created_at) });
    }
    return buildMerchantDestinations(filed);
  }, [mirror]);
}

/**
 * How well Review is doing at needing nobody: drafts caught in the last week
 * that are no longer waiting, because they are already an expense in a group.
 *
 * Deliberately a small, true number. Not "filed themselves" — nothing files
 * itself yet — and never a total that quietly counts spends this screen never
 * saw. `now` is handed in so a screen that already holds a ticking clock does
 * not start a second one.
 */
export function useFiledThisWeek(now: number): number {
  const { session } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const { mirror, queue } = useSync();
  return useMemo(() => {
    if (!ownerId) return 0;
    const since = now - A_WEEK;
    let filed = 0;
    for (const capture of materialiseCaptures(mirror, queue, { ownerId })) {
      if (capture.status !== 'assigned' || capture.deleted_at !== null) continue;
      const caught = Date.parse(capture.created_at);
      if (Number.isFinite(caught) && caught >= since) filed += 1;
    }
    return filed;
  }, [mirror, queue, ownerId, now]);
}
