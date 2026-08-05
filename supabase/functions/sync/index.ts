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
 *   `split_params` with the same @baaki/core the app uses, and a client whose
 *   arithmetic disagrees is rejected with SHARE_MISMATCH rather than believed.
 *
 *   **One bad mutation is not a broken app.** A rejection is reported per
 *   mutation; the rest of the batch still applies, and the client is told
 *   exactly which one failed and why.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { computeShares, type SplitParams } from '../_shared/core.js';
import {
  asCaller,
  asService,
  CORS_HEADERS,
  errorResponse,
  HttpError,
  json,
} from '../_shared/auth.ts';

type MutationKind =
  | 'expense.create'
  | 'expense.update'
  | 'expense.delete'
  | 'expense.restore'
  | 'settlement.create'
  | 'settlement.transition'
  | 'member.add_ghost'
  | 'group.create'
  | 'group.update';

interface MutationEnvelope {
  clientMutationId: string;
  kind: MutationKind;
  groupId: string;
  clientCreatedAt: string;
  payload: Record<string, unknown>;
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
    id, version_no, description, category, expense_date, currency, amount,
    split_type, split_params, author_member_id, notes, created_at,
    payers:expense_payers ( member_id, amount ),
    shares:expense_shares ( member_id, amount )
  )
`;

const SETTLEMENT_SELECT = `
  id, group_id, from_member_id, to_member_id, currency, amount, method, status, note,
  initiated_at, confirmed_at, updated_seq,
  allocations:settlement_allocations ( expense_id, amount )
`;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

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

    const session = new SyncSession(caller, service, profileId);
    const outcomes: Outcome[] = [];

    for (const mutation of mutations) {
      outcomes.push(await session.apply(mutation));
    }

    // Pull every group the client already knows about, plus any it just
    // created — otherwise a group made offline would stay invisible until the
    // next sync.
    const groupIds = new Set<string>([...Object.keys(cursors), ...session.touchedGroups]);
    const { changes, cursors: nextCursors } = await pull(caller, groupIds, cursors);

    return json({
      outcomes,
      changes,
      cursors: nextCursors,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
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

    // Replay: return exactly what the first attempt produced.
    const { data: seen } = await this.service
      .from('sync_mutations')
      .select('result')
      .eq('client_mutation_id', clientMutationId)
      .maybeSingle();
    if (seen) {
      this.touchedGroups.add(mutation.groupId);
      return { clientMutationId, status: 'duplicate', result: seen.result };
    }

    try {
      const result = await this.dispatch(mutation);
      this.touchedGroups.add(mutation.groupId);

      // Recorded after the fact: if the write succeeded but this insert fails,
      // the mutation's own idempotency key (on expense_versions, settlements,
      // or the row's primary key) still stops a replay from acting twice.
      await this.service.from('sync_mutations').insert({
        client_mutation_id: clientMutationId,
        profile_id: this.profileId,
        group_id: mutation.groupId,
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
        });
      case 'group.update': {
        await this.requireMemberId(mutation.groupId);
        const { error } = await this.caller
          .from('groups')
          .update(mutation.payload)
          .eq('id', mutation.groupId);
        if (error) throw new HttpError(400, 'VALIDATION_FAILED', error.message);
        return { groupId: mutation.groupId };
      }
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
      notes?: string | null;
      receiptId?: string | null;
      baseVersionNo?: number;
    };

    const amount = BigInt(payload.amount);
    if (amount < 0n) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount cannot be negative');

    const payers = Object.entries(payload.payers ?? {}).map(
      ([id, value]) => [id, BigInt(value)] as const,
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
    const shares = computeShares({
      amount,
      currency: payload.currency,
      params: payload.splitParams,
      participants: payload.participants,
      seed: expenseId,
    });

    // The client computed these too, offline, from the same inputs. If they
    // differ, one of us is wrong and it is not going in the ledger (TDR §4).
    if (payload.expectedShares) {
      for (const [member, share] of shares) {
        const claimed = payload.expectedShares[member];
        if (claimed === undefined || BigInt(claimed) !== share) {
          throw new HttpError(
            409,
            'SHARE_MISMATCH',
            `Server computed ${share} for ${member}, client said ${claimed ?? 'nothing'}`,
          );
        }
      }
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
      p_split_type: payload.splitParams.kind,
      p_split_params: payload.splitParams,
      p_payers: payers.map(([id, value]) => ({ memberId: id, amount: value.toString() })),
      p_shares: [...shares].map(([id, value]) => ({ memberId: id, amount: value.toString() })),
      p_client_mutation_id: mutation.clientMutationId,
      p_notes: payload.notes ?? null,
      p_receipt_id: payload.receiptId ?? null,
      // Set only for edits, and only by a client that had actually seen a
      // version — this is what turns a concurrent edit into a logged conflict
      // instead of a silent overwrite (TDR §4.4).
      p_base_version_no: payload.baseVersionNo ?? null,
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
      p_currency: payload.currency ?? null,
      p_note: payload.note ?? null,
      p_allocations: payload.allocations ?? [],
      p_client_mutation_id: mutation.clientMutationId,
    });
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
): Promise<{ changes: SyncChange[]; cursors: Record<string, number> }> {
  const changes: SyncChange[] = [];
  const nextCursors: Record<string, number> = {};

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
      ['group_members', '*, profile:profiles ( id, display_name, avatar_url, default_vpa )'],
      ['expenses', EXPENSE_SELECT],
      ['settlements', SETTLEMENT_SELECT],
      ['activity_log', '*'],
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

  return { changes, cursors: nextCursors };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', `${field} is required`);
  }
  return value;
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
