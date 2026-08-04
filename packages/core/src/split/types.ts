import type { CurrencyCode } from '../money/currency.js';

export type MemberId = string;

export type SplitType = 'equal' | 'exact' | 'percent' | 'shares' | 'adjustment' | 'itemized';

/** Everyone in `participants` pays the same, remainder rotated (TDR §3.1). */
export interface EqualParams {
  readonly kind: 'equal';
}

/** Caller supplies every share; they must sum to the total exactly. */
export interface ExactParams {
  readonly kind: 'exact';
  readonly amounts: Readonly<Record<MemberId, bigint>>;
}

/** Integer basis points — 10000 = 100%. Must sum to 10000. */
export interface PercentParams {
  readonly kind: 'percent';
  readonly basisPoints: Readonly<Record<MemberId, number>>;
}

/** Weights / shares, e.g. { asha: 2, ravi: 1 } → Asha pays two thirds. */
export interface SharesParams {
  readonly kind: 'shares';
  readonly weights: Readonly<Record<MemberId, number>>;
}

/**
 * Per-member +/- adjustment in minor units (e.g. Ravi had the extra beer at
 * ₹120). Adjustments are applied first, the residual splits equally.
 */
export interface AdjustmentParams {
  readonly kind: 'adjustment';
  readonly adjustments: Readonly<Record<MemberId, bigint>>;
}

export interface ItemizedLine {
  readonly label?: string;
  /** Line total in minor units (qty × unit price, as printed). */
  readonly total: bigint;
}

/**
 * Itemized bill (ADR-008). Each line is claimed by one or more members; a line
 * shared by several splits equally between its claimers. Tax / service / tip /
 * discount are prorated by each member's item subtotal.
 */
export interface ItemizedParams {
  readonly kind: 'itemized';
  readonly items: readonly ItemizedLine[];
  /** itemIndex → member ids claiming that line. Every line must be claimed. */
  readonly claims: Readonly<Record<number, readonly MemberId[]>>;
  readonly taxes?: bigint;
  readonly serviceCharge?: bigint;
  readonly tip?: bigint;
  /** Positive value; subtracted from the bill. */
  readonly discounts?: bigint;
}

export type SplitParams =
  | EqualParams
  | ExactParams
  | PercentParams
  | SharesParams
  | AdjustmentParams
  | ItemizedParams;

export interface ComputeSharesInput {
  /** Expense total in minor units. */
  readonly amount: bigint;
  readonly currency: CurrencyCode;
  readonly params: SplitParams;
  /** Members the expense is split across, in any order. */
  readonly participants: readonly MemberId[];
  /**
   * Stable per-expense value (the expense id). Drives the remainder rotation
   * offset so the same person doesn't always absorb the extra paisa, while
   * staying reproducible on every device and on the server.
   */
  readonly seed: string;
}

export type SplitErrorCode =
  | 'EMPTY_PARTICIPANTS'
  | 'DUPLICATE_PARTICIPANT'
  | 'UNKNOWN_MEMBER'
  | 'NEGATIVE_TOTAL'
  | 'EXACT_SUM_MISMATCH'
  | 'PERCENT_SUM_MISMATCH'
  | 'INVALID_WEIGHT'
  | 'NO_POSITIVE_WEIGHT'
  | 'UNCLAIMED_ITEM'
  | 'INVALID_ITEM'
  | 'ITEMIZED_TOTAL_MISMATCH'
  | 'SHARE_MISMATCH';

export class SplitError extends Error {
  readonly code: SplitErrorCode;

  constructor(code: SplitErrorCode, message: string) {
    super(message);
    this.name = 'SplitError';
    this.code = code;
  }
}

/** memberId → minor units owed for this expense. Sums exactly to the total. */
export type ShareMap = Map<MemberId, bigint>;
