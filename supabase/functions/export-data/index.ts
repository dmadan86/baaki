/**
 * export-data — ADR-012, portability as a feature rather than a threat.
 *
 * JSON is lossless: every version of every expense, every payer and share row,
 * settlements with their allocations, and the activity trail. CSV is the
 * spreadsheet view, and unlike the export people complain about elsewhere it
 * includes per-person settlement detail.
 *
 * Free, on the free tier, forever (ADR-011).
 */

import {
  asCaller,
  asService,
  CORS_HEADERS,
  errorResponse,
  HttpError,
  json,
  requireMembership,
} from '../_shared/auth.ts';

interface ExportRequest {
  /** Omit to export every group the caller belongs to. */
  groupId?: string;
  format?: 'json' | 'csv';
  /** ';' for locales where ',' is the decimal separator (TDR §8). */
  csvSeparator?: string;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const body = (await request.json()) as ExportRequest;
    const format = body.format ?? 'json';
    const caller = asCaller(request);
    const service = asService();

    const { data: user, error: userError } = await caller.auth.getUser();
    if (userError || !user?.user) {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign in first');
    }

    let groupIds: string[];
    if (body.groupId) {
      await requireMembership(caller, body.groupId);
      groupIds = [body.groupId];
    } else {
      // RLS decides what "my groups" means; no manual filtering needed.
      const { data: groups, error } = await caller.from('groups').select('id');
      if (error) throw new HttpError(500, 'INTERNAL', error.message);
      groupIds = (groups ?? []).map((group) => group.id);
    }

    if (groupIds.length === 0) {
      throw new HttpError(404, 'NOTHING_TO_EXPORT', 'You are not in any groups yet');
    }

    const exported = [];
    for (const groupId of groupIds) {
      const [group, members, expenses, settlements, activity] = await Promise.all([
        service.from('groups').select('*').eq('id', groupId).single(),
        service
          .from('group_members')
          .select('*, profile:profiles ( display_name )')
          .eq('group_id', groupId),
        service
          .from('expenses')
          // The FK is named explicitly because `expenses` and `expense_versions`
          // reference each other (expense_id, current_version_id) and PostgREST
          // refuses to guess which one an embed means.
          .select(
            `*, versions:expense_versions!expense_versions_expense_id_fkey (
               *, payers:expense_payers ( member_id, amount ),
                  shares:expense_shares ( member_id, amount ))`,
          )
          .eq('group_id', groupId),
        service
          .from('settlements')
          .select('*, allocations:settlement_allocations ( expense_id, amount )')
          .eq('group_id', groupId),
        service.from('activity_log').select('*').eq('group_id', groupId),
      ]);

      // An export that quietly omits half the ledger is worse than no export at
      // all — this is the feature people leave a competitor *for* (ADR-012).
      for (const [label, result] of Object.entries({
        group,
        members,
        expenses,
        settlements,
        activity,
      })) {
        if (result.error) {
          throw new HttpError(
            500,
            'EXPORT_INCOMPLETE',
            `Could not read ${label}: ${result.error.message}`,
          );
        }
      }

      exported.push({
        group: group.data,
        members: members.data ?? [],
        expenses: expenses.data ?? [],
        settlements: settlements.data ?? [],
        activity: activity.data ?? [],
      });
    }

    if (format === 'json') {
      return json({
        filename: `baaki-export-${new Date().toISOString().slice(0, 10)}.json`,
        contentType: 'application/json',
        content: JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            schemaVersion: 1,
            // Amounts stay in minor units, as strings: re-importing this file
            // must reproduce the ledger exactly (ADR-003).
            amountUnit: 'minor',
            groups: exported,
          },
          null,
          2,
        ),
      });
    }

    const separator = body.csvSeparator ?? ',';
    const escape = (value: unknown): string => {
      const text = value === null || value === undefined ? '' : String(value);
      return /["\n]|,|;/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };

    const rows: string[][] = [
      [
        'group',
        'type',
        'date',
        'description',
        'currency',
        'amount_minor',
        'paid_by',
        'owed_by',
        'owed_amount_minor',
        'status',
        'version',
      ],
    ];

    for (const entry of exported) {
      const nameOf = (memberId: string | null): string => {
        const member = entry.members.find((row: Record<string, unknown>) => row.id === memberId);
        return (
          (member?.profile?.display_name as string) ?? (member?.ghost_name as string) ?? 'unknown'
        );
      };

      for (const expense of entry.expenses) {
        const current = expense.versions?.find(
          (version: Record<string, unknown>) => version.id === expense.current_version_id,
        );
        if (!current) continue;
        const payers = (current.payers ?? [])
          .map((payer: Record<string, unknown>) => nameOf(payer.member_id as string))
          .join(' + ');

        for (const share of current.shares ?? []) {
          rows.push([
            entry.group?.name ?? '',
            expense.deleted_at ? 'expense (deleted)' : 'expense',
            current.expense_date,
            current.description,
            current.currency,
            current.amount,
            payers,
            nameOf(share.member_id),
            share.amount,
            expense.deleted_at ? 'deleted' : 'active',
            `v${current.version_no}`,
          ]);
        }
      }

      // Per-person settlement detail — the part competitors leave out.
      for (const settlement of entry.settlements) {
        rows.push([
          entry.group?.name ?? '',
          'settlement',
          settlement.initiated_at?.slice(0, 10) ?? '',
          settlement.note ?? `${settlement.method} payment`,
          settlement.currency,
          settlement.amount,
          nameOf(settlement.from_member_id),
          nameOf(settlement.to_member_id),
          settlement.amount,
          settlement.status,
          '',
        ]);
      }
    }

    return json({
      filename: `baaki-export-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      content: rows.map((row) => row.map(escape).join(separator)).join('\n'),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
