/**
 * Sync protocol types (ADR-005 / TDR §4). Defined in M0 so the client, the
 * `/sync` edge function and the tests all compile against one contract; the
 * engine that uses them lands in M2.
 *
 * Every mutation carries a client-generated UUID which is the idempotency key —
 * the server upserts by it, so replaying a queue after a crash or a flaky
 * network can never double-post an expense.
 */

import type { CurrencyCode } from '../money/currency.js';
import type { MemberId, SplitParams } from '../split/types.js';
import type { SettlementAllocation, SettlementStatus } from '../balances/types.js';

export type MutationKind =
  | 'expense.create'
  | 'expense.update'
  | 'expense.delete'
  | 'expense.restore'
  | 'settlement.create'
  | 'settlement.transition'
  | 'member.add_ghost'
  | 'group.create'
  | 'group.update';

export interface MutationEnvelope<K extends MutationKind = MutationKind, P = unknown> {
  /** Client-generated UUID v4. The idempotency key. */
  readonly clientMutationId: string;
  readonly kind: K;
  readonly groupId: string;
  /** Client clock, ISO instant. Advisory only — the server orders by receipt. */
  readonly clientCreatedAt: string;
  readonly payload: P;
  /** Local retry counter; not sent to the server. */
  readonly attempts?: number;
}

export interface ExpenseCreatePayload {
  readonly expenseId: string;
  readonly description: string;
  readonly category?: string;
  readonly expenseDate: string;
  readonly currency: CurrencyCode;
  readonly amount: string; // bigint serialised as a decimal string
  readonly splitParams: SplitParams;
  readonly participants: readonly MemberId[];
  readonly payers: Readonly<Record<MemberId, string>>;
  readonly receiptId?: string | null;
  readonly notes?: string | null;
}

export interface ExpenseUpdatePayload extends ExpenseCreatePayload {
  /** Version the client edited, so the server can detect a concurrent edit. */
  readonly baseVersionNo: number;
}

export interface ExpenseDeletePayload {
  readonly expenseId: string;
}

export interface SettlementCreatePayload {
  readonly settlementId: string;
  readonly from: MemberId;
  readonly to: MemberId;
  readonly currency: CurrencyCode;
  readonly amount: string;
  readonly method: 'upi' | 'cash' | 'bank' | 'other';
  readonly note?: string | null;
  readonly allocations?: readonly { expenseId: string; amount: string }[];
}

export interface SettlementTransitionPayload {
  readonly settlementId: string;
  readonly to: SettlementStatus;
}

export interface SyncRequest {
  readonly deviceId: string;
  readonly mutations: readonly MutationEnvelope[];
  /** Cursor per group the client already has, keyed by group id. */
  readonly cursors: Readonly<Record<string, number>>;
}

export type SyncMutationOutcome =
  | { readonly clientMutationId: string; readonly status: 'applied' }
  | { readonly clientMutationId: string; readonly status: 'duplicate' }
  | {
      readonly clientMutationId: string;
      readonly status: 'rejected';
      readonly code: SyncRejectionCode;
      readonly message: string;
    };

export type SyncRejectionCode =
  | 'SHARE_MISMATCH'
  | 'NOT_A_MEMBER'
  | 'GROUP_ARCHIVED'
  | 'VALIDATION_FAILED'
  | 'CONFLICT_SUPERSEDED'
  | 'RATE_LIMITED';

export interface SyncResponse {
  readonly outcomes: readonly SyncMutationOutcome[];
  /** Authoritative rows the client must reconcile into SQLite. */
  readonly changes: readonly SyncChange[];
  readonly cursors: Readonly<Record<string, number>>;
  readonly serverTime: string;
}

export interface SyncChange {
  readonly table: SyncTable;
  readonly groupId: string;
  /** Monotonic per-group sequence; the client's cursor. */
  readonly seq: number;
  readonly row: Readonly<Record<string, unknown>>;
  readonly deleted?: boolean;
}

export type SyncTable =
  | 'groups'
  | 'group_members'
  | 'expenses'
  | 'expense_versions'
  | 'expense_payers'
  | 'expense_shares'
  | 'settlements'
  | 'settlement_allocations'
  | 'activity_log';

/** bigint ↔ string at the wire boundary; JSON has no integers this size. */
export function serialiseAmount(amount: bigint): string {
  return amount.toString();
}

export function parseAmount(amount: string): bigint {
  return BigInt(amount);
}

export const SETTLEMENT_ALLOCATION_WIRE = {
  serialise(allocation: SettlementAllocation): { expenseId: string; amount: string } {
    return { expenseId: allocation.expenseId, amount: serialiseAmount(allocation.amount) };
  },
  parse(wire: { expenseId: string; amount: string }): SettlementAllocation {
    return { expenseId: wire.expenseId, amount: parseAmount(wire.amount) };
  },
};
