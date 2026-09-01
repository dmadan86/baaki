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
import type { CategoryMeta } from '../category/catalog';
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
  // Personal-scope kinds (TDR A34). A capture is an expense caught before it has
  // a group — it carries no members and no split, so it cannot be an `expenses`
  // row (that table is group-scoped, NOT NULL). It rides the same offline queue
  // under a *personal scope*: the envelope's `groupId` slot holds the owner's
  // user id, so ordering is per-user and the server authorises by ownership
  // rather than group membership. `capture.assign` records the moment a capture
  // became a real expense in some group; the expense itself is a normal
  // `expense.create` on that group's scope.
  CaptureCreate = 'capture.create',
  CaptureUpdate = 'capture.update',
  CaptureDelete = 'capture.delete',
  CaptureAssign = 'capture.assign',
  // Personal-scope kinds for the user's expense-tag catalog (extends TDR §8).
  // Like captures they ride a personal scope, but their own cursor key
  // (`categoryTagsScope`) so the two do not share a cursor. A create/update is an
  // upsert by `tagId`; a built-in the person hides or reorders gets an override
  // row through the same upsert. Delete soft-removes a custom tag.
  TagCreate = 'tag.create',
  TagUpdate = 'tag.update',
  TagDelete = 'tag.delete',
  // Trip plan + budgets (A23) — group-scoped, so unlike captures these carry a
  // real group id in the envelope and are authorised by membership. Plan items
  // get create/update/delete; a personal budget is a single upsert with an
  // explicit clear; the overall budget stays admin-gated through its own kind.
  PlanItemCreate = 'plan_item.create',
  PlanItemUpdate = 'plan_item.update',
  PlanItemDelete = 'plan_item.delete',
  MemberBudgetSet = 'member_budget.set',
  MemberBudgetClear = 'member_budget.clear',
  GroupBudgetSet = 'group_budget.set',
  CategoryBudgetSet = 'category_budget.set',
  // The trip's shared exchange rate for one currency, in the group row's
  // `fx_rates` map. Admin-gated in its RPC like the budgets; a null ratio clears
  // that currency's entry.
  GroupFxRateSet = 'group_fx_rate.set',
  // Personal-scope kinds for the private personal-finance ledger (A48): solo
  // expenses/income, recurring rules, loans and monthly budgets. Like captures
  // they ride a personal scope, under their own suffixed cursor
  // (`personalScope`). One generic upsert/delete pair covers all four record
  // kinds; `recordKind` in the payload says which, and the `data` blob is opaque
  // to the server, which only relays it. A delete is a soft tombstone.
  PersonalUpsert = 'personal.upsert',
  PersonalDelete = 'personal.delete',
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
  /** How the money moved: cash | credit | debit | forex. Optional. */
  readonly paymentMethod?: PaymentMethod | null;
  /**
   * An anyone-with-link view of the owner's OWN cloud copy of the receipt, so
   * group members can see the bill (E3). Optional and null unless the owner
   * explicitly opted in; the image itself never touches Waves.
   */
  readonly receiptShareUrl?: string | null;
  /**
   * Denormalised {label, icon, tint} of a custom tag (extends TDR §8), so a
   * group member without the author's catalog still renders it. Null/omitted for
   * a built-in category, which every client resolves from its own list.
   */
  readonly categoryMeta?: CategoryMeta | null;
  /**
   * Where the spend happened (A43), set only on explicit opt-in. A {lat, lng,
   * name} snapshot — the name is reverse-geocoded on the device that captured
   * it, so a member reading the expense sees a place, not two numbers. Null/
   * omitted unless the person tapped "Add location"; never a background track,
   * and never part of the split or a balance.
   */
  readonly location?: ExpenseLocation | null;
}

/** The four ways an expense is paid for; optional everywhere it appears. */
export type PaymentMethod = 'cash' | 'upi' | 'credit' | 'debit' | 'forex';

/**
 * Where an expense was incurred (A43). `lat`/`lng` are WGS84 degrees; `name` is
 * an optional reverse-geocoded label ("Third Wave Coffee, Indiranagar") — absent
 * when the lookup failed or ran offline, in which case the UI shows the point on
 * a map instead. A plain snapshot, never part of any ledger maths.
 */
export interface ExpenseLocation {
  readonly lat: number;
  readonly lng: number;
  readonly name?: string | null;
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

/**
 * A captured expense with no group yet (TDR A34). Everything a normal expense
 * knows *before* there are members to split it among: what it cost, roughly
 * what for, when, and the receipt behind it. No payer, no participants, no
 * split — those are decided at assignment, against a specific group's members.
 */
export interface CaptureCreatePayload {
  readonly captureId: string;
  readonly description: string;
  readonly category?: string | null;
  readonly expenseDate: string;
  readonly currency: CurrencyCode;
  readonly amount: string; // bigint serialised as a decimal string
  readonly notes?: string | null;
  /** Storage path of the receipt photo, owner-scoped; null when none. */
  readonly photoPath?: string | null;
  /** On-device OCR text (ADR-008 / A5), kept so assignment can prefill. */
  readonly rawText?: string | null;
  /** Parsed receipt fields, if the scan produced any. */
  readonly parsed?: Readonly<Record<string, unknown>> | null;
  /** How it was paid: 'cash' | 'credit' | 'debit' | 'forex'. Null until chosen. */
  readonly paymentMethod?: string | null;
  /** Intended destination group, chosen up front; null means decide later. */
  readonly targetGroupId?: string | null;
  /** Denormalised custom-tag display, carried onto the expense at assignment
   *  (extends TDR §8). Null for a built-in category. */
  readonly categoryMeta?: CategoryMeta | null;
  /** Where the spend happened (A43), carried onto the expense at assignment.
   *  Null unless the owner opted in. See {@link ExpenseLocation}. */
  readonly location?: ExpenseLocation | null;
}

/**
 * A row of the user's personal expense-tag catalog (extends TDR §8). An upsert
 * by `tagId`: a custom tag carries `label`/`icon`/`tint`; a hidden or reordered
 * built-in carries `builtinId` plus its `sortOrder`/`hidden` bookkeeping.
 */
export interface TagUpsertPayload {
  readonly tagId: string;
  /** Set → this row overrides a built-in (its id); null/omitted → a custom tag. */
  readonly builtinId?: string | null;
  readonly label?: string | null;
  readonly icon?: string | null;
  readonly tint?: string | null;
  readonly sortOrder: number;
  readonly hidden: boolean;
}

export type TagCreatePayload = TagUpsertPayload;
export type TagUpdatePayload = TagUpsertPayload;

export interface TagDeletePayload {
  readonly tagId: string;
}

/** Editing a capture before it is assigned. Last write wins — a capture has one owner and no versions. */
export type CaptureUpdatePayload = CaptureCreatePayload;

export interface CaptureDeletePayload {
  readonly captureId: string;
}

/**
 * Records that a capture turned into a real expense. The expense itself is a
 * normal {@link ExpenseCreatePayload} on the target group's scope; this only
 * closes the capture so it leaves the inbox and cannot be assigned twice.
 */
export interface CaptureAssignPayload {
  readonly captureId: string;
  /** The group the expense was created in. */
  readonly groupId: string;
  /** The expense the capture became. */
  readonly expenseId: string;
}

/**
 * Trip plan + budgets (A23). Amounts are minor-unit decimal strings, like every
 * other money field on the wire. `itemId` is client-chosen and the idempotency
 * key, so a replayed create returns the same row.
 */
export interface PlanItemCreatePayload {
  readonly itemId: string;
  readonly day: string;
  readonly title: string;
  readonly startsAt?: string | null;
  readonly note?: string | null;
  readonly category?: string | null;
  readonly plannedMinor?: string | null;
  readonly currency?: CurrencyCode | null;
}

export interface PlanItemUpdatePayload {
  readonly itemId: string;
  readonly day?: string;
  readonly title?: string;
  readonly startsAt?: string | null;
  readonly note?: string | null;
  readonly category?: string | null;
  readonly plannedMinor?: string | null;
  readonly done?: boolean;
  readonly expenseId?: string | null;
  /** Fields to clear to NULL — maps to the RPC's `p_clear text[]`. Only the
   *  nullable plan-item columns; anything else the RPC would ignore anyway. */
  readonly clear?: readonly PlanItemClearField[];
}

/** The nullable plan-item columns a {@link PlanItemUpdatePayload} may clear. */
export type PlanItemClearField = 'starts_at' | 'note' | 'category' | 'planned_minor' | 'expense_id';

export interface PlanItemDeletePayload {
  readonly itemId: string;
}

export interface MemberBudgetSetPayload {
  readonly amountMinor: string;
  readonly currency?: CurrencyCode | null;
  readonly visibility: 'private' | 'group';
}

/** Clearing carries nothing — the scope (group) and the caller identify the row. */
export type MemberBudgetClearPayload = Record<string, never>;

/** The overall trip budget on the group row; null amount clears it. Admin-only. */
export interface GroupBudgetSetPayload {
  readonly amountMinor: string | null;
  readonly currency?: CurrencyCode | null;
}

/**
 * A per-category cap in the group row's `category_budgets` map, keyed by the
 * category id (a built-in key or a custom tag id). A null amount removes that
 * category's cap. Admin-only, like the overall budget — a category cap is a
 * group signal, never private.
 */
export interface CategoryBudgetSetPayload {
  readonly category: string;
  readonly amountMinor: string | null;
  readonly currency?: CurrencyCode | null;
}

/**
 * The trip's pinned rate for one currency in the group's `fx_rates` map, keyed
 * by the currency paid in (`from`); the `to` is always the group's settle
 * currency, so it is not carried. A null `num`/`den` clears that currency's
 * entry. The rate is the exact rational the client already computed — never a
 * decimal (ADR-003). Admin-only, like the budgets: one shared rate is a group
 * signal, never private.
 */
export interface GroupFxRateSetPayload {
  readonly from: CurrencyCode;
  readonly num: string | null;
  readonly den: string | null;
  readonly source?: string;
}

/** The four kinds of row the personal-finance ledger holds (A48). */
export type PersonalRecordKind = 'txn' | 'recurring' | 'loan' | 'budget';

/**
 * An upsert of one personal-finance record (A48). `recordId` is client-chosen
 * and the idempotency key. `data` carries the record's fields shaped by
 * `recordKind` — money fields are minor-unit decimal strings, like everywhere
 * on the wire — and is opaque to the server, which stores and relays it without
 * reading it (all summaries and balances are computed on the device).
 */
export interface PersonalUpsertPayload {
  readonly recordId: string;
  readonly recordKind: PersonalRecordKind;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Soft-deletes one personal-finance record; the tombstone rides the pull. */
export interface PersonalDeletePayload {
  readonly recordId: string;
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
  /** Personal scope (TDR A34): captured expenses not yet assigned to a group. */
  Captures = 'captures',
  /** Personal scope (A38): the viewer's ghost merges, pull-only, so Friends can
   * fold merged guests offline. Never written through the queue. */
  GhostMerges = 'ghost_merges',
  /** Personal scope (extends TDR §8): the user's expense-tag catalog — custom
   * tags plus their hidden/reordered built-ins. Read + write. */
  CategoryTags = 'category_tags',
  /** Group-scoped, read+write (A23). The trip plan is not money, so it never
   * touches a balance — but it is a group's shared list and belongs offline. */
  TripPlanItems = 'trip_plan_items',
  /** Group-scoped, read+write. A member's personal spend ceiling for a trip;
   * a `private` one is only ever pulled to its owner (RLS). */
  TripMemberBudgets = 'trip_member_budgets',
  /** Group-scoped but PARTY-filtered by RLS (private attachments). A payment
   * proof, visible to the settlement's two parties only. Pull-only here: the
   * write is a direct SECURITY DEFINER RPC (the bytes need an online upload
   * anyway), so there is no mutation kind — only the read rides the mirror, and
   * the pull reads as the caller so a non-party never receives the row. */
  SettlementProofs = 'settlement_proofs',
  /** Group-scoped, RLS-filtered: a `group` attachment is visible to any member,
   * a `parties` one only to the expense's payers/author. Pull-only, like the
   * proofs above. */
  ExpenseAttachments = 'expense_attachments',
  /** Group-scoped, group-visible: a comment thread on one expense. Pull-only —
   * the writes (add/edit/delete/flag) are direct SECURITY DEFINER RPCs that
   * enforce the role matrix (author edits/deletes own, admin deletes any, any
   * member flags), so there is no mutation kind; only the read rides the mirror. */
  ExpenseComments = 'expense_comments',
  /** Group-scoped, append-only image audit: who added/removed a receipt or an
   * attachment on one expense, and when. Pull-only — the writes are the receipt
   * log RPC and the attachment RPCs, which stamp the actor from the session; a
   * `parties` row is RLS-filtered so a non-party never receives it. */
  ExpenseImageEvents = 'expense_image_events',
  /** Personal scope (A48): the caller's own personal-finance ledger — solo
   * expenses/income, recurring rules, loans and budgets. Read + write, one
   * generic row per record, keyed by the owner's user id under `personalScope`. */
  PersonalRecords = 'personal_records',
}

/**
 * The sync scope key for a viewer's ghost merges. Distinct from the plain
 * profile id that captures uses, so the two personal-scope tables keep separate
 * cursors instead of starving one another. The edge and the client must agree
 * on this string, so it lives here.
 */
export function ghostMergesScope(profileId: string): string {
  return `${profileId}:ghost_merges`;
}

/**
 * The sync scope key for a viewer's category-tag catalog. Distinct from the bare
 * profile id captures uses and from `ghostMergesScope`, so each personal-scope
 * table keeps its own cursor. The edge and the client must agree on this string.
 */
export function categoryTagsScope(profileId: string): string {
  return `${profileId}:category_tags`;
}

/**
 * The sync scope key for a user's personal-finance ledger (A48). Suffixed, so it
 * keeps its own cursor apart from captures, ghost merges and the tag catalog.
 * The edge and the client must agree on this string.
 */
export function personalScope(profileId: string): string {
  return `${profileId}:personal`;
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
