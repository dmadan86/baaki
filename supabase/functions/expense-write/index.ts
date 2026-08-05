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

import { computeShares, verifyClientShares, type SplitParams } from '../_shared/core.js';
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

    // One definition of "the client agrees with us", shared with /sync and
    // property-tested in @baaki/core rather than written out twice here.
    try {
      verifyClientShares(shares, body.expectedShares);
    } catch (mismatch) {
      throw new HttpError(409, 'SHARE_MISMATCH', (mismatch as Error).message);
    }

    // One RPC, one transaction. Writing the version, the payers and the shares
    // as separate PostgREST calls would let the Σpayers = Σshares = amount
    // trigger fire against a half-written expense — and a crash in between
    // would leave a version with no shares in the ledger.
    const { data: applied, error: applyError } = await service.rpc('baaki_apply_expense', {
      p_group_id: body.groupId,
      p_expense_id: body.expenseId ?? expenseId,
      p_author_member_id: memberId,
      p_description: body.description,
      p_category: body.category ?? null,
      p_expense_date: body.expenseDate,
      p_currency: body.currency.toUpperCase(),
      p_amount: amount.toString(),
      p_split_type: body.splitParams.kind,
      p_split_params: body.splitParams,
      p_payers: payers.map(([id, value]) => ({ memberId: id, amount: value.toString() })),
      p_shares: [...shares].map(([id, value]) => ({ memberId: id, amount: value.toString() })),
      p_client_mutation_id: body.clientMutationId,
      p_notes: body.notes ?? null,
      p_receipt_id: body.receiptId ?? null,
    });

    if (applyError) {
      // Surface the database's own vocabulary — UNKNOWN_MEMBER, WRONG_GROUP,
      // SHARE_MISMATCH — instead of a generic 500.
      const code = /^([A-Z_]+):/.exec(applyError.message)?.[1];
      throw new HttpError(code ? 400 : 500, code ?? 'INTERNAL', applyError.message);
    }

    const result = applied as {
      expenseId: string;
      versionId: string;
      versionNo: number;
      replayed: boolean;
    };

    return json({
      ...result,
      shares: Object.fromEntries([...shares].map(([id, value]) => [id, value.toString()])),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
