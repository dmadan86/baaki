/**
 * sync — the offline queue's other half (ADR-005 / TDR §4).
 *
 * One POST does both directions: it applies the client's queued mutations in
 * the order they were made, then returns everything that has changed in the
 * client's groups since its cursor. Push and pull share a request because they
 * have to share an instant — pulling separately would let a client see its own
 * write land twice, or not at all.
 *
 * Three invariants this function exists to hold:
 *
 *   **Replay is free.** Every mutation is keyed by a client-generated UUID and
 *   recorded in `sync_mutations` with the result it produced. A queue replayed
 *   after a crash gets the original answers back, not a second expense.
 *
 *   **The client never computes money.** Shares are recomputed here from
 *   `split_params` with the same @waves/core the app uses, and a client whose
 *   arithmetic disagrees is rejected with SHARE_MISMATCH rather than believed.
 *
 *   **One bad mutation is not a broken app.** A rejection is reported per
 *   mutation; the rest of the batch still applies, and the client is told
 *   exactly which one failed and why.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
  computeShares,
  GUEST_TRIAL_DAYS,
  parseSplitParams,
  serialiseSplitParams,
  verifyClientShares,
  type FxRecord,
  type SplitParams,
} from '../_shared/core.js';
import {
  asCaller,
  asService,
  serveWithCors,
  errorResponse,
  HttpError,
  json,
  parseMinor,
} from '../_shared/auth.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';

type MutationKind =
  | 'expense.create'
  | 'expense.update'
  | 'expense.delete'
  | 'expense.restore'
  | 'settlement.create'
  | 'settlement.transition'
  | 'member.add_ghost'
  | 'group.create'
  | 'group.update'
  // Personal-scope kinds (TDR A34): a capture is owned by one user and its
  // envelope `groupId` carries that user's own id, not a group. Authorised by
  // ownership rather than membership, and recorded with a null group.
  | 'capture.create'
  | 'capture.update'
  | 'capture.delete'
  | 'capture.assign'
  // The user's expense-tag catalog (extends TDR §8): personal like captures, but
  // under its own suffixed scope key so it keeps a separate cursor.
  | 'tag.create'
  | 'tag.update'
  | 'tag.delete'
  // Trip plan + budgets (A23) — group-scoped, authorised by membership, so NOT
  // in isPersonalKind below.
  | 'plan_item.create'
  | 'plan_item.update'
  | 'plan_item.delete'
  | 'member_budget.set'
  | 'member_budget.clear'
  | 'group_budget.set';

/** True for the kinds whose scope is a user, not a group. */
function isPersonalKind(kind: MutationKind): boolean {
  return (
    kind === 'capture.create' ||
    kind === 'capture.update' ||
    kind === 'capture.delete' ||
    kind === 'capture.assign' ||
    kind === 'tag.create' ||
    kind === 'tag.update' ||
    kind === 'tag.delete'
  );
}

/** The personal-scope key for a user's category-tag catalog. Must match the
 *  client's `categoryTagsScope`; unlike captures (bare profile id) it is
 *  suffixed, so the two personal scopes keep separate cursors. */
function categoryTagsScope(profileId: string): string {
  return `${profileId}:category_tags`;
}

interface MutationEnvelope {
  clientMutationId: string;
  kind: MutationKind;
  groupId: string;
  clientCreatedAt: string;
  payload: Record<string, unknown>;
}

/** Columns a member is allowed to set via `group.update` (mirrors client `updateGroup`). */
const GROUP_UPDATABLE_FIELDS = [
  'name',
  'type',
  'cover_emoji',
  'photo_path',
  'simplify_debts',
  'default_currency',
  'country_code',
  'archived_at',
  'start_date',
  'end_date',
  'time_zone',
  'remind_daily',
  'remind_morning_at',
  'remind_evening_at',
] as const;

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

interface SyncRequest {
  deviceId?: string;
  mutations?: MutationEnvelope[];
  cursors?: Record<string, number>;
}

type Outcome =
  | { clientMutationId: string; status: 'applied'; result?: unknown }
  | { clientMutationId: string; status: 'duplicate'; result?: unknown }
  | { clientMutationId: string; status: 'rejected'; code: string; message: string };

interface SyncChange {
  table: string;
  groupId: string;
  seq: number;
  row: Record<string, unknown>;
}

/** A batch bigger than this is a bug or an attack, not a weekend in a dead zone. */
const MAX_MUTATIONS = 200;
/** Per group, per pull. A client behind by more simply pulls again. */
const MAX_ROWS_PER_TABLE = 500;

const EXPENSE_SELECT = `
  id, group_id, deleted_at, created_at, updated_seq,
  currentVersion:expense_versions!expenses_current_version_id_fkey (
    id, version_no, description, category, category_meta, expense_date, currency, amount,
    split_type, split_params, author_member_id, notes, payment_method, created_at,
    payers:expense_payers ( member_id, amount ),
    shares:expense_shares ( member_id, amount )
  )
`;

const SETTLEMENT_SELECT = `
  id, group_id, from_member_id, to_member_id, currency, amount, method, status, note,
  initiated_at, confirmed_at, updated_seq,
  allocations:settlement_allocations ( expense_id, amount )
`;

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const body = (await request.json()) as SyncRequest;
    const mutations = body.mutations ?? [];
    const cursors = body.cursors ?? {};

    if (mutations.length > MAX_MUTATIONS) {
      throw new HttpError(
        413,
        'BATCH_TOO_LARGE',
        `Send at most ${MAX_MUTATIONS} mutations per request`,
      );
    }

    const caller = asCaller(request);
    const service = asService();

    const { data: user, error: userError } = await caller.auth.getUser();
    if (userError || !user?.user) {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign in first');
    }
    const profileId = user.user.id;

    // A guest's writes stop after the trial (ADR-006 addendum); the pull below
    // still runs, so everything they made stays visible — read-only, not gone.
    // Mirrors GUEST_TRIAL_DAYS in @waves/core, the number the app gates on too.
    const guestExpired =
      user.user.is_anonymous === true &&
      Date.now() >=
        new Date(user.user.created_at).getTime() + GUEST_TRIAL_DAYS * 24 * 60 * 60 * 1000;

    // After the identity is known, so a person is counted rather than whatever
    // address they happen to be behind — a café full of users on one NAT is not
    // one abuser.
    await enforceRateLimit(service, request, 'sync', profileId);

    const session = new SyncSession(caller, service, profileId);
    const outcomes: Outcome[] = [];

    for (const mutation of mutations) {
      if (guestExpired) {
        // Rejected per mutation, not by failing the request: the client keeps
        // the queued write to replay once they sign up, and still gets its pull.
        outcomes.push({
          clientMutationId: mutation.clientMutationId ?? '',
          status: 'rejected',
          code: 'GUEST_TRIAL_EXPIRED',
          message: 'Your guest trial has ended — sign up to keep adding to Baaki',
        });
        continue;
      }
      outcomes.push(await session.apply(mutation));
    }

    // Pull every group the client already knows about, plus any it just
    // created — otherwise a group made offline would stay invisible until the
    // next sync.
    //
    // And every group this person is actually in, which is not the same set. A
    // device that has never synced has no cursors to name, and a group somebody
    // else added you to has no cursor either: without this, "read local-first"
    // could never get its first row, and being invited would do nothing until
    // you happened to open the group by link. The membership read runs as the
    // caller, so it can only ever return groups their own RLS already allows.
    const mine = await caller.from('group_members').select('group_id').is('left_at', null);
    if (mine.error) throw new HttpError(500, 'PULL_FAILED', `memberships: ${mine.error.message}`);

    const groupIds = new Set<string>([
      ...Object.keys(cursors),
      ...session.touchedGroups,
      ...(mine.data ?? []).map((row) => row.group_id as string),
    ]);
    const { changes, cursors: nextCursors } = await pull(caller, groupIds, cursors, profileId);

    return json({
      outcomes,
      changes,
      cursors: nextCursors,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error, { fn: 'sync' });
  }
});

/**
 * Applies one batch, remembering per-group membership so a hundred mutations in
 * one group cost one membership lookup rather than a hundred.
 */
class SyncSession {
  readonly touchedGroups = new Set<string>();
  private readonly memberIds = new Map<string, string | null>();

  constructor(
    private readonly caller: SupabaseClient,
    private readonly service: SupabaseClient,
    private readonly profileId: string,
  ) {}

  async apply(mutation: MutationEnvelope): Promise<Outcome> {
    const { clientMutationId } = mutation;
    if (!clientMutationId) {
      return {
        clientMutationId: '',
        status: 'rejected',
        code: 'VALIDATION_FAILED',
        message: 'Every mutation needs a clientMutationId',
      };
    }

    const personal = isPersonalKind(mutation.kind);

    // Replay: return exactly what the first attempt produced.
    const { data: seen } = await this.service
      .from('sync_mutations')
      .select('result')
      .eq('client_mutation_id', clientMutationId)
      .maybeSingle();
    if (seen) {
      if (!personal) this.touchedGroups.add(mutation.groupId);
      return { clientMutationId, status: 'duplicate', result: seen.result };
    }

    try {
      const result = await this.dispatch(mutation);
      // A capture's scope is the owner, not a group — it must not join the group
      // pull set, and its `groups` FK on the idempotency row would be violated.
      if (!personal) this.touchedGroups.add(mutation.groupId);

      // Recorded after the fact: if the write succeeded but this insert fails,
      // the mutation's own idempotency key (on expense_versions, settlements,
      // or the row's primary key) still stops a replay from acting twice.
      await this.service.from('sync_mutations').insert({
        client_mutation_id: clientMutationId,
        profile_id: this.profileId,
        group_id: personal ? null : mutation.groupId,
        kind: mutation.kind,
        result: result ?? {},
      });

      return { clientMutationId, status: 'applied', result };
    } catch (error) {
      const { code, message } = classify(error);
      return { clientMutationId, status: 'rejected', code, message };
    }
  }

  /** Null when the caller is not in the group. RLS is still the real gate. */
  private async memberId(groupId: string): Promise<string | null> {
    const cached = this.memberIds.get(groupId);
    if (cached !== undefined) return cached;

    const { data, error } = await this.caller.rpc('baaki_my_member_id', { p_group_id: groupId });
    if (error) throw new HttpError(500, 'INTERNAL', error.message);
    const memberId = (data as string | null) ?? null;
    this.memberIds.set(groupId, memberId);
    return memberId;
  }

  private async requireMemberId(groupId: string): Promise<string> {
    const memberId = await this.memberId(groupId);
    if (!memberId) throw new HttpError(403, 'NOT_A_MEMBER', 'You are not a member of this group');
    return memberId;
  }

  private async dispatch(mutation: MutationEnvelope): Promise<unknown> {
    switch (mutation.kind) {
      case 'expense.create':
      case 'expense.update':
        return await this.writeExpense(mutation);
      case 'expense.delete':
        return await this.rpcAsCaller('baaki_delete_expense', {
          p_expense_id: requireString(mutation.payload.expenseId, 'expenseId'),
        });
      case 'expense.restore':
        return await this.rpcAsCaller('baaki_restore_expense', {
          p_expense_id: requireString(mutation.payload.expenseId, 'expenseId'),
        });
      case 'settlement.create':
        return await this.createSettlement(mutation);
      case 'settlement.transition':
        return await this.rpcAsCaller('baaki_confirm_settlement', {
          p_settlement_id: requireString(mutation.payload.settlementId, 'settlementId'),
        });
      case 'member.add_ghost':
        return await this.rpcAsCaller('baaki_add_ghost_member', {
          p_group_id: mutation.groupId,
          p_name: requireString(mutation.payload.name, 'name'),
          p_member_id: (mutation.payload.memberId as string | undefined) ?? null,
          // An address is the whole point of adding somebody from your contacts
          // — it is what lets them claim their share later (ADR-006). This case
          // dropped it, so the same person added offline and online became two
          // different rows.
          p_email: (mutation.payload.email as string | undefined) ?? null,
          p_phone: (mutation.payload.phone as string | undefined) ?? null,
        });
      case 'group.create':
        return await this.rpcAsCaller('baaki_create_group', {
          p_name: requireString(mutation.payload.name, 'name'),
          p_type: (mutation.payload.type as string | undefined) ?? 'other',
          p_currency: (mutation.payload.currency as string | undefined) ?? 'INR',
          p_emoji: (mutation.payload.emoji as string | undefined) ?? null,
          p_simplify: mutation.payload.simplify !== false,
          // The client already chose this id and its queued expenses reference it.
          p_group_id: mutation.groupId,
          p_photo_path: (mutation.payload.photoPath as string | undefined) ?? null,
          // And the creator's membership id, so an IOU expense queued in the same
          // breath names a member that will exist with this exact id (A34-style
          // offline group creation). Absent, the RPC mints one as before.
          p_creator_member_id: (mutation.payload.creatorMemberId as string | undefined) ?? null,
          // Which country the group is in decides which payment rails it is
          // offered (ADR-012). Dropped here, a group created offline came back
          // with no rails and no way to settle on one.
          p_country: (mutation.payload.country as string | undefined) ?? null,
        });
      case 'group.update': {
        await this.requireMemberId(mutation.groupId);
        // Whitelist the columns a member may set. RLS scopes the row, not the
        // columns, and PostgREST grants UPDATE on every column of `groups` to
        // `authenticated` — so spreading the raw payload let a member write any
        // column (e.g. poison `updated_seq` and break every member's sync).
        // These are exactly the fields `updateGroup` in the client sends.
        const patch = pick(mutation.payload, GROUP_UPDATABLE_FIELDS);
        if (Object.keys(patch).length === 0) {
          throw new HttpError(400, 'VALIDATION_FAILED', 'No updatable fields in payload');
        }
        const { error } = await this.caller.from('groups').update(patch).eq('id', mutation.groupId);
        if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
        return { groupId: mutation.groupId };
      }
      case 'capture.create':
        return await this.createCapture(mutation);
      case 'capture.update':
        return await this.updateCapture(mutation);
      case 'capture.delete':
        return await this.deleteCapture(mutation);
      case 'capture.assign':
        return await this.assignCapture(mutation);
      case 'tag.create':
      case 'tag.update':
        return await this.upsertTag(mutation);
      case 'tag.delete':
        return await this.deleteTag(mutation);
      case 'plan_item.create':
        return await this.rpcAsCaller('baaki_add_plan_item', {
          p_group_id: mutation.groupId,
          p_day: requireString(mutation.payload.day, 'day'),
          p_title: requireString(mutation.payload.title, 'title'),
          p_starts_at: (mutation.payload.startsAt as string | undefined) ?? null,
          p_note: (mutation.payload.note as string | undefined) ?? null,
          p_category: (mutation.payload.category as string | undefined) ?? null,
          p_planned_minor: (mutation.payload.plannedMinor as string | undefined) ?? null,
          p_currency: (mutation.payload.currency as string | undefined) ?? null,
          // Client-chosen id: the RPC's replay guard dedupes on it.
          p_item_id: requireString(mutation.payload.itemId, 'itemId'),
        });
      case 'plan_item.update':
        return await this.rpcAsCaller('baaki_update_plan_item', {
          p_item_id: requireString(mutation.payload.itemId, 'itemId'),
          // NULL means "leave alone"; p_clear (below) is how a field is emptied.
          p_day: (mutation.payload.day as string | undefined) ?? null,
          p_starts_at: (mutation.payload.startsAt as string | undefined) ?? null,
          p_title: (mutation.payload.title as string | undefined) ?? null,
          p_note: (mutation.payload.note as string | undefined) ?? null,
          p_category: (mutation.payload.category as string | undefined) ?? null,
          p_planned_minor: (mutation.payload.plannedMinor as string | undefined) ?? null,
          p_done: (mutation.payload.done as boolean | undefined) ?? null,
          p_expense_id: (mutation.payload.expenseId as string | undefined) ?? null,
          p_clear: (mutation.payload.clear as string[] | undefined) ?? [],
        });
      case 'plan_item.delete':
        return await this.rpcAsCaller('baaki_remove_plan_item', {
          p_item_id: requireString(mutation.payload.itemId, 'itemId'),
        });
      case 'member_budget.set':
        return await this.rpcAsCaller('baaki_set_my_trip_budget', {
          p_group_id: mutation.groupId,
          p_amount_minor: requireString(mutation.payload.amountMinor, 'amountMinor'),
          p_currency: (mutation.payload.currency as string | undefined) ?? null,
          p_visibility: (mutation.payload.visibility as string | undefined) ?? 'private',
        });
      case 'member_budget.clear':
        return await this.rpcAsCaller('baaki_clear_my_trip_budget', {
          p_group_id: mutation.groupId,
        });
      case 'group_budget.set':
        // Admin-gated inside the RPC — kept a distinct kind rather than widening
        // group.update, so any member cannot move the overall ceiling.
        return await this.rpcAsCaller('baaki_set_group_budget', {
          p_group_id: mutation.groupId,
          p_amount_minor: (mutation.payload.amountMinor as string | null) ?? null,
          p_currency: (mutation.payload.currency as string | undefined) ?? null,
        });
      default:
        throw new HttpError(
          400,
          'VALIDATION_FAILED',
          `Unknown mutation kind: ${String(mutation.kind)}`,
        );
    }
  }

  private async rpcAsCaller(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await this.caller.rpc(name, args);
    if (error) throw error;
    return data ?? {};
  }

  private async writeExpense(mutation: MutationEnvelope): Promise<unknown> {
    const memberId = await this.requireMemberId(mutation.groupId);
    const payload = mutation.payload as {
      expenseId?: string;
      description: string;
      category?: string | null;
      expenseDate: string;
      currency: string;
      amount: string;
      splitParams: SplitParams;
      participants: string[];
      payers: Record<string, string>;
      expectedShares?: Record<string, string>;
      fx?: FxRecord | null;
      notes?: string | null;
      paymentMethod?: string | null;
      receiptShareUrl?: string | null;
      categoryMeta?: { label: string; icon: string; tint: string } | null;
      receiptId?: string | null;
      baseVersionNo?: number;
    };

    const amount = parseMinor(payload.amount, 'amount');
    if (amount < 0n) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount cannot be negative');

    const payers = Object.entries(payload.payers ?? {}).map(
      ([id, value]) => [id, parseMinor(value, 'payer amount')] as const,
    );
    const paid = payers.reduce((total, [, value]) => total + value, 0n);
    if (paid !== amount) {
      throw new HttpError(
        400,
        'PAYER_MISMATCH',
        `Payers add up to ${paid} but the expense is ${amount}`,
      );
    }

    const expenseId = payload.expenseId ?? crypto.randomUUID();
    // Minor units arrive as strings; JSON has no bigint. A queued mutation can
    // be months old (ADR-005), so this also has to accept what older clients
    // sent — but never a fractional minor unit, whoever sent it.
    let splitParams: SplitParams;
    try {
      splitParams = parseSplitParams(payload.splitParams);
    } catch (bad) {
      throw new HttpError(400, 'VALIDATION_FAILED', (bad as Error).message);
    }
    // A SplitError escaping here becomes a 500, which the queue treats as
    // worth retrying — so a mutation that can never succeed would be retried
    // eight times before dying instead of being rejected once, with a reason.
    let shares;
    try {
      shares = computeShares({
        amount,
        currency: payload.currency,
        params: splitParams,
        participants: payload.participants,
        seed: expenseId,
      });
    } catch (bad) {
      throw new HttpError(400, 'VALIDATION_FAILED', (bad as Error).message);
    }

    // The client computed these too, offline, from the same inputs. If they
    // differ, one of us is wrong and it is not going in the ledger (TDR §4).
    try {
      verifyClientShares(shares, payload.expectedShares);
    } catch (mismatch) {
      throw new HttpError(409, 'SHARE_MISMATCH', (mismatch as Error).message);
    }

    const { data, error } = await this.service.rpc('baaki_apply_expense', {
      p_group_id: mutation.groupId,
      p_expense_id: expenseId,
      p_author_member_id: memberId,
      p_description: payload.description,
      p_category: payload.category ?? null,
      p_expense_date: payload.expenseDate,
      p_currency: payload.currency.toUpperCase(),
      p_amount: amount.toString(),
      p_split_type: splitParams.kind,
      p_split_params: serialiseSplitParams(splitParams),
      p_payers: payers.map(([id, value]) => ({ memberId: id, amount: value.toString() })),
      p_shares: [...shares].map(([id, value]) => ({ memberId: id, amount: value.toString() })),
      p_client_mutation_id: mutation.clientMutationId,
      p_notes: payload.notes ?? null,
      p_receipt_id: payload.receiptId ?? null,
      // Set only for edits, and only by a client that had actually seen a
      // version — this is what turns a concurrent edit into a logged conflict
      // instead of a silent overwrite (TDR §4.4).
      p_base_version_no: payload.baseVersionNo ?? null,
      p_fx: payload.fx ?? null,
      p_payment_method: payload.paymentMethod ?? null,
      p_receipt_share_url: payload.receiptShareUrl ?? null,
      // Denormalised custom-tag display, so a member without the author's catalog
      // still renders the tag (extends TDR §8). Null for a built-in category.
      p_category_meta: sanitiseCategoryMeta(payload.categoryMeta),
    });
    if (error) throw error;
    return data;
  }

  private async createSettlement(mutation: MutationEnvelope): Promise<unknown> {
    const payload = mutation.payload as {
      from: string;
      to: string;
      amount: string;
      method: string;
      rail?: string | null;
      currency?: string | null;
      note?: string | null;
      allocations?: { expenseId: string; amount: string }[];
    };

    return await this.rpcAsCaller('baaki_record_settlement', {
      p_group_id: mutation.groupId,
      p_from_member_id: payload.from,
      p_to_member_id: payload.to,
      p_amount: payload.amount,
      p_method: payload.method,
      // The enum knows four methods; the rail is the truth (ADR-012). Without
      // this, a settlement paid over Pix and queued offline arrived as "other"
      // and the group lost the one detail that says how it was actually paid.
      p_rail: payload.rail ?? payload.method,
      p_currency: payload.currency ?? null,
      p_note: payload.note ?? null,
      p_allocations: payload.allocations ?? [],
      p_client_mutation_id: mutation.clientMutationId,
    });
  }

  // ─────────────────────────────────────────────────── captures (A34) ──
  // The scope of a personal mutation is the owner. A client that put someone
  // else's id in `groupId` would be trying to write into another person's inbox
  // — the row RLS would refuse it anyway, but rejecting here says why. Ownership
  // is set from the authenticated identity, never trusted from the payload.

  private requireOwnScope(mutation: MutationEnvelope): void {
    if (mutation.groupId !== this.profileId) {
      throw new HttpError(403, 'NOT_OWNER', 'A capture may only be written under its own owner');
    }
  }

  private async createCapture(mutation: MutationEnvelope): Promise<unknown> {
    this.requireOwnScope(mutation);
    const payload = mutation.payload as {
      captureId?: string;
      description?: string;
      category?: string | null;
      expenseDate: string;
      currency: string;
      amount: string;
      notes?: string | null;
      photoPath?: string | null;
      rawText?: string | null;
      parsed?: Record<string, unknown> | null;
      paymentMethod?: string | null;
      targetGroupId?: string | null;
      categoryMeta?: { label: string; icon: string; tint: string } | null;
    };

    const captureId = requireString(payload.captureId, 'captureId');
    const amount = parseMinor(payload.amount, 'amount');
    if (amount < 0n) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount cannot be negative');

    const { error } = await this.caller.from('captures').insert({
      id: captureId,
      // From the authenticated identity, not the payload — the row's owner is
      // who is signed in, full stop.
      owner_user_id: this.profileId,
      description: payload.description ?? '',
      category: payload.category ?? null,
      category_meta: sanitiseCategoryMeta(payload.categoryMeta),
      expense_date: payload.expenseDate,
      currency: payload.currency.toUpperCase(),
      amount: amount.toString(),
      notes: payload.notes ?? null,
      photo_path: payload.photoPath ?? null,
      raw_text: payload.rawText ?? null,
      parsed: payload.parsed ?? null,
      // A tag, not a commitment: the split and the real expense are still chosen
      // at assignment. Constrained to the known set on the client.
      payment_method: normalisePaymentMethod(payload.paymentMethod),
      target_group_id: payload.targetGroupId ?? null,
      status: 'open',
    });
    if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
    return { captureId };
  }

  private async updateCapture(mutation: MutationEnvelope): Promise<unknown> {
    this.requireOwnScope(mutation);
    const payload = mutation.payload as Record<string, unknown>;
    const captureId = requireString(payload.captureId, 'captureId');

    // The payload is camelCase on the wire; the columns are snake_case. Map only
    // the fields that are present, so a partial edit does not blank the rest.
    const CAPTURE_FIELD_COLUMNS: Record<string, string> = {
      description: 'description',
      category: 'category',
      expenseDate: 'expense_date',
      currency: 'currency',
      amount: 'amount',
      notes: 'notes',
      photoPath: 'photo_path',
      rawText: 'raw_text',
      parsed: 'parsed',
      paymentMethod: 'payment_method',
      targetGroupId: 'target_group_id',
      categoryMeta: 'category_meta',
    };
    const patch: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(CAPTURE_FIELD_COLUMNS)) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) patch[column] = payload[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'payment_method')) {
      patch.payment_method = normalisePaymentMethod(patch.payment_method);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'category_meta')) {
      patch.category_meta = sanitiseCategoryMeta(patch.category_meta);
    }
    if (typeof patch.amount === 'string') {
      const amount = parseMinor(patch.amount, 'amount');
      if (amount < 0n) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount cannot be negative');
      patch.amount = amount.toString();
    }
    if (typeof patch.currency === 'string') patch.currency = patch.currency.toUpperCase();
    if (Object.keys(patch).length === 0) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'No updatable fields in payload');
    }
    patch.updated_at = new Date().toISOString();
    // Only an open capture may be edited — once assigned it is a record, not a draft.
    const { error } = await this.caller
      .from('captures')
      .update(patch)
      .eq('id', captureId)
      .eq('status', 'open');
    if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
    return { captureId };
  }

  private async deleteCapture(mutation: MutationEnvelope): Promise<unknown> {
    this.requireOwnScope(mutation);
    const captureId = requireString(mutation.payload.captureId, 'captureId');
    // Soft delete, so the removal propagates to the owner's other devices.
    const { error } = await this.caller
      .from('captures')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', captureId);
    if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
    return { captureId };
  }

  private async assignCapture(mutation: MutationEnvelope): Promise<unknown> {
    this.requireOwnScope(mutation);
    const captureId = requireString(mutation.payload.captureId, 'captureId');
    const groupId = requireString(mutation.payload.groupId, 'groupId');
    const expenseId = requireString(mutation.payload.expenseId, 'expenseId');
    // Idempotent and one-way: only an open capture flips, so a replay after the
    // expense already exists is a no-op rather than a second assignment.
    const { error } = await this.caller
      .from('captures')
      .update({
        status: 'assigned',
        assigned_group_id: groupId,
        assigned_expense_id: expenseId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', captureId)
      .eq('status', 'open');
    if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
    return { captureId, expenseId, groupId };
  }

  // A tag's scope is suffixed (`<profileId>:category_tags`), so ownership is
  // asserted against that, not the bare profile id captures uses. Ownership on
  // the row itself is set from the authenticated identity, never the payload.
  private requireTagScope(mutation: MutationEnvelope): void {
    if (mutation.groupId !== categoryTagsScope(this.profileId)) {
      throw new HttpError(403, 'NOT_OWNER', 'A tag may only be written under its own owner');
    }
  }

  private async upsertTag(mutation: MutationEnvelope): Promise<unknown> {
    this.requireTagScope(mutation);
    const payload = mutation.payload as {
      tagId?: string;
      builtinId?: string | null;
      label?: string | null;
      icon?: string | null;
      tint?: string | null;
      sortOrder?: number;
      hidden?: boolean;
    };
    const tagId = requireString(payload.tagId, 'tagId');
    const builtinId = typeof payload.builtinId === 'string' ? payload.builtinId : null;
    const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 40) : null;
    // A custom tag (no builtinId) must carry a label; a built-in override never
    // does — the DB check enforces this too, but reject early with a reason.
    if (!builtinId && !label) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'A custom tag needs a label');
    }
    const icon = typeof payload.icon === 'string' ? payload.icon.trim().slice(0, 64) : null;
    const tint =
      typeof payload.tint === 'string' && TAG_TINTS.has(payload.tint) ? payload.tint : null;
    // Upsert by id, so a create and its later edits are the same row and a replay
    // is harmless. owner_user_id comes from the identity, never the payload.
    const { error } = await this.caller.from('category_tags').upsert(
      {
        id: tagId,
        owner_user_id: this.profileId,
        builtin_id: builtinId,
        label,
        icon,
        tint,
        sort_order: Number.isFinite(payload.sortOrder)
          ? Math.trunc(payload.sortOrder as number)
          : 0,
        hidden: payload.hidden === true,
        deleted_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
    return { tagId };
  }

  private async deleteTag(mutation: MutationEnvelope): Promise<unknown> {
    this.requireTagScope(mutation);
    const tagId = requireString(mutation.payload.tagId, 'tagId');
    // Soft delete, so the removal reaches the owner's other devices through the
    // cursor rather than vanishing from only one.
    const { error } = await this.caller
      .from('category_tags')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', tagId);
    if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
    return { tagId };
  }
}

/**
 * Everything in these groups since the client's cursor.
 *
 * Read as the caller, never as the service role: a client can only ever be sent
 * rows its own RLS policies already allow, so widening the sync set can never
 * accidentally widen what it can see (ADR-013).
 *
 * The new cursor is the group's own `updated_seq`. That is safe because
 * `baaki_next_group_seq` takes the sequence by updating the groups row, which
 * holds a row lock until commit — so within a group, sequence order and commit
 * order are the same and no lower-numbered row can appear after a higher one.
 */
async function pull(
  caller: SupabaseClient,
  groupIds: Set<string>,
  cursors: Record<string, number>,
  profileId: string,
): Promise<{ changes: SyncChange[]; cursors: Record<string, number> }> {
  const changes: SyncChange[] = [];
  const nextCursors: Record<string, number> = {};

  // The personal scope is keyed by the caller's own user id (A34). It rides the
  // same cursor map as the groups, but it is not a group — drop it here so the
  // group loop does not waste a `groups` lookup on it.
  groupIds.delete(profileId);

  // Ghost merges (A38) ride a second personal scope, keyed distinctly so it does
  // not share a cursor with captures. Must equal `ghostMergesScope(profileId)`
  // in @waves/core; inlined to keep the edge bundle free of that import.
  const gmScope = `${profileId}:ghost_merges`;
  groupIds.delete(gmScope);

  // The category-tag catalog (extends TDR §8) rides a third personal scope, its
  // own suffixed key so it shares a cursor with neither captures nor ghost
  // merges. Must equal `categoryTagsScope(profileId)` in @waves/core.
  const tagScope = `${profileId}:category_tags`;
  groupIds.delete(tagScope);

  for (const groupId of groupIds) {
    const since = cursors[groupId] ?? 0;

    const { data: group, error: groupError } = await caller
      .from('groups')
      .select('*')
      .eq('id', groupId)
      .maybeSingle();
    if (groupError) throw new HttpError(500, 'INTERNAL', groupError.message);
    // Left the group, or never was in it: nothing to say, and no cursor either.
    if (!group) continue;

    const highWater = Number(group.updated_seq ?? 0);
    nextCursors[groupId] = highWater;

    if (highWater > since) {
      changes.push({ table: 'groups', groupId, seq: highWater, row: group });
    }

    for (const [table, select] of [
      // profiles is embedded by the explicit FK column: ghost_merges references
      // both group_members and profiles, so PostgREST otherwise sees two
      // group_members↔profiles relationships and refuses to guess.
      [
        'group_members',
        '*, profile:profiles!profile_id ( id, display_name, avatar_url, default_vpa )',
      ],
      ['expenses', EXPENSE_SELECT],
      ['settlements', SETTLEMENT_SELECT],
      ['activity_log', '*'],
      // Trip plan + budgets (A23). Flat rows, no embeds. Read as the caller, so a
      // co-member's private budget is filtered by RLS and simply not returned.
      ['trip_plan_items', '*'],
      ['trip_member_budgets', '*'],
    ] as const) {
      const { data, error } = await caller
        .from(table)
        .select(select)
        .eq('group_id', groupId)
        .gt('updated_seq', since)
        .order('updated_seq', { ascending: true })
        .limit(MAX_ROWS_PER_TABLE);

      // A failed read must never look like "nothing changed" — that is how a
      // client silently ends up with half a ledger.
      if (error) throw new HttpError(500, 'PULL_FAILED', `${table}: ${error.message}`);

      for (const row of data ?? []) {
        const record = row as Record<string, unknown>;
        changes.push({ table, groupId, seq: Number(record.updated_seq ?? 0), row: record });
      }
    }
  }

  // Personal scope (A34): the caller's own captures, keyed by their user id.
  // Read as the caller, so owner-only RLS already guarantees these are theirs —
  // the same safety property the group reads above rely on. A user is never a
  // member of a group whose id equals their own, so the key cannot collide.
  const meSince = cursors[profileId] ?? 0;
  const { data: captures, error: capturesError } = await caller
    .from('captures')
    .select('*')
    .eq('owner_user_id', profileId)
    .gt('updated_seq', meSince)
    .order('updated_seq', { ascending: true })
    .limit(MAX_ROWS_PER_TABLE);
  if (capturesError) throw new HttpError(500, 'PULL_FAILED', `captures: ${capturesError.message}`);

  let capturesHighWater = meSince;
  for (const row of captures ?? []) {
    const record = row as Record<string, unknown>;
    const seq = Number(record.updated_seq ?? 0);
    changes.push({ table: 'captures', groupId: profileId, seq, row: record });
    if (seq > capturesHighWater) capturesHighWater = seq;
  }
  nextCursors[profileId] = capturesHighWater;

  // Personal scope (A38): the caller's own ghost merges, pull-only. Read as the
  // caller so owner-only RLS (`ghost_merges_select_own`) already guarantees they
  // are theirs. The mirror keys every row by a string `id`, but ghost_merges has
  // a composite PK and no id column — so synthesise one from member_id, which is
  // unique within an owner.
  const gmSince = cursors[gmScope] ?? 0;
  const { data: merges, error: mergesError } = await caller
    .from('ghost_merges')
    .select('*')
    .eq('owner', profileId)
    .gt('updated_seq', gmSince)
    .order('updated_seq', { ascending: true })
    .limit(MAX_ROWS_PER_TABLE);
  if (mergesError) throw new HttpError(500, 'PULL_FAILED', `ghost_merges: ${mergesError.message}`);

  let gmHighWater = gmSince;
  for (const row of merges ?? []) {
    const record = row as Record<string, unknown>;
    const seq = Number(record.updated_seq ?? 0);
    changes.push({
      table: 'ghost_merges',
      groupId: gmScope,
      seq,
      row: { ...record, id: record.member_id },
    });
    if (seq > gmHighWater) gmHighWater = seq;
  }
  nextCursors[gmScope] = gmHighWater;

  // Personal scope (extends TDR §8): the caller's own category-tag catalog, its
  // own suffixed cursor. Read as the caller so owner-only RLS guarantees they
  // are theirs, exactly like captures above.
  const tagSince = cursors[tagScope] ?? 0;
  const { data: tags, error: tagsError } = await caller
    .from('category_tags')
    .select('*')
    .eq('owner_user_id', profileId)
    .gt('updated_seq', tagSince)
    .order('updated_seq', { ascending: true })
    .limit(MAX_ROWS_PER_TABLE);
  if (tagsError) throw new HttpError(500, 'PULL_FAILED', `category_tags: ${tagsError.message}`);

  let tagsHighWater = tagSince;
  for (const row of tags ?? []) {
    const record = row as Record<string, unknown>;
    const seq = Number(record.updated_seq ?? 0);
    changes.push({ table: 'category_tags', groupId: tagScope, seq, row: record });
    if (seq > tagsHighWater) tagsHighWater = seq;
  }
  nextCursors[tagScope] = tagsHighWater;

  return { changes, cursors: nextCursors };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', `${field} is required`);
  }
  return value;
}

/**
 * The payment method is a tag the client picks from a fixed set. Anything the
 * server does not recognise — a future value, a typo, a client bug — becomes
 * null rather than a rejected sync: it is a hint, and a wrong hint must never
 * block the capture it rides on. Null passes through untouched.
 */
const PAYMENT_METHODS = new Set(['cash', 'credit', 'debit', 'forex']);
function normalisePaymentMethod(value: unknown): string | null {
  return typeof value === 'string' && PAYMENT_METHODS.has(value) ? value : null;
}

/** The six design-system tints a custom tag may carry (kept in step with the
 *  client's `TINTS`); anything else is coerced to a safe default. */
const TAG_TINTS = new Set(['lilac', 'pink', 'mint', 'peach', 'sky', 'coral']);

/**
 * Validate the denormalised custom-tag display before it lands on a ledger row.
 * Anything not a proper {label, icon, tint} object becomes null (a built-in),
 * and an unknown tint is coerced rather than trusted — the payload is client
 * text, and this snapshot is shown to every group member.
 */
function sanitiseCategoryMeta(
  value: unknown,
): { label: string; icon: string; tint: string } | null {
  if (!value || typeof value !== 'object') return null;
  const meta = value as Record<string, unknown>;
  const label = typeof meta.label === 'string' ? meta.label.trim() : '';
  const icon = typeof meta.icon === 'string' ? meta.icon.trim() : '';
  if (!label || !icon) return null;
  const tint = typeof meta.tint === 'string' && TAG_TINTS.has(meta.tint) ? meta.tint : 'sky';
  return { label: label.slice(0, 40), icon: icon.slice(0, 64), tint };
}

/** Turn a thrown error into the vocabulary the client's queue understands. */
function classify(error: unknown): { code: string; message: string } {
  if (error instanceof HttpError) return { code: error.code, message: error.message };

  const message = error instanceof Error ? error.message : String(error);
  // The database raises 'UNKNOWN_MEMBER: ...', 'NOT_A_MEMBER: ...' and friends;
  // keep its own word for what went wrong rather than flattening to INTERNAL.
  const raised = /^([A-Z_]+):/.exec(message)?.[1];
  if (raised) return { code: raised, message };

  const wrapped = (error as { code?: string })?.code;
  if (wrapped === '42501') return { code: 'NOT_A_MEMBER', message };

  return { code: 'VALIDATION_FAILED', message };
}
