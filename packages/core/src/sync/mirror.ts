/**
 * The local mirror and how server changes fold into it (TDR §4 steps 3–4).
 *
 * The client keeps two layers, never one:
 *
 *   **server**  — exactly what the server last told us, addressed by the
 *                 per-group `updated_seq` cursor.
 *   **pending** — the mutation queue, replayed on top at read time.
 *
 * Keeping them apart is what makes "UI reads local-first, always" (ADR-005)
 * survive a pull. If optimistic edits were written into the server layer, a
 * pull that arrived before our own mutation was applied would revert the screen
 * under the user's finger. Here the pull only ever replaces the server layer,
 * and the pending edits are re-applied over the top, so the number on screen
 * only moves when the server actually disagrees.
 */

import { computeShares } from '../split/computeShares';
import type { MemberId, SplitParams, SplitType } from '../split/types';
import type { CurrencyCode } from '../money/currency';
import type { ExpenseSnapshot } from '../balances/types';

import type {
  ExpenseCreatePayload,
  ExpenseDeletePayload,
  MutationEnvelope,
  SyncChange,
  SyncTable,
} from './protocol';
import type { QueuedMutation } from './queue';

/** A row as the server sends it: snake_case, amounts as decimal strings. */
export type MirrorRow = Readonly<Record<string, unknown>>;

export interface MirrorState {
  /** Highest `updated_seq` we have applied, per group. */
  readonly cursors: Readonly<Record<string, number>>;
  readonly tables: Readonly<Record<SyncTable, Readonly<Record<string, MirrorRow>>>>;
}

const TABLES: readonly SyncTable[] = [
  'groups',
  'group_members',
  'expenses',
  'expense_versions',
  'expense_payers',
  'expense_shares',
  'settlements',
  'settlement_allocations',
  'activity_log',
];

export function emptyMirror(): MirrorState {
  const tables = {} as Record<SyncTable, Record<string, MirrorRow>>;
  for (const table of TABLES) tables[table] = {};
  return { cursors: {}, tables };
}

export interface ReconcileResult {
  readonly state: MirrorState;
  /** Changes ignored because we already had them — surfaced so tests can assert replay is free. */
  readonly skipped: number;
}

/**
 * Fold a pull into the mirror.
 *
 * Changes at or below the cursor are dropped: the server is allowed to resend
 * them (Realtime and the pull overlap by design) and re-applying must be a
 * no-op. Within a batch the highest `seq` wins, so an out-of-order response
 * cannot resurrect an older row.
 */
export function reconcile(state: MirrorState, changes: readonly SyncChange[]): ReconcileResult {
  const cursors: Record<string, number> = { ...state.cursors };
  const tables = {} as Record<SyncTable, Record<string, MirrorRow>>;
  for (const table of TABLES) tables[table] = { ...state.tables[table] };

  // Track the winning seq per row so a batch containing two versions of the
  // same row resolves the same way regardless of the order it arrived in.
  const winningSeq = new Map<string, number>();
  let skipped = 0;

  for (const change of [...changes].sort((a, b) => a.seq - b.seq)) {
    const cursor = state.cursors[change.groupId] ?? 0;
    if (change.seq <= cursor) {
      skipped += 1;
      continue;
    }

    const id = idOf(change.row);
    if (id === undefined) continue;

    const key = `${change.table}:${id}`;
    if ((winningSeq.get(key) ?? -1) > change.seq) continue;
    winningSeq.set(key, change.seq);

    if (change.deleted === true) {
      delete tables[change.table][id];
    } else {
      tables[change.table][id] = change.row;
    }
    cursors[change.groupId] = Math.max(cursors[change.groupId] ?? 0, change.seq);
  }

  return { state: { cursors, tables }, skipped };
}

function idOf(row: MirrorRow): string | undefined {
  return typeof row.id === 'string' ? row.id : undefined;
}

export function rowsFor(state: MirrorState, table: SyncTable, groupId?: string): MirrorRow[] {
  const all = Object.values(state.tables[table]);
  return groupId === undefined ? all : all.filter((row) => row.group_id === groupId);
}

// ────────────────────────────────────────── the pending overlay ──

/** The expense shape the app reads, identical to the server's embed. */
export interface MirrorExpense extends MirrorRow {
  readonly id: string;
  readonly group_id: string;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly currentVersion: {
    readonly id: string;
    readonly version_no: number;
    readonly description: string;
    readonly category: string | null;
    readonly expense_date: string;
    readonly currency: string;
    readonly amount: string;
    readonly split_type: SplitType;
    readonly split_params: SplitParams;
    readonly author_member_id: string | null;
    readonly notes: string | null;
    readonly created_at: string;
    readonly payers: readonly { member_id: string; amount: string }[];
    readonly shares: readonly { member_id: string; amount: string }[];
  } | null;
  /** True while this row exists only in the queue. The UI marks it "not synced yet". */
  readonly pending?: boolean;
}

export interface MaterialiseOptions {
  readonly groupId: string;
  /** Whose membership authored the queued edits. */
  readonly authorMemberId?: string | null;
}

/**
 * The expenses to render: the server's rows with the queue replayed on top.
 *
 * Shares are recomputed here with the same function and the same seed the
 * server uses, so an offline expense shows the exact numbers it will have once
 * it syncs — no correction flicker when the network comes back.
 */
export function materialiseExpenses(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  options: MaterialiseOptions,
): MirrorExpense[] {
  const byId = new Map<string, MirrorExpense>();
  for (const row of rowsFor(state, 'expenses', options.groupId)) {
    const expense = row as MirrorExpense;
    byId.set(expense.id, expense);
  }

  for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (mutation.groupId !== options.groupId) continue;
    applyPending(byId, mutation, options);
  }

  return [...byId.values()].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

function applyPending(
  byId: Map<string, MirrorExpense>,
  mutation: MutationEnvelope,
  options: MaterialiseOptions,
): void {
  switch (mutation.kind) {
    case 'expense.create':
    case 'expense.update': {
      const payload = mutation.payload as ExpenseCreatePayload;
      const existing = byId.get(payload.expenseId);
      byId.set(payload.expenseId, {
        id: payload.expenseId,
        group_id: mutation.groupId,
        deleted_at: null,
        created_at: existing?.created_at ?? mutation.clientCreatedAt,
        pending: true,
        currentVersion: {
          id: `pending:${mutation.clientMutationId}`,
          version_no: (existing?.currentVersion?.version_no ?? 0) + 1,
          description: payload.description,
          category: payload.category ?? null,
          expense_date: payload.expenseDate,
          currency: payload.currency,
          amount: payload.amount,
          split_type: payload.splitParams.kind,
          split_params: payload.splitParams,
          author_member_id: options.authorMemberId ?? null,
          notes: payload.notes ?? null,
          created_at: mutation.clientCreatedAt,
          payers: Object.entries(payload.payers).map(([member_id, amount]) => ({
            member_id,
            amount,
          })),
          shares: pendingShares(payload),
        },
      });
      return;
    }
    case 'expense.delete': {
      const { expenseId } = mutation.payload as ExpenseDeletePayload;
      const existing = byId.get(expenseId);
      if (existing) {
        byId.set(expenseId, { ...existing, deleted_at: mutation.clientCreatedAt, pending: true });
      }
      return;
    }
    case 'expense.restore': {
      const { expenseId } = mutation.payload as ExpenseDeletePayload;
      const existing = byId.get(expenseId);
      if (existing) byId.set(expenseId, { ...existing, deleted_at: null, pending: true });
      return;
    }
    default:
      // Members, groups and settlements are mirrored but not overlaid: none of
      // them can be created offline in a way that changes an expense row.
      return;
  }
}

function pendingShares(payload: ExpenseCreatePayload): { member_id: string; amount: string }[] {
  const shares = computeShares({
    amount: BigInt(payload.amount),
    currency: payload.currency as CurrencyCode,
    params: payload.splitParams,
    participants: payload.participants as readonly MemberId[],
    // Same seed the server uses, so the remainder lands on the same person.
    seed: payload.expenseId,
  });
  return [...shares].map(([member_id, amount]) => ({ member_id, amount: amount.toString() }));
}

/** Non-deleted expenses only — what balances are computed from. */
export function liveExpenses(expenses: readonly MirrorExpense[]): MirrorExpense[] {
  return expenses.filter((expense) => expense.deleted_at === null && expense.currentVersion);
}

/**
 * Wire row → the shape `computeNetBalances` wants. Amounts cross the network as
 * decimal strings (JSON has no integers this size) and become bigint here, once.
 */
export function toExpenseSnapshot(expense: MirrorExpense): ExpenseSnapshot | null {
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
