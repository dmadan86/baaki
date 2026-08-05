/**
 * What a scanned receipt looks like once the vision model is done with it
 * (ADR-008 / TDR §6).
 *
 * Every amount is an integer in minor units, like the rest of the ledger
 * (ADR-003) — the model is asked for paise, not rupees, so no float ever
 * exists between the photograph and the expense.
 */

export type ReceiptSource = 'camera' | 'gallery' | 'text_paste';

export interface ParsedReceiptLine {
  readonly label: string;
  /** Quantity as printed; 1 when the receipt doesn't say. */
  readonly qty: number;
  /** Per-unit price in minor units, or null when only a line total is printed. */
  readonly unitPrice: number | null;
  /** Line total in minor units, as printed. */
  readonly total: number;
  /** 0–1. Below `LOW_CONFIDENCE` the line is shown for correction, not accepted. */
  readonly confidence: number;
}

export interface ParsedReceiptCharge {
  readonly label: string;
  readonly amount: number;
}

export interface ParsedReceipt {
  readonly merchant: string | null;
  /** ISO date (YYYY-MM-DD), or null when the receipt doesn't carry one. */
  readonly date: string | null;
  readonly currency: string;
  readonly items: readonly ParsedReceiptLine[];
  readonly subtotal: number | null;
  readonly taxes: readonly ParsedReceiptCharge[];
  readonly serviceCharge: number | null;
  readonly tip: number | null;
  readonly discounts: readonly ParsedReceiptCharge[];
  readonly grandTotal: number;
}

/** A line the model was unsure about, or one the arithmetic disagrees with. */
export interface ReceiptProblem {
  readonly kind: 'low_confidence' | 'does_not_reconcile' | 'no_items' | 'negative_line';
  readonly itemIndex?: number;
  readonly message: string;
}

export interface ReceiptCheck {
  /** True when items + charges − discounts equals the printed total. */
  readonly reconciles: boolean;
  /** printed total − computed total, in minor units. Signed. */
  readonly difference: number;
  readonly itemsTotal: number;
  readonly extras: number;
  readonly problems: readonly ReceiptProblem[];
  /** Lines a human should look at before this becomes an expense. */
  readonly needsReview: readonly number[];
}

/**
 * Below this, a line is surfaced for correction rather than accepted.
 *
 * The model reports its own confidence per line; a faded thermal receipt or a
 * Tamil item name it half-read comes back low. The number is a product
 * decision, not a model one: 0.75 is roughly "would a person squint at this?"
 */
export const LOW_CONFIDENCE = 0.75;

/**
 * How far the arithmetic may be out and still be accepted.
 *
 * One minor unit, because real receipts round their own tax lines and a single
 * paisa of drift is the printer's, not ours (TDR §6). Anything larger means we
 * misread something, and the user is asked rather than told.
 */
export const RECONCILE_TOLERANCE = 1;
