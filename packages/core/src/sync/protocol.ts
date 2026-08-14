/**
 * Sync protocol types (ADR-005 / TDR §4). Defined in M0 so the client, the
 * `/sync` edge function and the tests all compile against one contract; the
 * engine that uses them lands in M2.
 *
 * Every mutation carries a client-generated UUID which is the idempotency key —
 * the server upserts by it, so replaying a queue after a crash or a flaky
 * network can never double-post an expense.
 */

import { MoneyError, MoneyErrorCode, type CurrencyCode } from '../money/currency';
import type { MemberId, SplitParams } from '../split/types';
import type { SettlementAllocation, SettlementStatus } from '../balances/types';

export enum MutationKind {
  ExpenseCreate = 'expense.create',
  ExpenseUpdate = 'expense.update',
  ExpenseDelete = 'expense.delete',
  ExpenseRestore = 'expense.restore',
  SettlementCreate = 'settlement.create',
  SettlementTransition = 'settlement.transition',
  MemberAddGhost = 'member.add_ghost',
  GroupCreate = 'group.create',
  GroupUpdate = 'group.update',
}

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

export enum SyncRejectionCode {
  ShareMismatch = 'SHARE_MISMATCH',
  NotAMember = 'NOT_A_MEMBER',
  GroupArchived = 'GROUP_ARCHIVED',
  ValidationFailed = 'VALIDATION_FAILED',
  ConflictSuperseded = 'CONFLICT_SUPERSEDED',
  RateLimited = 'RATE_LIMITED',
}

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

export enum SyncTable {
  Groups = 'groups',
  GroupMembers = 'group_members',
  Expenses = 'expenses',
  ExpenseVersions = 'expense_versions',
  ExpensePayers = 'expense_payers',
  ExpenseShares = 'expense_shares',
  Settlements = 'settlements',
  SettlementAllocations = 'settlement_allocations',
  ActivityLog = 'activity_log',
}

/** bigint ↔ string at the wire boundary; JSON has no integers this size. */
export function serialiseAmount(amount: bigint): string {
  return amount.toString();
}

/**
 * The other direction, and not a one-liner, because `BigInt` is the wrong shape
 * of function for a wire boundary in two separate ways.
 *
 * It **invents numbers**. `BigInt('')` is `0n` and so is `BigInt('   ')`, so an
 * amount that never arrived becomes a settlement of zero rather than an error
 * — the ledger stays internally consistent and describes something nobody did.
 * `'0x10'`, `'0b11'` and `'0o17'` are read as 16, 3 and 15, so a string that is
 * not a decimal number at all still produces one. These are the dangerous
 * cases: nothing throws and nothing looks wrong afterwards.
 *
 * And where it does refuse, it throws a bare `SyntaxError`. Every other parser
 * here refuses with an error of this library's own, which is what lets a caller
 * tell "the wire was malformed" from "the code above me has a bug" — a
 * distinction the sync queue has to make, because one is worth retrying and the
 * other never is.
 *
 * So the string is checked before it is converted, on the same rule as
 * `integer()` in `split/wire.ts`: an optional sign and decimal digits, nothing
 * else. A float is refused rather than rounded for the reason given there —
 * rounding here would put a number in the ledger that nobody chose.
 */
export function parseAmount(amount: string): bigint {
  if (typeof amount !== 'string' || !/^[+-]?\d+$/.test(amount.trim())) {
    throw new MoneyError(
      MoneyErrorCode.InvalidAmount,
      `${String(amount)} is not a whole minor-unit amount`,
    );
  }
  return BigInt(amount.trim());
}

export const SETTLEMENT_ALLOCATION_WIRE = {
  serialise(allocation: SettlementAllocation): { expenseId: string; amount: string } {
    return { expenseId: allocation.expenseId, amount: serialiseAmount(allocation.amount) };
  },
  parse(wire: { expenseId: string; amount: string }): SettlementAllocation {
    return { expenseId: wire.expenseId, amount: parseAmount(wire.amount) };
  },
};
