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

import { categoryTagsScope, parseAmount, SyncTable } from './protocol';
import type { CategoryMeta } from '../category/catalog';
import type {
  CaptureAssignPayload,
  CaptureCreatePayload,
  CaptureDeletePayload,
  ExpenseCreatePayload,
  ExpenseDeletePayload,
  ExpenseLocation,
  MemberBudgetSetPayload,
  MutationEnvelope,
  PlanItemCreatePayload,
  PlanItemDeletePayload,
  PlanItemUpdatePayload,
  SyncChange,
  TagDeletePayload,
  TagUpsertPayload,
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
  SyncTable.Groups,
  SyncTable.GroupMembers,
  SyncTable.Expenses,
  SyncTable.ExpenseVersions,
  SyncTable.ExpensePayers,
  SyncTable.ExpenseShares,
  SyncTable.Settlements,
  SyncTable.SettlementAllocations,
  SyncTable.ActivityLog,
  SyncTable.Captures,
  SyncTable.GhostMerges,
  SyncTable.CategoryTags,
  SyncTable.TripPlanItems,
  SyncTable.TripMemberBudgets,
  SyncTable.SettlementProofs,
  SyncTable.ExpenseAttachments,
  SyncTable.ExpenseComments,
  SyncTable.ExpenseImageEvents,
];

export function emptyMirror(): MirrorState {
  const tables = {} as Record<SyncTable, Record<string, MirrorRow>>;
  for (const table of TABLES) tables[table] = {};
  return { cursors: {}, tables };
}

export interface ReconcileResult {
  readonly state: MirrorState;
  /** Changes that actually advanced the mirror after stale rows were ignored. */
  readonly applied: readonly SyncChange[];
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
  const applied: SyncChange[] = [];
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
    applied.push(change);
  }

  return { state: { cursors, tables }, applied, skipped };
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
    readonly category_meta: CategoryMeta | null;
    readonly expense_date: string;
    readonly currency: string;
    readonly amount: string;
    readonly split_type: SplitType;
    readonly split_params: SplitParams;
    readonly author_member_id: string | null;
    readonly notes: string | null;
    readonly payment_method: string | null;
    readonly receipt_share_url: string | null;
    readonly location: ExpenseLocation | null;
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
  return overlayPending(
    rowsFor(state, SyncTable.Expenses, options.groupId) as MirrorExpense[],
    queue,
    options,
  );
}

/**
 * The same overlay, over any list of expense rows rather than the mirror.
 *
 * The mirror is one source of server rows; a cached network response is
 * another. Both need the queue replayed on top or the app shows an expense the
 * user has just entered as missing, which looks exactly like data loss.
 */
export function overlayPending(
  expenses: readonly MirrorExpense[],
  queue: readonly QueuedMutation[],
  options: MaterialiseOptions,
): MirrorExpense[] {
  const byId = new Map<string, MirrorExpense>();
  for (const expense of expenses) byId.set(expense.id, expense);

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
          category_meta: payload.categoryMeta ?? null,
          expense_date: payload.expenseDate,
          currency: payload.currency,
          amount: payload.amount,
          split_type: payload.splitParams.kind as SplitType,
          split_params: payload.splitParams,
          author_member_id: options.authorMemberId ?? null,
          notes: payload.notes ?? null,
          payment_method: payload.paymentMethod ?? null,
          receipt_share_url: payload.receiptShareUrl ?? null,
          location: payload.location ?? null,
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
      // Members, groups and settlements do not change an expense row. They have
      // their own overlays below, because they can all be created offline now.
      return;
  }
}

function pendingShares(payload: ExpenseCreatePayload): { member_id: string; amount: string }[] {
  const shares = computeShares({
    amount: parseAmount(payload.amount),
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
  // A malformed amount on one row must hide that row, not crash the whole list
  // as it materialises. parseAmount raises a typed MoneyError we swallow here.
  try {
    return {
      id: expense.id,
      currency: version.currency as CurrencyCode,
      amount: parseAmount(version.amount),
      payers: Object.fromEntries(
        version.payers.map((row) => [row.member_id, parseAmount(row.amount)]),
      ),
      shares: Object.fromEntries(
        version.shares.map((row) => [row.member_id, parseAmount(row.amount)]),
      ),
      date: version.expense_date,
      deletedAt: expense.deleted_at,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────── settlements, members and groups ──
//
// Expenses were the only thing the app could create offline, so they were the
// only thing overlaid. Now that every mutation queues, the rest need the same
// treatment: a settlement recorded in a basement, a friend added on a plane and
// a group started in a tunnel all have to appear the moment they are made.
// Without this they sit in the queue, invisible, and the app looks like it
// dropped them — the failure ADR-005 exists to prevent.
//
// All three mark `pending` so a screen can say the row has not left the phone.

export interface MirrorSettlement extends MirrorRow {
  readonly id: string;
  readonly group_id: string;
  readonly from_member_id: string;
  readonly to_member_id: string;
  readonly currency: string;
  readonly amount: string;
  readonly status: string;
  readonly initiated_at: string;
  readonly confirmed_at: string | null;
  readonly allocations?: readonly { expense_id: string; amount: string }[];
  readonly pending?: boolean;
}

export function materialiseSettlements(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  options: { readonly groupId: string },
): MirrorSettlement[] {
  const byId = new Map<string, MirrorSettlement>();
  for (const row of rowsFor(state, SyncTable.Settlements, options.groupId) as MirrorSettlement[]) {
    byId.set(row.id, row);
  }

  for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (mutation.groupId !== options.groupId) continue;

    if (mutation.kind === 'settlement.create') {
      const payload = mutation.payload as {
        settlementId?: string;
        from: string;
        to: string;
        currency?: string | null;
        amount: string;
        note?: string | null;
        allocations?: readonly { expenseId: string; amount: string }[];
      };
      // Falling back to the mutation id keeps the row addressable even for a
      // client that did not choose an id — two different queued settlements can
      // never collide, because the mutation id is the idempotency key.
      const id = payload.settlementId ?? `pending:${mutation.clientMutationId}`;
      byId.set(id, {
        id,
        group_id: mutation.groupId,
        from_member_id: payload.from,
        to_member_id: payload.to,
        currency: payload.currency ?? 'INR',
        amount: payload.amount,
        // `initiated`, not `confirmed`: the other person has still not agreed,
        // and a settlement that counts itself confirmed on the way out would
        // clear a debt nobody acknowledged.
        status: 'initiated',
        initiated_at: mutation.clientCreatedAt,
        confirmed_at: null,
        note: payload.note ?? null,
        allocations: (payload.allocations ?? []).map((allocation) => ({
          expense_id: allocation.expenseId,
          amount: allocation.amount,
        })),
        pending: true,
      });
      continue;
    }

    if (mutation.kind === 'settlement.transition') {
      const { settlementId } = mutation.payload as { settlementId: string };
      const existing = byId.get(settlementId);
      if (existing) {
        byId.set(settlementId, {
          ...existing,
          status: 'confirmed',
          confirmed_at: mutation.clientCreatedAt,
          pending: true,
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) =>
    String(b.initiated_at).localeCompare(String(a.initiated_at)),
  );
}

export interface MirrorMember extends MirrorRow {
  readonly id: string;
  readonly group_id: string;
  readonly profile_id: string | null;
  readonly ghost_name: string | null;
  readonly left_at: string | null;
  readonly pending?: boolean;
}

export function materialiseMembers(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  options: { readonly groupId: string },
): MirrorMember[] {
  const byId = new Map<string, MirrorMember>();
  for (const row of rowsFor(state, SyncTable.GroupMembers, options.groupId) as MirrorMember[]) {
    byId.set(row.id, row);
  }

  for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (mutation.groupId !== options.groupId) continue;

    // A group created offline must show its creator as a member at once, with
    // the id the client chose — so an expense queued behind it in the same
    // breath can already name who paid, and matches once the server (which now
    // honours the same id) has applied it. Without this the creator would be
    // invisible until the create synced back.
    if (mutation.kind === 'group.create') {
      const payload = mutation.payload as {
        creatorMemberId?: string | null;
        creatorProfileId?: string | null;
      };
      const id = payload.creatorMemberId ?? `pending:${mutation.clientMutationId}`;
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          group_id: mutation.groupId,
          profile_id: payload.creatorProfileId ?? null,
          ghost_name: null,
          left_at: null,
          invite_email: null,
          invite_phone: null,
          role: 'admin',
          pending: true,
        });
      }
      continue;
    }

    if (mutation.kind !== 'member.add_ghost') continue;
    const payload = mutation.payload as {
      memberId?: string;
      name: string;
      email?: string | null;
      phone?: string | null;
    };
    const id = payload.memberId ?? `pending:${mutation.clientMutationId}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      group_id: mutation.groupId,
      profile_id: null,
      ghost_name: payload.name,
      left_at: null,
      invite_email: payload.email ?? null,
      invite_phone: payload.phone ?? null,
      role: 'member',
      pending: true,
    });
  }

  return [...byId.values()].filter((member) => member.left_at === null);
}

export interface MirrorGroup extends MirrorRow {
  readonly id: string;
  readonly name: string | null;
  readonly default_currency: string;
  readonly created_at: string;
  readonly archived_at: string | null;
  /** A group-wide tombstone (A49): an admin deleted a settled group for everyone.
   *  A deleted group is hidden from BOTH the active list and the archive — the
   *  rows stay (ADR-004), the group simply stops being shown. */
  readonly deleted_at: string | null;
  readonly budget_minor?: string | null;
  readonly budget_currency?: string | null;
  /** Per-category caps, keyed by category id. Group-visible, admin-set. */
  readonly category_budgets?: Record<string, { amountMinor: string; currency: string }> | null;
  readonly pending?: boolean;
}

function buildGroups(state: MirrorState, queue: readonly QueuedMutation[]): MirrorGroup[] {
  const byId = new Map<string, MirrorGroup>();
  for (const row of rowsFor(state, SyncTable.Groups) as MirrorGroup[]) byId.set(row.id, row);

  for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (mutation.kind === 'group.create') {
      const payload = mutation.payload as {
        name?: string | null;
        type?: string;
        currency?: string;
        emoji?: string | null;
        simplify?: boolean;
        country?: string | null;
      };
      // The id is the group id the client already chose, which is why the
      // expenses queued behind it can name it before the server has heard of it.
      byId.set(mutation.groupId, {
        id: mutation.groupId,
        name: payload.name ?? null,
        type: payload.type ?? 'other',
        default_currency: payload.currency ?? 'INR',
        cover_emoji: payload.emoji ?? null,
        simplify_debts: payload.simplify !== false,
        country_code: payload.country ?? null,
        created_at: mutation.clientCreatedAt,
        archived_at: null,
        deleted_at: null,
        pending: true,
      });
      continue;
    }

    if (mutation.kind === 'group.update') {
      const existing = byId.get(mutation.groupId);
      if (existing) {
        byId.set(mutation.groupId, {
          ...existing,
          ...(mutation.payload as Record<string, unknown>),
          id: existing.id,
          pending: true,
        });
      }
    }

    // The overall trip budget is a column on the group row (A23), so an
    // optimistic set shows on the group at once; a null amount clears it.
    if (mutation.kind === 'group_budget.set') {
      const existing = byId.get(mutation.groupId);
      if (existing) {
        const payload = mutation.payload as {
          amountMinor: string | null;
          currency?: string | null;
        };
        byId.set(mutation.groupId, {
          ...existing,
          budget_minor: payload.amountMinor,
          budget_currency: payload.amountMinor === null ? null : (payload.currency ?? null),
          pending: true,
        });
      }
    }

    // A per-category cap patches the group row's category_budgets map at once; a
    // null amount removes that category's cap. Same optimistic path as the
    // overall budget above.
    if (mutation.kind === 'category_budget.set') {
      const existing = byId.get(mutation.groupId);
      if (existing) {
        const payload = mutation.payload as {
          category: string;
          amountMinor: string | null;
          currency?: string | null;
        };
        const map = { ...(existing.category_budgets ?? {}) };
        if (payload.amountMinor === null) {
          delete map[payload.category];
        } else {
          map[payload.category] = {
            amountMinor: payload.amountMinor,
            currency: payload.currency ?? existing.default_currency,
          };
        }
        byId.set(mutation.groupId, { ...existing, category_budgets: map, pending: true });
      }
    }
  }

  return [...byId.values()];
}

/**
 * The active groups — everything not archived, newest first. The dashboard and
 * every summary read through here, so archiving a group drops it out of all of
 * them at once.
 */
export function materialiseGroups(
  state: MirrorState,
  queue: readonly QueuedMutation[],
): MirrorGroup[] {
  return buildGroups(state, queue)
    .filter((group) => !group.archived_at && !group.deleted_at)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/**
 * One group by id, archived or not. `materialiseGroups` hides archived groups so
 * they leave the dashboard, but a per-group screen (the plan, its budget) still
 * opens on an archived trip and must see its row — including a queued
 * `group_budget.set` that has not synced yet.
 */
export function materialiseGroup(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  groupId: string,
): MirrorGroup | undefined {
  return buildGroups(state, queue).find((group) => group.id === groupId);
}

/**
 * The archived groups — the ones `materialiseGroups` hides — newest-archived
 * first, so the archive reads as a most-recent-on-top history. Unarchiving is
 * an ordinary group.update clearing `archived_at`, so the same queue overlay
 * moves a group back into the active list the instant the row is tapped.
 */
export function materialiseArchivedGroups(
  state: MirrorState,
  queue: readonly QueuedMutation[],
): MirrorGroup[] {
  return buildGroups(state, queue)
    .filter((group) => Boolean(group.archived_at) && !group.deleted_at)
    .sort((a, b) => String(b.archived_at ?? '').localeCompare(String(a.archived_at ?? '')));
}

// ───────────────────────────────────────────────── captures (A34) ──
//
// The personal inbox needs the same server+pending treatment as everything
// else: a capture made offline is only in the queue, and without the overlay it
// would be invisible until it synced — the same data-loss illusion ADR-005
// exists to prevent. Captures ride a *personal* scope, so the envelope's
// `groupId` slot holds the owner's user id rather than a group.

export interface MirrorCapture extends MirrorRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly description: string;
  readonly category: string | null;
  readonly category_meta: CategoryMeta | null;
  readonly expense_date: string;
  readonly currency: string;
  readonly amount: string;
  readonly notes: string | null;
  readonly photo_path: string | null;
  readonly raw_text: string | null;
  readonly parsed: Record<string, unknown> | null;
  readonly payment_method: string | null;
  readonly target_group_id: string | null;
  readonly location: ExpenseLocation | null;
  readonly status: 'open' | 'assigned';
  readonly assigned_expense_id: string | null;
  readonly assigned_group_id: string | null;
  readonly created_at: string;
  readonly deleted_at: string | null;
  readonly pending?: boolean;
}

/**
 * The captures to render: the server's rows with the queue replayed on top.
 *
 * `ownerId` is the personal scope — the caller's own user id, which is what
 * every queued capture mutation carries in place of a group id.
 */
export function materialiseCaptures(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  options: { readonly ownerId: string },
): MirrorCapture[] {
  const byId = new Map<string, MirrorCapture>();
  // Scope the server rows to this owner too: if the mirror ever holds another
  // account's captures (a shared device, an account switch), the inbox must not
  // show them just because the queue overlay below is the only thing filtered.
  for (const row of rowsFor(state, SyncTable.Captures) as MirrorCapture[]) {
    if (row.owner_user_id !== options.ownerId) continue;
    byId.set(row.id, row);
  }

  for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (mutation.groupId !== options.ownerId) continue;

    switch (mutation.kind) {
      case 'capture.create':
      case 'capture.update': {
        const payload = mutation.payload as CaptureCreatePayload;
        const existing = byId.get(payload.captureId);
        byId.set(payload.captureId, {
          id: payload.captureId,
          owner_user_id: options.ownerId,
          description: payload.description,
          category: payload.category ?? null,
          category_meta:
            'categoryMeta' in payload
              ? (payload.categoryMeta ?? null)
              : (existing?.category_meta ?? null),
          expense_date: payload.expenseDate,
          currency: payload.currency,
          amount: payload.amount,
          notes: payload.notes ?? null,
          photo_path: payload.photoPath ?? null,
          raw_text: payload.rawText ?? null,
          parsed: payload.parsed ?? null,
          // An edit that omits these keeps what the server had; an edit that
          // sends them — null included — is a deliberate clear, so `in` decides
          // rather than `??`, which would swallow an explicit null.
          payment_method:
            'paymentMethod' in payload
              ? (payload.paymentMethod ?? null)
              : (existing?.payment_method ?? null),
          target_group_id:
            'targetGroupId' in payload
              ? (payload.targetGroupId ?? null)
              : (existing?.target_group_id ?? null),
          location:
            'location' in payload ? (payload.location ?? null) : (existing?.location ?? null),
          // An edit never un-assigns; only assignment sets it, below.
          status: existing?.status ?? 'open',
          assigned_expense_id: existing?.assigned_expense_id ?? null,
          assigned_group_id: existing?.assigned_group_id ?? null,
          created_at: existing?.created_at ?? mutation.clientCreatedAt,
          deleted_at: existing?.deleted_at ?? null,
          pending: true,
        });
        break;
      }
      case 'capture.delete': {
        const { captureId } = mutation.payload as CaptureDeletePayload;
        const existing = byId.get(captureId);
        if (existing) {
          byId.set(captureId, { ...existing, deleted_at: mutation.clientCreatedAt, pending: true });
        }
        break;
      }
      case 'capture.assign': {
        const payload = mutation.payload as CaptureAssignPayload;
        const existing = byId.get(payload.captureId);
        if (existing) {
          byId.set(payload.captureId, {
            ...existing,
            status: 'assigned',
            assigned_group_id: payload.groupId,
            assigned_expense_id: payload.expenseId,
            pending: true,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return [...byId.values()].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

/** The inbox: open, not deleted. What has been assigned or removed is gone from it. */
export function openCaptures(captures: readonly MirrorCapture[]): MirrorCapture[] {
  return captures.filter((capture) => capture.status === 'open' && capture.deleted_at === null);
}

// ─────────────────────────────────────── the category-tag catalog ──
// Personal scope, exactly like captures, but under its own cursor key
// (`categoryTagsScope`). A tag made offline is only in the queue, so the same
// server+pending overlay applies or a freshly created tag would be invisible
// until it synced.

export interface MirrorCategoryTag extends MirrorRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly builtin_id: string | null;
  readonly label: string | null;
  readonly icon: string | null;
  readonly tint: string | null;
  readonly sort_order: number;
  readonly hidden: boolean;
  readonly deleted_at: string | null;
}

/**
 * The catalog rows to read: the server's rows for this owner, with the queue
 * replayed on top. `ownerId` is the personal scope; every queued tag mutation
 * carries `categoryTagsScope(ownerId)` in the envelope's group slot.
 */
export function materialiseCategoryTags(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  options: { readonly ownerId: string },
): MirrorCategoryTag[] {
  const scope = categoryTagsScope(options.ownerId);
  const byId = new Map<string, MirrorCategoryTag>();
  for (const row of rowsFor(state, SyncTable.CategoryTags) as MirrorCategoryTag[]) {
    if (row.owner_user_id !== options.ownerId) continue;
    byId.set(row.id, row);
  }

  for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (mutation.groupId !== scope) continue;

    switch (mutation.kind) {
      case 'tag.create':
      case 'tag.update': {
        const payload = mutation.payload as TagUpsertPayload;
        const existing = byId.get(payload.tagId);
        byId.set(payload.tagId, {
          id: payload.tagId,
          owner_user_id: options.ownerId,
          builtin_id: payload.builtinId ?? existing?.builtin_id ?? null,
          label: payload.label ?? existing?.label ?? null,
          icon: payload.icon ?? existing?.icon ?? null,
          tint: payload.tint ?? existing?.tint ?? null,
          sort_order: payload.sortOrder,
          hidden: payload.hidden,
          deleted_at: existing?.deleted_at ?? null,
        });
        break;
      }
      case 'tag.delete': {
        const { tagId } = mutation.payload as TagDeletePayload;
        const existing = byId.get(tagId);
        if (existing) {
          byId.set(tagId, { ...existing, deleted_at: mutation.clientCreatedAt });
        }
        break;
      }
      default:
        break;
    }
  }

  return [...byId.values()].filter((tag) => tag.deleted_at === null);
}

/**
 * A viewer's ghost merge, as it lands in the mirror (A38). Pull-only — the
 * client never writes these — so there is no pending overlay, unlike captures.
 * `id` is the synthetic key the edge injects (the member_id), since the table's
 * real key is the composite (owner, member_id).
 */
export interface MirrorGhostMerge extends MirrorRow {
  readonly id: string;
  readonly owner: string;
  readonly member_id: string;
  readonly person_id: string;
  readonly display_name: string;
}

/** The viewer's ghost merges from the mirror; read-only, no overlay. */
export function ghostMerges(state: MirrorState): MirrorGhostMerge[] {
  return rowsFor(state, SyncTable.GhostMerges) as MirrorGhostMerge[];
}

// ─────────────────────────────────────────────── trip plan + budgets (A23) ──
//
// The plan is a group's shared list, not money (no balance ever reads it), so
// it gets the same server+pending overlay as everything else: an item added in
// a dead zone is only in the queue until it syncs, and without the overlay it
// would look lost. Delete is soft (a `deleted_at` the seq pull carries), so the
// mirror filters it out rather than a hard removal a second device never sees.

export interface MirrorPlanItem extends MirrorRow {
  readonly id: string;
  readonly group_id: string;
  readonly day: string;
  readonly starts_at: string | null;
  readonly title: string;
  readonly note: string | null;
  readonly category: string | null;
  readonly planned_minor: string | null;
  readonly currency: string;
  readonly done_at: string | null;
  readonly expense_id: string | null;
  readonly position: number;
  readonly deleted_at: string | null;
  readonly pending?: boolean;
  /** Queue order for a pending create the server has not positioned yet, so two
   *  items added back-to-back sort in the order they were typed, not by UUID. */
  readonly pending_rank?: number;
}

/** The plan of one group: server rows with queued create/update/delete on top. */
export function materialisePlanItems(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  options: { readonly groupId: string },
): MirrorPlanItem[] {
  const byId = new Map<string, MirrorPlanItem>();
  for (const row of rowsFor(state, SyncTable.TripPlanItems, options.groupId) as MirrorPlanItem[]) {
    byId.set(row.id, row);
  }

  for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
    if (mutation.groupId !== options.groupId) continue;

    switch (mutation.kind) {
      case 'plan_item.create': {
        const payload = mutation.payload as PlanItemCreatePayload;
        if (byId.has(payload.itemId)) break;
        byId.set(payload.itemId, {
          id: payload.itemId,
          group_id: mutation.groupId,
          day: payload.day,
          starts_at: payload.startsAt ?? null,
          title: payload.title,
          note: payload.note ?? null,
          category: payload.category ?? null,
          planned_minor: payload.plannedMinor ?? null,
          currency: payload.currency ?? 'INR',
          done_at: null,
          expense_id: null,
          // The server sets the real position (last within its day); until then
          // sort a fresh item after the known ones, tie-broken by queue order.
          position: Number.MAX_SAFE_INTEGER,
          pending_rank: mutation.seq,
          deleted_at: null,
          pending: true,
        });
        break;
      }
      case 'plan_item.update': {
        const payload = mutation.payload as PlanItemUpdatePayload;
        const existing = byId.get(payload.itemId);
        if (!existing) break;
        const cleared = new Set(payload.clear ?? []);
        byId.set(payload.itemId, {
          ...existing,
          day: payload.day ?? existing.day,
          title: payload.title ?? existing.title,
          starts_at: cleared.has('starts_at') ? null : (payload.startsAt ?? existing.starts_at),
          note: cleared.has('note') ? null : (payload.note ?? existing.note),
          category: cleared.has('category') ? null : (payload.category ?? existing.category),
          planned_minor: cleared.has('planned_minor')
            ? null
            : (payload.plannedMinor ?? existing.planned_minor),
          expense_id: cleared.has('expense_id') ? null : (payload.expenseId ?? existing.expense_id),
          done_at:
            payload.done === undefined
              ? existing.done_at
              : payload.done
                ? (existing.done_at ?? mutation.clientCreatedAt)
                : null,
          pending: true,
        });
        break;
      }
      case 'plan_item.delete': {
        const { itemId } = mutation.payload as PlanItemDeletePayload;
        const existing = byId.get(itemId);
        if (existing) {
          byId.set(itemId, { ...existing, deleted_at: mutation.clientCreatedAt, pending: true });
        }
        break;
      }
      default:
        break;
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day);
    if (a.position !== b.position) return a.position - b.position;
    // Same position means two not-yet-positioned pending creates; keep the order
    // they were queued in before falling back to a (stable but arbitrary) id.
    if (a.pending_rank !== undefined && b.pending_rank !== undefined) {
      return a.pending_rank - b.pending_rank;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

// ───────────────────────────────────── private / party-only attachments ──
//
// Pull-only: the write is a direct RPC (the bytes need an online upload anyway),
// so there is no queue overlay — the mirror holds exactly what the party-scoped
// pull returned. The pull reads as the caller, so a non-party never receives
// these rows in the first place; a live read here just drops tombstones.

/** A settlement's payment proof, as the mirror holds it (party-filtered rows). */
export interface MirrorSettlementProof extends MirrorRow {
  readonly id: string;
  readonly settlement_id: string;
  readonly group_id: string;
  readonly storage_path: string;
  readonly uploader_member_id: string;
  readonly created_at: string | null;
  readonly deleted_at: string | null;
}

/** The live proof for a settlement, or null. One proof per settlement (v1). */
export function materialiseSettlementProof(
  state: MirrorState,
  options: { readonly settlementId: string },
): MirrorSettlementProof | null {
  for (const row of rowsFor(state, SyncTable.SettlementProofs) as MirrorSettlementProof[]) {
    if (row.settlement_id === options.settlementId && row.deleted_at === null) {
      return row;
    }
  }
  return null;
}

/** An image attached to an expense (group- or party-visible). */
export interface MirrorExpenseAttachment extends MirrorRow {
  readonly id: string;
  readonly expense_id: string;
  readonly group_id: string;
  readonly storage_path: string;
  readonly visibility: string;
  readonly uploader_member_id: string;
  /** Non-destructive pen/text markup (jsonb), or null. Shape parsed at the UI. */
  readonly annotations: unknown;
  readonly created_at: string | null;
  readonly deleted_at: string | null;
}

/** The live attachments for one expense, newest first. Whatever the pull
 *  returned is already RLS-filtered — a `parties` row a non-party cannot see
 *  never reached the mirror. */
export function materialiseExpenseAttachments(
  state: MirrorState,
  options: { readonly expenseId: string },
): MirrorExpenseAttachment[] {
  return (rowsFor(state, SyncTable.ExpenseAttachments) as MirrorExpenseAttachment[])
    .filter((row) => row.expense_id === options.expenseId && row.deleted_at === null)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

export interface MirrorExpenseComment extends MirrorRow {
  readonly id: string;
  readonly group_id: string;
  readonly expense_id: string;
  readonly author_member_id: string | null;
  readonly body: string;
  readonly edited_at: string | null;
  readonly flagged_at: string | null;
  readonly flagged_by: string | null;
  readonly created_at: string | null;
  readonly deleted_at: string | null;
}

/** The live comments on one expense, oldest first — a thread reads top-down.
 *  A deleted comment is a tombstone in the mirror; it is filtered out here so a
 *  removal (by the author or an admin) reaches every device as a disappearance. */
export function materialiseExpenseComments(
  state: MirrorState,
  options: { readonly expenseId: string },
): MirrorExpenseComment[] {
  return (rowsFor(state, SyncTable.ExpenseComments) as MirrorExpenseComment[])
    .filter((row) => row.expense_id === options.expenseId && row.deleted_at === null)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
}

export interface MirrorExpenseImageEvent extends MirrorRow {
  readonly id: string;
  readonly group_id: string;
  readonly expense_id: string;
  readonly actor_member_id: string | null;
  readonly kind: string;
  readonly action: string;
  readonly visibility: string;
  readonly created_at: string | null;
}

/** The image audit for one expense — who added/removed a receipt or attachment,
 *  oldest first, so the trail reads top-down like the version history beside it.
 *  Append-only: there is no tombstone to filter (a correction is another line).
 *  A `parties` row only reaches a device the pull deemed a party, so nothing to
 *  hide here. */
export function materialiseExpenseImageEvents(
  state: MirrorState,
  options: { readonly expenseId: string },
): MirrorExpenseImageEvent[] {
  return (rowsFor(state, SyncTable.ExpenseImageEvents) as MirrorExpenseImageEvent[])
    .filter((row) => row.expense_id === options.expenseId)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
}

/** The plan to render: what has not been removed. */
export function openPlanItems(items: readonly MirrorPlanItem[]): MirrorPlanItem[] {
  return items.filter((item) => item.deleted_at === null);
}

export interface MirrorMemberBudget extends MirrorRow {
  readonly id: string;
  readonly group_id: string;
  readonly member_id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly visibility: 'private' | 'group';
  readonly deleted_at: string | null;
  readonly pending?: boolean;
}

/**
 * The personal budgets visible to the caller, server rows with the caller's own
 * queued set/clear on top. The queue only ever writes the caller's own budget,
 * so the pending row is keyed by their member id (`myMemberId`), which the
 * payload does not carry — the RPC derives it server-side.
 */
export function materialiseMemberBudgets(
  state: MirrorState,
  queue: readonly QueuedMutation[],
  options: { readonly groupId: string; readonly myMemberId: string | null },
): MirrorMemberBudget[] {
  const byMember = new Map<string, MirrorMemberBudget>();
  for (const row of rowsFor(
    state,
    SyncTable.TripMemberBudgets,
    options.groupId,
  ) as MirrorMemberBudget[]) {
    byMember.set(row.member_id, row);
  }

  const mine = options.myMemberId;
  if (mine) {
    for (const mutation of [...queue].sort((a, b) => a.seq - b.seq)) {
      if (mutation.groupId !== options.groupId) continue;

      if (mutation.kind === 'member_budget.set') {
        const payload = mutation.payload as MemberBudgetSetPayload;
        const existing = byMember.get(mine);
        byMember.set(mine, {
          id: existing?.id ?? `pending:${mutation.clientMutationId}`,
          group_id: mutation.groupId,
          member_id: mine,
          amount_minor: payload.amountMinor,
          currency: payload.currency ?? existing?.currency ?? 'INR',
          visibility: payload.visibility,
          deleted_at: null,
          pending: true,
        });
      } else if (mutation.kind === 'member_budget.clear') {
        const existing = byMember.get(mine);
        if (existing) {
          byMember.set(mine, { ...existing, deleted_at: mutation.clientCreatedAt, pending: true });
        }
      }
    }
  }

  return [...byMember.values()].filter((budget) => budget.deleted_at === null);
}
