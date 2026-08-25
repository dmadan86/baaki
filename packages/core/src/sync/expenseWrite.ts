/**
 * The one serialization contract for writing an expense — shared by every path
 * that reaches `baaki_apply_expense`, so an expense written online, offline, from
 * the phone or from the browser carries the *same* fields (TDR §4).
 *
 * There are two boundaries an expense write crosses, and this module owns both:
 *
 *   1. **client → edge** ({@link buildExpenseWriteBody}): the JSON body a direct
 *      caller POSTs to the `expense-write` function. The mobile `api.ts` and the
 *      web `api-client` both build it here, so neither can quietly drop a field
 *      the other sends.
 *
 *   2. **edge → RPC** ({@link buildApplyExpenseArgs}): the named arguments both
 *      the `expense-write` and the `/sync` edge functions pass to
 *      `baaki_apply_expense`. Built here, so the direct write and the queued
 *      write are byte-for-byte the same call — the bug this module exists to
 *      prevent was `expense-write` silently omitting `p_category_meta` and
 *      `p_base_version_no`, which made a direct edit lose custom-tag display and
 *      skip the concurrent-edit conflict check that `/sync` had.
 *
 * The two validators ({@link sanitiseCategoryMeta}, {@link sanitiseExpenseLocation})
 * live here too: both are denormalised snapshots shown to every group member, so
 * a client can never write a NaN point or an unknown tint onto a ledger row.
 *
 * Pure and dependency-free like the rest of `@waves/core`, so the Deno edge
 * bundle, the React Native app and the browser client all compute one shape.
 */

import { normaliseTint, type CategoryMeta } from '../category/catalog';
import type { FxRecord } from '../money/fx';
import type { SplitParams } from '../split/types';
import { serialiseSplitParams } from '../split/wire';
import type { ExpenseLocation, PaymentMethod } from './protocol';

// ───────────────────────────────────────────────────────── validators ──

/**
 * Validate the denormalised custom-tag display before it lands on a ledger row
 * (extends TDR §8). Anything not a proper {label, icon, tint} object becomes
 * null (a built-in, which every client resolves from its own catalog); an
 * unknown tint is coerced to a safe default rather than trusted, because the
 * payload is client text and this snapshot is shown to every group member.
 */
export function sanitiseCategoryMeta(value: unknown): CategoryMeta | null {
  if (!value || typeof value !== 'object') return null;
  const meta = value as Record<string, unknown>;
  const label = typeof meta.label === 'string' ? meta.label.trim() : '';
  const icon = typeof meta.icon === 'string' ? meta.icon.trim() : '';
  if (!label || !icon) return null;
  return {
    label: label.slice(0, 40),
    icon: icon.slice(0, 64),
    tint: normaliseTint(meta.tint as string),
  };
}

/**
 * Validate a client-supplied location before it lands on a ledger row (A43).
 * Only a proper {lat, lng} inside Earth's ranges survives; the name is an
 * optional trimmed label. Anything else — junk, NaN, an out-of-range point —
 * becomes null, so a snapshot every group member sees can never carry garbage.
 */
export function sanitiseExpenseLocation(value: unknown): ExpenseLocation | null {
  if (!value || typeof value !== 'object') return null;
  const loc = value as Record<string, unknown>;
  const lat = typeof loc.lat === 'number' ? loc.lat : NaN;
  const lng = typeof loc.lng === 'number' ? loc.lng : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const name = typeof loc.name === 'string' ? loc.name.trim().slice(0, 120) : '';
  return name ? { lat, lng, name } : { lat, lng };
}

// ─────────────────────────────────────────────── client → edge body ──

/**
 * Everything a direct caller (mobile `api.ts`, web `api-client`) needs to write
 * an expense through the `expense-write` function. Money is bigint here and
 * serialised to decimal strings on the way out — JSON has no bigint. Split
 * params arrive already in wire form (`serialiseSplitParams`), because a caller
 * that holds an itemized split has to stringify its minor units before this.
 */
export interface ExpenseWriteBodyInput {
  readonly groupId: string;
  /** Pass an id to append a new version to an existing expense (ADR-004). */
  readonly expenseId?: string;
  readonly description: string;
  readonly category?: string | null;
  readonly expenseDate: string;
  readonly currency: string;
  readonly amount: bigint;
  /** Already in wire form — `serialiseSplitParams(params)`. */
  readonly splitParams: unknown;
  readonly participants: readonly string[];
  readonly payers: Readonly<Record<string, bigint>>;
  /** The caller's own share computation, checked against the server's. */
  readonly expectedShares?: Readonly<Record<string, bigint>>;
  readonly notes?: string | null;
  /** How the money moved: cash | upi | credit | debit | forex. */
  readonly paymentMethod?: PaymentMethod | null;
  /** Denormalised custom-tag display (extends TDR §8); null for a built-in. */
  readonly categoryMeta?: CategoryMeta | null;
  /** Where the spend happened (A43); null unless the person opted in. */
  readonly location?: ExpenseLocation | null;
  /** A view-only link to the owner's own cloud copy of the receipt (E3). */
  readonly receiptShareUrl?: string | null;
  /** Links a scanned receipt (ADR-008) to this expense; null when none. */
  readonly receiptId?: string | null;
  /** The rate used when the expense is not in the group's currency (ADR-003). */
  readonly fx?: FxRecord | null;
  /**
   * The version the caller edited (ADR-004 / TDR §4.4). Set only for an edit,
   * and only by a caller that had actually seen a version — this is what turns a
   * concurrent edit into a logged conflict instead of a silent overwrite. Its
   * absence on the direct path was the parity hole this shared builder closes.
   */
  readonly baseVersionNo?: number | null;
  /** Idempotency key: a retry after a flaky network must not double-post. */
  readonly clientMutationId: string;
}

/** The JSON body sent to the `expense-write` function. */
export interface ExpenseWriteBody {
  readonly groupId: string;
  readonly expenseId?: string;
  readonly description: string;
  readonly category: string | null;
  readonly expenseDate: string;
  readonly currency: string;
  readonly amount: string;
  readonly splitParams: unknown;
  readonly participants: readonly string[];
  readonly payers: Record<string, string>;
  readonly expectedShares?: Record<string, string>;
  readonly notes: string | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly categoryMeta: CategoryMeta | null;
  readonly location: ExpenseLocation | null;
  readonly receiptShareUrl: string | null;
  readonly receiptId: string | null;
  readonly fx: FxRecord | null;
  readonly baseVersionNo: number | null;
  readonly clientMutationId: string;
}

/**
 * Build the `expense-write` request body from a direct caller's input. Every
 * optional field is emitted explicitly (null when absent), because an
 * append-only version is a full snapshot: an omitted method and an explicit null
 * both have to mean "none", or an edit would inherit the previous version's value.
 */
export function buildExpenseWriteBody(input: ExpenseWriteBodyInput): ExpenseWriteBody {
  return {
    groupId: input.groupId,
    expenseId: input.expenseId,
    description: input.description,
    category: input.category ?? null,
    expenseDate: input.expenseDate,
    currency: input.currency,
    amount: input.amount.toString(),
    splitParams: input.splitParams,
    participants: input.participants,
    payers: Object.fromEntries(
      Object.entries(input.payers).map(([id, value]) => [id, value.toString()]),
    ),
    expectedShares: input.expectedShares
      ? Object.fromEntries(
          Object.entries(input.expectedShares).map(([id, value]) => [id, value.toString()]),
        )
      : undefined,
    notes: input.notes ?? null,
    paymentMethod: input.paymentMethod ?? null,
    categoryMeta: input.categoryMeta ?? null,
    location: input.location ?? null,
    receiptShareUrl: input.receiptShareUrl ?? null,
    receiptId: input.receiptId ?? null,
    fx: input.fx ?? null,
    baseVersionNo: input.baseVersionNo ?? null,
    clientMutationId: input.clientMutationId,
  };
}

// ─────────────────────────────────────────────────── edge → RPC args ──

/**
 * The validated pieces an edge function has after it has parsed the amount,
 * parsed the split params and recomputed the shares with `computeShares`. Money
 * is bigint; the builder serialises it to the decimal strings the RPC's jsonb
 * arguments expect. `categoryMeta` and `location` arrive raw (client text) and
 * are sanitised in the builder — the one place either is validated.
 */
export interface ApplyExpenseArgsInput {
  readonly groupId: string;
  /** Already resolved — a create mints a fresh id before calling. */
  readonly expenseId: string;
  readonly authorMemberId: string;
  readonly description: string;
  readonly category?: string | null;
  readonly expenseDate: string;
  readonly currency: string;
  readonly amount: bigint;
  /** Parsed split params — the canonical wire form is derived here. */
  readonly splitParams: SplitParams;
  readonly payers: ReadonlyArray<readonly [string, bigint]>;
  readonly shares: Iterable<readonly [string, bigint]>;
  readonly clientMutationId: string;
  readonly notes?: string | null;
  readonly receiptId?: string | null;
  readonly baseVersionNo?: number | null;
  readonly fx?: FxRecord | null;
  readonly paymentMethod?: string | null;
  readonly receiptShareUrl?: string | null;
  /** Raw client value; sanitised in the builder. */
  readonly categoryMeta?: unknown;
  /** Raw client value; sanitised in the builder. */
  readonly location?: unknown;
}

/** The named arguments passed to `baaki_apply_expense`. `p_source` is left to
 *  its default ('manual') by every caller, so it is not built here. */
export interface ApplyExpenseRpcArgs {
  readonly p_group_id: string;
  readonly p_expense_id: string;
  readonly p_author_member_id: string;
  readonly p_description: string;
  readonly p_category: string | null;
  readonly p_expense_date: string;
  readonly p_currency: string;
  readonly p_amount: string;
  readonly p_split_type: string;
  readonly p_split_params: unknown;
  readonly p_payers: { memberId: string; amount: string }[];
  readonly p_shares: { memberId: string; amount: string }[];
  readonly p_client_mutation_id: string;
  readonly p_notes: string | null;
  readonly p_receipt_id: string | null;
  readonly p_base_version_no: number | null;
  readonly p_fx: FxRecord | null;
  readonly p_payment_method: string | null;
  readonly p_receipt_share_url: string | null;
  readonly p_category_meta: CategoryMeta | null;
  readonly p_location: ExpenseLocation | null;
}

/**
 * Build the `baaki_apply_expense` arguments. Both the direct (`expense-write`)
 * and the queued (`/sync`) edge paths call this, so the RPC receives an
 * identical set of fields whichever path a write took — the single source of
 * truth for "what a write consists of".
 */
export function buildApplyExpenseArgs(input: ApplyExpenseArgsInput): ApplyExpenseRpcArgs {
  return {
    p_group_id: input.groupId,
    p_expense_id: input.expenseId,
    p_author_member_id: input.authorMemberId,
    p_description: input.description,
    p_category: input.category ?? null,
    p_expense_date: input.expenseDate,
    p_currency: input.currency.toUpperCase(),
    p_amount: input.amount.toString(),
    p_split_type: input.splitParams.kind,
    // Stored in the canonical wire form: minor units as strings, whatever the
    // client happened to send. A number in jsonb is a double.
    p_split_params: serialiseSplitParams(input.splitParams),
    p_payers: input.payers.map(([id, value]) => ({ memberId: id, amount: value.toString() })),
    p_shares: [...input.shares].map(([id, value]) => ({ memberId: id, amount: value.toString() })),
    p_client_mutation_id: input.clientMutationId,
    p_notes: input.notes ?? null,
    p_receipt_id: input.receiptId ?? null,
    p_base_version_no: input.baseVersionNo ?? null,
    p_fx: input.fx ?? null,
    p_payment_method: input.paymentMethod ?? null,
    p_receipt_share_url: input.receiptShareUrl ?? null,
    p_category_meta: sanitiseCategoryMeta(input.categoryMeta),
    p_location: sanitiseExpenseLocation(input.location),
  };
}
