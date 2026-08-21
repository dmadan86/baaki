#!/usr/bin/env node
/**
 * Waves agent MCP server.
 *
 * Exposes the app's *operations* — not the database — as MCP tools, so an AI
 * agent can create a group, add an expense, and record a settlement on behalf
 * of a signed-in person. Every write goes through the same authorized path the
 * mobile app uses:
 *
 *   - create_group      → rpc('baaki_create_group')          (user JWT)
 *   - add_expense        → functions.invoke('expense-write')  (user JWT; the
 *                          edge function recomputes the split and calls the
 *                          service-role-only baaki_apply_expense for us — #274)
 *   - record_settlement  → rpc('baaki_record_settlement')     (user JWT)
 *
 * Two things this server deliberately does NOT do:
 *   - It never runs raw SQL. There is no query tool. Every write is one named,
 *     validated operation, so business rules (split maths, ledger integrity,
 *     the RPC boundary) can never be bypassed.
 *   - It never moves money. `record_settlement` writes a settlement row saying
 *     "X paid Y"; the actual transfer is a UPI/PayPal handoff link a human
 *     opens and confirms in their own bank app. `payment_link` builds that
 *     link; nothing here debits an account.
 */

import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { currentUserId, makeClient, readEnv } from './supabase.js';

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Integer minor units (paise/cents) as a decimal string — money is never a float. */
const MinorUnits = z
  .string()
  .regex(/^\d+$/, 'Amount must be integer minor units (paise/cents) as a string, e.g. "12500".')
  .describe('Integer minor units as a string, e.g. "12500" for ₹125.00');

const MemberId = z.string().uuid().describe('A group_members.id from list_members');
const GroupId = z.string().uuid().describe('A group id from list_groups');
const Currency = z
  .string()
  .length(3)
  .transform((c) => c.toUpperCase())
  .describe('ISO-4217, e.g. INR, USD');

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** Read the app-defined error code out of a wrapped edge-function failure. */
async function edgeError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { code?: string; message?: string };
      if (body?.message) return body.code ? `${body.code}: ${body.message}` : body.message;
      if (body?.code) return body.code;
    } catch {
      /* fall through */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const env = readEnv();
  const supabase = await makeClient(env);
  const meId = await currentUserId(supabase);

  const server = new McpServer({ name: 'waves-agent', version: '0.1.0' });

  // ── reads ──────────────────────────────────────────────────────────────

  server.registerTool(
    'whoami',
    {
      description:
        'The identity this server is acting as. Every write is performed as this user, under the same permissions they have in the app.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const { data } = await supabase.auth.getUser();
      return ok({ userId: meId, email: data.user?.email ?? null, readOnly: env.readOnly });
    },
  );

  server.registerTool(
    'list_groups',
    {
      description:
        "List the groups the signed-in user belongs to (RLS scopes this to them). Use it to find a group id before adding an expense or a settlement.",
      inputSchema: {
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived groups (default false).'),
      },
    },
    async ({ includeArchived }): Promise<ToolResult> => {
      let query = supabase
        .from('groups')
        .select('id, name, type, default_currency, cover_emoji, archived_at, start_date, end_date')
        .order('created_at', { ascending: false });
      if (!includeArchived) query = query.is('archived_at', null);
      const { data, error } = await query;
      if (error) return fail(error.message);
      return ok(
        (data ?? []).map((g) => ({
          id: g.id,
          name: g.name,
          type: g.type,
          currency: g.default_currency,
          emoji: g.cover_emoji,
          archived: Boolean(g.archived_at),
          startDate: g.start_date,
          endDate: g.end_date,
        })),
      );
    },
  );

  server.registerTool(
    'list_members',
    {
      description:
        'The members of a group, with their member ids. Expenses and settlements are addressed by member id, not by person, so resolve names here first. "isYou" marks the signed-in user, who must be a party to any settlement.',
      inputSchema: { groupId: GroupId },
    },
    async ({ groupId }): Promise<ToolResult> => {
      const { data, error } = await supabase
        .from('group_members')
        .select(
          'id, group_id, profile_id, ghost_name, vpa, role, profile:profiles!profile_id ( display_name, default_vpa )',
        )
        .eq('group_id', groupId)
        .is('left_at', null)
        .order('created_at', { ascending: true });
      if (error) return fail(error.message);
      return ok(
        (data ?? []).map((m) => {
          const profile = m.profile as { display_name?: string; default_vpa?: string } | null;
          return {
            memberId: m.id,
            name: profile?.display_name ?? m.ghost_name ?? 'Unnamed',
            isYou: m.profile_id === meId,
            isGhost: !m.profile_id,
            role: m.role,
            vpa: m.vpa ?? profile?.default_vpa ?? null,
          };
        }),
      );
    },
  );

  server.registerTool(
    'get_balances',
    {
      description:
        'Who owes what in a group, per member and currency, in minor units. A positive balance is owed to that member; a negative balance is owed by them. Use this to know a settlement amount before recording one.',
      inputSchema: { groupId: GroupId },
    },
    async ({ groupId }): Promise<ToolResult> => {
      const { data, error } = await supabase
        .from('group_balances')
        .select('member_id, currency, balance')
        .eq('group_id', groupId);
      if (error) return fail(error.message);
      return ok(data ?? []);
    },
  );

  // ── writes ─────────────────────────────────────────────────────────────
  // Registered only when the server is not in read-only mode.

  if (!env.readOnly) {
    registerWriteTools(server, supabase);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // A stdio server must not print to stdout (that is the protocol channel).
  process.stderr.write(
    `waves-agent MCP up as ${meId}${env.readOnly ? ' (read-only)' : ''}\n`,
  );
}

function registerWriteTools(server: McpServer, supabase: SupabaseClient): void {
  server.registerTool(
    'create_group',
    {
      description:
        'Create a new group. The signed-in user is added as its first (admin) member automatically. Returns the new group id.',
      inputSchema: {
        name: z.string().min(1).optional().describe('Optional; an unnamed group is labelled by its members.'),
        type: z
          .enum(['trip', 'home', 'couple', 'event', 'other'])
          .default('other')
          .describe('What kind of group this is.'),
        currency: Currency.default('INR'),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('ISO-3166 alpha-2, e.g. IN. Decides which payment rails the group offers.'),
        emoji: z.string().optional().describe('A cover emoji.'),
        simplify: z
          .boolean()
          .default(true)
          .describe('Simplify debts in the presentation (ledger is untouched).'),
      },
    },
    async ({ name, type, currency, country, emoji, simplify }): Promise<ToolResult> => {
      const { data, error } = await supabase.rpc('baaki_create_group', {
        p_name: name?.trim() || null,
        p_type: type,
        p_currency: currency,
        p_emoji: emoji ?? null,
        p_simplify: simplify,
        p_group_id: null,
        p_photo_path: null,
        p_country: country ? country.toUpperCase() : null,
        p_creator_member_id: null,
      });
      if (error) return fail(error.message);
      return ok({ groupId: data });
    },
  );

  server.registerTool(
    'add_expense',
    {
      description:
        "Add an expense to a group. The server does NOT trust a client-computed split — it sends the split intent to the app's expense-write edge function, which recomputes every share and writes the ledger. Amounts are integer minor units as strings. Resolve member ids with list_members first.",
      inputSchema: {
        groupId: GroupId,
        description: z.string().min(1).describe('What the expense was for.'),
        amount: MinorUnits.describe('Total of the expense, in minor units.'),
        currency: Currency.optional().describe("Defaults to the group's currency if omitted."),
        paidBy: MemberId.describe('The member who paid (single payer).'),
        participants: z
          .array(MemberId)
          .min(1)
          .describe('The members the expense is split across.'),
        split: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('equal') }),
            z.object({
              kind: z.literal('exact'),
              amounts: z
                .record(MinorUnits)
                .describe('memberId → minor units; must sum to the total.'),
            }),
            z.object({
              kind: z.literal('shares'),
              weights: z
                .record(z.number().int().positive())
                .describe('memberId → weight, e.g. {"a":2,"b":1}.'),
            }),
          ])
          .optional()
          .describe('How to split. Defaults to an equal split across participants.'),
        expenseDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD; defaults to today.'),
        category: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (input): Promise<ToolResult> => {
      const splitParams =
        !input.split || input.split.kind === 'equal'
          ? { kind: 'equal' }
          : input.split.kind === 'exact'
            ? { kind: 'exact', amounts: input.split.amounts }
            : { kind: 'shares', weights: input.split.weights };

      const expenseId = randomUUID();
      const { data, error } = await supabase.functions.invoke('expense-write', {
        body: {
          groupId: input.groupId,
          expenseId,
          description: input.description,
          category: input.category ?? null,
          expenseDate: input.expenseDate ?? todayIso(),
          currency: input.currency ?? undefined,
          amount: input.amount,
          splitParams,
          participants: input.participants,
          payers: { [input.paidBy]: input.amount },
          // expectedShares omitted on purpose: the edge function is the source
          // of truth for the split, and sending nothing lets it compute freely.
          notes: input.notes ?? null,
          paymentMethod: null,
          receiptShareUrl: null,
          fx: null,
          clientMutationId: randomUUID(),
        },
      });
      if (error) return fail(await edgeError(error));
      return ok({ ...(data as object), expenseId });
    },
  );

  server.registerTool(
    'record_settlement',
    {
      description:
        'Record that one member paid another to settle up. This writes a settlement row only — it does NOT move any money. The signed-in user (isYou in list_members) must be one of the two parties. Use payment_link to get the handoff URL a human opens to actually pay.',
      inputSchema: {
        groupId: GroupId,
        fromMemberId: MemberId.describe('Who paid.'),
        toMemberId: MemberId.describe('Who received.'),
        amount: MinorUnits,
        rail: z
          .string()
          .default('upi')
          .describe('The payment rail id, e.g. upi, cash, bank, paypal.'),
        currency: Currency.optional(),
        note: z.string().optional(),
      },
    },
    async ({ groupId, fromMemberId, toMemberId, amount, rail, currency, note }): Promise<ToolResult> => {
      const method = (['upi', 'cash', 'bank', 'other'] as const).includes(
        rail as 'upi' | 'cash' | 'bank' | 'other',
      )
        ? rail
        : 'other';
      const { data, error } = await supabase.rpc('baaki_record_settlement', {
        p_group_id: groupId,
        p_from_member_id: fromMemberId,
        p_to_member_id: toMemberId,
        p_amount: amount,
        p_method: method,
        p_rail: rail,
        p_currency: currency ?? null,
        p_note: note ?? null,
        p_allocations: [],
        p_client_mutation_id: randomUUID(),
      });
      if (error) return fail(error.message);
      return ok({
        settlementId: data,
        status: 'initiated',
        note: 'Recorded only — no money moved. Use payment_link for the payer to complete the transfer.',
      });
    },
  );

  server.registerTool(
    'payment_link',
    {
      description:
        'Build a payment handoff link (UPI or PayPal) for a payer to open in their own app and complete a transfer. This does not move money; it is a deep link a human taps and confirms.',
      inputSchema: {
        rail: z.enum(['upi', 'paypal']).default('upi'),
        payeeVpa: z
          .string()
          .optional()
          .describe('The payee UPI id (vpa), e.g. name@bank — from list_members. Required for upi.'),
        payeeHandle: z
          .string()
          .optional()
          .describe('The payee PayPal.me handle. Required for paypal.'),
        payeeName: z.string().optional(),
        amount: MinorUnits,
        currency: Currency.default('INR'),
      },
    },
    async ({ rail, payeeVpa, payeeHandle, payeeName, amount, currency }): Promise<ToolResult> => {
      // Minor → major with two decimals. Every currency this app settles in is
      // two-decimal; a decimal string keeps the exact value without a float.
      const major = `${(BigInt(amount) / 100n).toString()}.${(BigInt(amount) % 100n)
        .toString()
        .padStart(2, '0')}`;

      if (rail === 'upi') {
        if (!payeeVpa) return fail('A UPI link needs payeeVpa (the payee\'s UPI id).');
        const params = new URLSearchParams({
          pa: payeeVpa,
          ...(payeeName ? { pn: payeeName } : {}),
          am: major,
          cu: currency,
        });
        return ok({ rail, uri: `upi://pay?${params.toString()}`, amountMajor: major, currency });
      }

      if (!payeeHandle) return fail('A PayPal link needs payeeHandle (the PayPal.me handle).');
      return ok({
        rail,
        uri: `https://paypal.me/${encodeURIComponent(payeeHandle)}/${major}${currency}`,
        amountMajor: major,
        currency,
      });
    },
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`waves-agent MCP failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
