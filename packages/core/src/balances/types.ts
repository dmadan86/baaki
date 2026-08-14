import type { CurrencyCode } from '../money/currency';
import type { MemberId } from '../split/types';

/** The current version of an expense, flattened to what balances need. */
export interface ExpenseSnapshot {
  readonly id: string;
  readonly currency: CurrencyCode;
  /** Total, minor units. Equals Σ payers and Σ shares (enforced in SQL too). */
  readonly amount: bigint;
  /** memberId → amount actually paid out of pocket. Multi-payer supported. */
  readonly payers: Readonly<Record<MemberId, bigint>>;
  /** memberId → amount owed, as produced by computeShares. */
  readonly shares: Readonly<Record<MemberId, bigint>>;
  /** ISO date (YYYY-MM-DD). Used for oldest-first settlement allocation. */
  readonly date: string;
  /** Soft-deleted expenses (ADR-004) do not affect balances. */
  readonly deletedAt?: string | null;
}

export enum SettlementStatus {
  Initiated = 'initiated',
  Confirmed = 'confirmed',
  AutoConfirmed = 'auto_confirmed',
  Disputed = 'disputed',
  Cancelled = 'cancelled',
}

export interface SettlementAllocation {
  readonly expenseId: string;
  readonly amount: bigint;
}

export interface SettlementSnapshot {
  readonly id: string;
  readonly from: MemberId;
  readonly to: MemberId;
  readonly currency: CurrencyCode;
  readonly amount: bigint;
  readonly status: SettlementStatus;
  /** ISO instant, used for deterministic ordering. */
  readonly at: string;
  readonly allocations?: readonly SettlementAllocation[];
}

/** Positive = the member is owed money. Negative = the member owes. */
export type NetBalances = Map<CurrencyCode, Map<MemberId, bigint>>;

export interface PairwiseEdge {
  readonly from: MemberId;
  readonly to: MemberId;
  readonly currency: CurrencyCode;
  /** Always > 0: `from` owes `to` this much. */
  readonly amount: bigint;
}

export interface BalanceOptions {
  /**
   * Count `initiated` settlements as if they were confirmed. The app uses this
   * for the "if confirmed" preview only — never for the headline number
   * (TDR §3.3).
   */
  readonly includePending?: boolean;
}

/** Statuses that actually move the ledger. */
export function isSettled(status: SettlementStatus, options: BalanceOptions = {}): boolean {
  if (status === 'confirmed' || status === 'auto_confirmed') return true;
  return status === 'initiated' && options.includePending === true;
}
