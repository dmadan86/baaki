/**
 * The private personal-finance ledger (A48), read and written local-first.
 *
 * Everything here rides the same offline mirror the rest of the app does, on the
 * personal scope (the owner's own user id, suffixed): a record made offline is
 * in the queue and shows immediately; the server is only a relay. All the sums
 * the screens show are computed from these rows by the pure helpers in
 * `@waves/core` (personal/compute), never on the server.
 */

import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';

import {
  decodeBudget,
  decodeLoan,
  decodeRecurring,
  decodeTxn,
  encodeRecurring,
  encodeTxn,
  materialisePersonalRecords,
  MutationKind,
  personalScope,
  recurringCatchUp,
  recurringOccurrenceId,
  type PersonalBudget,
  type PersonalLoan,
  type PersonalRecordKind,
  type PersonalRecurring,
  type PersonalTxn,
} from '@waves/core';

import { useAuth } from '@/lib/auth';
import { useSync } from '@/sync';

/** A Date as a LOCAL YYYY-MM-DD — the calendar day the person is looking at, not
 *  the UTC one. `toISOString().slice(0,10)` shifts the day for anyone east or
 *  west of UTC (a local-midnight pick in IST reads as the day before), so the
 *  date maths must read the local parts instead. */
export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today as a LOCAL YYYY-MM-DD. Call outside render (an effect or a lazy
 *  initialiser); a bare `new Date()` in render trips the React Compiler lint. */
export function todayIso(): string {
  return localIsoDate(new Date());
}

export interface PersonalLedger {
  readonly txns: readonly PersonalTxn[];
  readonly recurrings: readonly PersonalRecurring[];
  readonly loans: readonly PersonalLoan[];
  readonly budgets: readonly PersonalBudget[];
}

const EMPTY: PersonalLedger = { txns: [], recurrings: [], loans: [], budgets: [] };

/**
 * The whole ledger, decoded by kind and read local-first. Txns come back newest
 * first. Empty (not an error) when signed out — personal finance is per-account.
 */
export function usePersonalLedger(): PersonalLedger {
  const { mirror, queue } = useSync();
  const { session } = useAuth();
  const ownerId = session?.user?.id ?? '';

  return useMemo(() => {
    if (!ownerId) return EMPTY;
    const records = materialisePersonalRecords(mirror, queue, { ownerId });
    const txns: PersonalTxn[] = [];
    const recurrings: PersonalRecurring[] = [];
    const loans: PersonalLoan[] = [];
    const budgets: PersonalBudget[] = [];
    for (const record of records) {
      switch (record.record_kind) {
        case 'txn':
          txns.push(decodeTxn(record.id, record.data));
          break;
        case 'recurring':
          recurrings.push(decodeRecurring(record.id, record.data));
          break;
        case 'loan':
          loans.push(decodeLoan(record.id, record.data));
          break;
        case 'budget':
          budgets.push(decodeBudget(record.id, record.data));
          break;
        default:
          break;
      }
    }
    txns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { txns, recurrings, loans, budgets };
  }, [mirror, queue, ownerId]);
}

export interface UpsertPersonalInput {
  /** Omit to create (a fresh id is minted); pass to edit an existing record. */
  readonly recordId?: string;
  readonly recordKind: PersonalRecordKind;
  readonly data: Record<string, unknown>;
}

/**
 * Create or edit one personal-finance record. One upsert covers every kind — the
 * caller supplies `recordKind` and the encoded `data` (see the `encode*` helpers
 * in core). Returns the record id, minted here on a create.
 */
export function useUpsertPersonalRecord() {
  const { mutate } = useSync();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (input: UpsertPersonalInput): Promise<string> => {
      const ownerId = session?.user?.id;
      if (!ownerId) throw new Error('Sign in first');
      const recordId = input.recordId ?? randomUUID();
      await mutate(MutationKind.PersonalUpsert, personalScope(ownerId), {
        recordId,
        recordKind: input.recordKind,
        data: input.data,
      });
      return recordId;
    },
  });
}

/** Soft-delete one personal-finance record (the tombstone rides the pull). */
export function useDeletePersonalRecord() {
  const { mutate } = useSync();
  const { session } = useAuth();
  return useMutation({
    mutationFn: async (recordId: string): Promise<string> => {
      const ownerId = session?.user?.id;
      if (!ownerId) throw new Error('Sign in first');
      await mutate(MutationKind.PersonalDelete, personalScope(ownerId), { recordId });
      return recordId;
    },
  });
}

/**
 * Post every occurrence an auto-posting recurring rule owes up to `today`, and
 * advance each rule's `nextDate`. Idempotent: an occurrence whose txn already
 * exists (matched by rule id + date) is skipped, so running this on every open
 * never double-posts. Manual (non-auto) rules are left for the user to confirm.
 * Returns how many txns were posted. Call from an effect, not render.
 */
export async function postDueRecurring(
  ledger: PersonalLedger,
  today: string,
  upsert: (input: UpsertPersonalInput) => Promise<string>,
): Promise<number> {
  let posted = 0;
  for (const rule of ledger.recurrings) {
    if (!rule.autoPost || !rule.active) continue;
    const { dates, nextDate } = recurringCatchUp(rule, today);
    if (dates.length === 0) continue;
    for (const date of dates) {
      const already = ledger.txns.some((txn) => txn.recurringId === rule.id && txn.date === date);
      if (already) continue;
      // A deterministic id per (rule, date), so two posts of the same occurrence
      // — a race, or a manual "add now" crossing this catch-up — upsert one row.
      await upsert({
        recordId: recurringOccurrenceId(rule.id, date),
        recordKind: 'txn',
        data: encodeTxn({
          kind: rule.txnKind,
          amount: rule.amount,
          currency: rule.currency,
          category: rule.category,
          note: rule.note,
          date,
          loanId: null,
          recurringId: rule.id,
        }),
      });
      posted += 1;
    }
    if (nextDate !== rule.nextDate) {
      await upsert({
        recordId: rule.id,
        recordKind: 'recurring',
        data: encodeRecurring({ ...rule, nextDate }),
      });
    }
  }
  return posted;
}
