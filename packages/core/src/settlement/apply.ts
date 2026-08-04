/**
 * Settlement application (ADR-007 / TDR §3.3).
 *
 * Partial and per-expense settlement is first-class: a settlement may carry
 * explicit allocations against specific expenses; whatever is left over applies
 * to the pair's overall balance oldest-expense-first.
 */

import type { CurrencyCode } from '../money/currency';
import type { MemberId } from '../split/types';
import type { SettlementAllocation, SettlementSnapshot } from '../balances/types';

export interface Receivable {
  readonly expenseId: string;
  /** ISO date; ties broken by expenseId so ordering is total and stable. */
  readonly date: string;
  /** Outstanding amount `from` still owes `to` for this expense, > 0. */
  readonly amount: bigint;
}

export type SettlementErrorCode =
  | 'ALLOCATION_EXCEEDS_SETTLEMENT'
  | 'ALLOCATION_EXCEEDS_RECEIVABLE'
  | 'UNKNOWN_RECEIVABLE'
  | 'NON_POSITIVE_AMOUNT';

export class SettlementError extends Error {
  readonly code: SettlementErrorCode;

  constructor(code: SettlementErrorCode, message: string) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

export interface AllocationResult {
  /** Final per-expense allocation, explicit ones first then oldest-first. */
  readonly allocations: SettlementAllocation[];
  /** Amount that could not be matched to any expense (advance payment). */
  readonly unallocated: bigint;
}

/**
 * Resolve a settlement into concrete per-expense allocations.
 * `receivables` is what `from` currently owes `to`, one row per expense.
 */
export function allocateSettlement(
  settlement: Pick<SettlementSnapshot, 'amount' | 'allocations'>,
  receivables: readonly Receivable[],
): AllocationResult {
  if (settlement.amount <= 0n) {
    throw new SettlementError('NON_POSITIVE_AMOUNT', 'A settlement must be for a positive amount');
  }

  const outstanding = new Map<string, bigint>();
  for (const receivable of receivables) {
    outstanding.set(
      receivable.expenseId,
      (outstanding.get(receivable.expenseId) ?? 0n) + receivable.amount,
    );
  }

  const allocations: SettlementAllocation[] = [];
  let remaining = settlement.amount;

  for (const explicit of settlement.allocations ?? []) {
    if (explicit.amount <= 0n) {
      throw new SettlementError('NON_POSITIVE_AMOUNT', 'Allocation amounts must be positive');
    }
    if (!outstanding.has(explicit.expenseId)) {
      throw new SettlementError(
        'UNKNOWN_RECEIVABLE',
        `Expense ${explicit.expenseId} carries no debt between these two members`,
      );
    }
    const available = outstanding.get(explicit.expenseId) ?? 0n;
    if (explicit.amount > available) {
      throw new SettlementError(
        'ALLOCATION_EXCEEDS_RECEIVABLE',
        `Allocated ${explicit.amount} to expense ${explicit.expenseId} but only ${available} is outstanding`,
      );
    }
    if (explicit.amount > remaining) {
      throw new SettlementError(
        'ALLOCATION_EXCEEDS_SETTLEMENT',
        'Allocations add up to more than the settlement amount',
      );
    }
    allocations.push({ expenseId: explicit.expenseId, amount: explicit.amount });
    outstanding.set(explicit.expenseId, available - explicit.amount);
    remaining -= explicit.amount;
  }

  // Oldest first, ties broken by id for determinism.
  const oldestFirst = [...receivables].sort(
    (a, b) => a.date.localeCompare(b.date) || a.expenseId.localeCompare(b.expenseId),
  );

  for (const receivable of oldestFirst) {
    if (remaining === 0n) break;
    const available = outstanding.get(receivable.expenseId) ?? 0n;
    if (available <= 0n) continue;
    const amount = available < remaining ? available : remaining;
    allocations.push({ expenseId: receivable.expenseId, amount });
    outstanding.set(receivable.expenseId, available - amount);
    remaining -= amount;
  }

  return { allocations: mergeAllocations(allocations), unallocated: remaining };
}

function mergeAllocations(allocations: readonly SettlementAllocation[]): SettlementAllocation[] {
  const merged = new Map<string, bigint>();
  for (const allocation of allocations) {
    merged.set(allocation.expenseId, (merged.get(allocation.expenseId) ?? 0n) + allocation.amount);
  }
  return [...merged.entries()]
    .map(([expenseId, amount]) => ({ expenseId, amount }))
    .sort((a, b) => a.expenseId.localeCompare(b.expenseId));
}

/** UPI intent URI (ADR-007 / TDR §5). Baaki never touches the money itself. */
export interface UpiIntentInput {
  readonly vpa: string;
  readonly payeeName: string;
  /** Amount in minor units. */
  readonly amount: bigint;
  readonly currency: CurrencyCode;
  readonly note?: string;
}

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;

export function isValidVpa(vpa: string): boolean {
  return VPA_RE.test(vpa);
}

/** UPI caps the transaction note; keep it short and safe to URL-encode. */
export const UPI_NOTE_MAX_LENGTH = 50;

export function buildUpiIntentUri(
  input: UpiIntentInput,
  formatMajor: (amount: bigint, currency: CurrencyCode) => string,
): string {
  if (!isValidVpa(input.vpa)) {
    throw new SettlementError('UNKNOWN_RECEIVABLE', `"${input.vpa}" is not a valid UPI ID`);
  }
  // Built by hand rather than with URLSearchParams: this package has to compile
  // unchanged for React Native, Deno and the browser, with no lib assumptions.
  const params: [string, string][] = [
    ['pa', input.vpa],
    ['pn', input.payeeName],
    ['am', formatMajor(input.amount, input.currency)],
    ['cu', input.currency],
  ];
  if (input.note) {
    params.push(['tn', input.note.slice(0, UPI_NOTE_MAX_LENGTH)]);
  }
  const query = params
    .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`)
    .join('&');
  return `upi://pay?${query}`;
}

/** Settlement state machine (ADR-007). */
export const SETTLEMENT_AUTO_CONFIRM_DAYS = 7;

export type SettlementTransition = 'confirm' | 'dispute' | 'cancel' | 'auto_confirm';

const TRANSITIONS: Readonly<Record<string, readonly SettlementTransition[]>> = {
  initiated: ['confirm', 'dispute', 'cancel', 'auto_confirm'],
  confirmed: [],
  auto_confirmed: ['dispute'],
  disputed: ['confirm', 'cancel'],
  cancelled: [],
};

export function canTransition(
  status: SettlementSnapshot['status'],
  transition: SettlementTransition,
): boolean {
  return (TRANSITIONS[status] ?? []).includes(transition);
}

export function settlementParticipants(
  settlement: Pick<SettlementSnapshot, 'from' | 'to'>,
): readonly MemberId[] {
  return [settlement.from, settlement.to];
}
