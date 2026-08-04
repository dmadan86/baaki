/**
 * expense-write — the only way an expense enters the ledger (M1).
 *
 * TDR §4: **never trust client-computed shares.** The client sends the split
 * parameters; this function recomputes the shares with @baaki/core and writes
 * those. If the client disagreed, it is told so (`SHARE_MISMATCH`) and repairs
 * itself — the ledger is never the thing that bends.
 *
 * Editing appends a new version (ADR-004); nothing is updated in place.
 * `clientMutationId` makes a replay a no-op (ADR-005).
 */

import { computeShares, type SplitParams } from '../_shared/core.js';
import {
  asCaller,
  asService,
  CORS_HEADERS,
  errorResponse,
  HttpError,
  json,
  requireMembership,
} from '../_shared/auth.ts';

interface ExpenseWriteRequest {
  groupId: string;
  /** Omit to create; pass an id to append a new version to that expense. */
  expenseId?: string;
  description: string;
  category?: string | null;
  expenseDate: string;
  currency: string;
  /** Minor units, as a decimal string — JSON has no bigint. */
  amount: string;
  splitParams: SplitParams;
  participants: string[];
  /** memberId → minor units paid, as strings. Must sum to `amount`. */
  payers: Record<string, string>;
  /** Client's own share computation, checked against ours when present. */
  expectedShares?: Record<string, string>;
  notes?: string | null;
  receiptId?: string | null;
  clientMutationId: string;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    if (request.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');
    }

    const body = (await request.json()) as ExpenseWriteRequest;
    const caller = asCaller(request);
    const { memberId } = await requireMembership(caller, body.groupId);
    const service = asService();

    // Replay of a mutation we already applied: return what we wrote before.
    const { data: existing } = await service
      .from('expense_versions')
      .select('id, expense_id, version_no')
      .eq('client_mutation_id', body.clientMutationId)
      .maybeSingle();
    if (existing) {
      return json({
        expenseId: existing.expense_id,
        versionId: existing.id,
        versionNo: existing.version_no,
        replayed: true,
      });
    }

    const amount = BigInt(body.amount);
    if (amount < 0n) throw new HttpError(400, 'INVALID_AMOUNT', 'Amount cannot be negative');

    const payers = Object.entries(body.payers ?? {}).map(
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

    // The authoritative computation.
    const expenseId = body.expenseId ?? crypto.randomUUID();
    const shares = computeShares({
      amount,
      currency: body.currency,
      params: body.splitParams,
      participants: body.participants,
      seed: expenseId,
    });

    if (body.expectedShares) {
      for (const [member, share] of shares) {
        const claimed = body.expectedShares[member];
        if (claimed === undefined || BigInt(claimed) !== share) {
          throw new HttpError(
            409,
            'SHARE_MISMATCH',
            `Server computed ${share} for ${member}, client said ${claimed ?? 'nothing'}`,
          );
        }
      }
    }

    // Members must all belong to this group — a caller cannot smuggle in
    // somebody else's member id (ADR-013).
    const referenced = new Set<string>([...body.participants, ...payers.map(([id]) => id)]);
    const { data: validMembers, error: membersError } = await service
      .from('group_members')
      .select('id')
      .eq('group_id', body.groupId)
      .in('id', [...referenced]);
    if (membersError) throw new HttpError(500, 'INTERNAL', membersError.message);
    if ((validMembers?.length ?? 0) !== referenced.size) {
      throw new HttpError(400, 'UNKNOWN_MEMBER', 'Some members are not in this group');
    }

    let versionNo = 1;
    if (body.expenseId) {
      const { data: expense, error } = await service
        .from('expenses')
        .select('id, group_id, deleted_at')
        .eq('id', body.expenseId)
        .maybeSingle();
      if (error) throw new HttpError(500, 'INTERNAL', error.message);
      if (!expense) throw new HttpError(404, 'NOT_FOUND', 'No such expense');
      if (expense.group_id !== body.groupId) {
        throw new HttpError(400, 'WRONG_GROUP', 'That expense belongs to another group');
      }

      const { data: latest } = await service
        .from('expense_versions')
        .select('version_no')
        .eq('expense_id', body.expenseId)
        .order('version_no', { ascending: false })
        .limit(1)
        .maybeSingle();
      versionNo = (latest?.version_no ?? 0) + 1;
    } else {
      const { error } = await service
        .from('expenses')
        .insert({ id: expenseId, group_id: body.groupId, created_by: memberId });
      if (error) throw new HttpError(500, 'INTERNAL', error.message);
    }

    const versionId = crypto.randomUUID();
    const { error: versionError } = await service.from('expense_versions').insert({
      id: versionId,
      expense_id: expenseId,
      version_no: versionNo,
      author_member_id: memberId,
      description: body.description,
      category: body.category ?? null,
      expense_date: body.expenseDate,
      currency: body.currency.toUpperCase(),
      amount: amount.toString(),
      split_type: body.splitParams.kind,
      split_params: body.splitParams,
      receipt_id: body.receiptId ?? null,
      notes: body.notes ?? null,
      client_mutation_id: body.clientMutationId,
    });
    if (versionError) throw new HttpError(500, 'INTERNAL', versionError.message);

    const { error: payersError } = await service.from('expense_payers').insert(
      payers.map(([id, value]) => ({
        expense_version_id: versionId,
        member_id: id,
        amount: value.toString(),
      })),
    );
    if (payersError) throw new HttpError(500, 'INTERNAL', payersError.message);

    const { error: sharesError } = await service.from('expense_shares').insert(
      [...shares].map(([id, value]) => ({
        expense_version_id: versionId,
        member_id: id,
        amount: value.toString(),
      })),
    );
    if (sharesError) throw new HttpError(500, 'INTERNAL', sharesError.message);

    // Pointing current_version_id at the new row is what makes the edit live;
    // the balance triggers fire from here.
    const { error: pointerError } = await service
      .from('expenses')
      .update({ current_version_id: versionId })
      .eq('id', expenseId);
    if (pointerError) throw new HttpError(500, 'INTERNAL', pointerError.message);

    await service.from('activity_log').insert({
      group_id: body.groupId,
      actor_member_id: memberId,
      verb: versionNo === 1 ? 'added' : 'edited',
      object_type: 'expense',
      object_id: expenseId,
      payload: {
        description: body.description,
        amount: amount.toString(),
        currency: body.currency.toUpperCase(),
        versionNo,
      },
    });

    return json({
      expenseId,
      versionId,
      versionNo,
      shares: Object.fromEntries([...shares].map(([id, value]) => [id, value.toString()])),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
