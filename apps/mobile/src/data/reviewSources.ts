/**
 * The two things Review reads off the local mirror that nothing else did.
 *
 * Both are one pass over rows the app already holds, so they cost no request
 * and are right with no network (ADR-005). The rules they feed are pure and
 * live elsewhere — `lib/groupSuggestion.ts` decides what a suggestion may
 * claim, and this only gathers what it decides over.
 */

import { useMemo } from 'react';

import { materialiseCaptures, materialiseLedgerGroupIds, rowsFor, SyncTable } from '@waves/core';

import { useAuth } from '@/lib/auth';
import {
  buildSuggestionIndex,
  type FiledExpense,
  type SuggestionIndex,
} from '@/lib/groupSuggestion';
import { useSync } from '@/sync';

/** A week, in milliseconds — the window the zero state speaks about. */
const A_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * What this device has learned about where spending goes, in one pass.
 *
 * Two tallies — by merchant and by category — over the ledger the phone already
 * holds. Both are counts rather than timestamps, deliberately: `suggestGroup`
 * breaks ties by share and by its other signals, and a "most recent wins" rule
 * is exactly how one unusual filing on a Tuesday hijacks a shop's settled home.
 *
 * Soft-deleted expenses and groups the viewer no longer has a ledger for are
 * left out — the same two exclusions `useDestinationUsage` makes, for the same
 * reasons: a tombstone is not a filing, and a group you left is not somewhere a
 * suggestion may point.
 */
export function useSuggestionIndex(): SuggestionIndex {
  const { mirror } = useSync();
  return useMemo(() => {
    const ledgerGroupIds = materialiseLedgerGroupIds(mirror, []);
    const filed: FiledExpense[] = [];
    for (const row of rowsFor(mirror, SyncTable.Expenses)) {
      const expense = row as unknown as {
        group_id: string;
        deleted_at: string | null;
        currentVersion: { description?: string | null; category?: string | null } | null;
      };
      if (expense.deleted_at || !ledgerGroupIds.has(expense.group_id)) continue;
      const description = expense.currentVersion?.description;
      const category = expense.currentVersion?.category ?? null;
      // A filing with neither a name nor a kind teaches nothing, and letting it
      // through would only add an empty key to both tallies.
      if (!description && !category) continue;
      filed.push({ groupId: expense.group_id, description: description ?? '', category });
    }
    return buildSuggestionIndex(filed);
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
