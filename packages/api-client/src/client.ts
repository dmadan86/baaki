/**
 * One client for anything that is not the phone.
 *
 * Framework-free on purpose: no React, no React Native, no Next. The app has
 * its own data layer built around an offline mirror and a mutation queue; a
 * browser opening a link has neither and does not want them. What the two
 * genuinely share is @baaki/core — the split maths, the balances, the money
 * types — and that is where sharing stops being a convenience and starts being
 * a correctness requirement (TDR §1).
 *
 * Authorization is not here. Every read goes to PostgREST under the caller's
 * own session and every RLS policy applies unchanged (ADR-013); a guest who
 * accepted an invite sees exactly the group they joined, because that is what
 * the database says, not because this file remembered to filter. The one thing
 * that carries authority is the invite token, and that is checked server-side
 * in `invite-accept`.
 */

import type { Session, SupabaseClient } from '@supabase/supabase-js';

import type { AcceptedInvite, Expense, Group, InvitePreview, Member, Settlement } from './types';
import type {
  ActivityGroup,
  ActivityRow,
  BalanceRow,
  GroupRow,
  MemberRow,
  PersonBalanceRow,
} from './rows';

const GROUP_ROW_COLUMNS = `
  id, name, type, country_code, default_currency, simplify_debts, cover_emoji, photo_path,
  start_date, end_date, archived_at, created_at
`;

const MEMBER_ROW_COLUMNS = `
  id, group_id, profile_id, ghost_name, role, vpa, left_at,
  profile:profiles ( id, display_name, avatar_url, default_vpa )
`;

const ACTIVITY_COLUMNS = `
  id, group_id, actor_member_id, verb, object_type, object_id, payload, created_at,
  actor:group_members!activity_log_actor_member_id_fkey (
    id, profile_id, ghost_name, profile:profiles ( display_name )
  )
`;

const MEMBER_COLUMNS = `
  id, group_id, profile_id, ghost_name, left_at,
  profile:profiles ( display_name )
`;

const EXPENSE_COLUMNS = `
  id, group_id, deleted_at, created_at,
  currentVersion:expense_versions!expenses_current_version_id_fkey (
    id, version_no, description, category, expense_date, currency, amount,
    split_type, split_params,
    payers:expense_payers ( member_id, amount ),
    shares:expense_shares ( member_id, amount )
  )
`;

export interface BaakiClientOptions {
  supabase: SupabaseClient;
}

export class BaakiApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BaakiApiError';
  }
}

export function createBaakiClient({ supabase }: BaakiClientOptions) {
  /**
   * PostgREST answers "you may not see this" with an empty list, not an error
   * — that is RLS doing its job. Only a real failure throws.
   */
  async function read<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
    const { data, error } = await query;
    if (error) throw new BaakiApiError(String((error as { message?: string }).message ?? error));
    return (data ?? []) as T[];
  }

  async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase.functions.invoke(name, { body });
    if (error) throw await describeFunctionError(error);
    return data as T;
  }

  return {
    /**
     * A guest is a real account with no credentials on it yet (ADR-006). It is
     * created before the invite is accepted so the membership has somebody to
     * belong to — and it is the *same* account they later add an email to, so
     * the group does not have to be re-joined and the history stays theirs.
     */
    async signInAsGuest(): Promise<void> {
      const { data } = await supabase.auth.getSession();
      if (data.session) return;
      const { error } = await supabase.auth.signInAnonymously();
      if (error) throw new BaakiApiError(error.message);
    },

    /**
     * The real login (ADR-006 names Google among the upgrade providers). An
     * anonymous guest who does this keeps the same user id, so the groups and
     * expenses made as a guest come with them — Supabase links the identity in
     * place rather than minting a second account.
     *
     * Returns nothing useful: `signInWithOAuth` navigates the browser to
     * Google and control does not come back here — it comes back to
     * `redirectTo` with the session in the URL.
     */
    async signInWithGoogle(redirectTo: string): Promise<void> {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (error) throw new BaakiApiError(error.message);
    },

    /**
     * The passwordless email login, matching the phone's approach: a link is
     * mailed, and clicking it returns to `redirectTo` (the callback route) with
     * a code this client exchanges for a session. No password to store, forget
     * or leak. Like Google, an anonymous guest who does this keeps their id and
     * their history.
     */
    async signInWithEmail(email: string, redirectTo: string): Promise<void> {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) throw new BaakiApiError(error.message);
    },

    async signOut(): Promise<void> {
      const { error } = await supabase.auth.signOut();
      if (error) throw new BaakiApiError(error.message);
    },

    async session(): Promise<Session | null> {
      const { data } = await supabase.auth.getSession();
      return data.session;
    },

    /** True once a real identity is linked; a bare guest reads false. */
    async isGuest(): Promise<boolean> {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;
      if (!user) return false;
      return user.is_anonymous === true;
    },

    /** Fires on sign-in / sign-out / token refresh. Returns an unsubscribe. */
    onAuthChange(handler: (session: Session | null) => void): () => void {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        handler(session);
      });
      return () => data.subscription.unsubscribe();
    },

    async currentProfileId(): Promise<string | null> {
      const { data } = await supabase.auth.getSession();
      return data.session?.user.id ?? null;
    },

    /** What is behind the link, without joining anything. */
    previewInvite(token: string): Promise<InvitePreview> {
      return callFunction<InvitePreview>('invite-accept', { token, mode: 'preview' });
    },

    /**
     * Joining. `claimMemberId` asks to take over a ghost somebody already
     * added, which is what keeps the expenses already filed against that name
     * (ADR-006) — without it the arrival becomes a second person and the group
     * has two of them.
     *
     * Asking is not joining: a claim comes back `pending` with no `memberId`
     * and waits on an admin of the group. Handing the place over on request
     * would let anybody holding the link inherit that name's whole history.
     */
    acceptInvite(input: {
      token: string;
      claimMemberId?: string | null;
      displayName?: string | null;
    }): Promise<AcceptedInvite> {
      return callFunction<AcceptedInvite>('invite-accept', { ...input, mode: 'join' });
    },

    async group(groupId: string): Promise<Group | null> {
      const rows = await read<Group>(
        supabase
          .from('groups')
          .select('id, name, cover_emoji, default_currency, simplify_debts')
          .eq('id', groupId)
          .limit(1),
      );
      return rows[0] ?? null;
    },

    members(groupId: string): Promise<Member[]> {
      return read<Member>(
        supabase
          .from('group_members')
          .select(MEMBER_COLUMNS)
          .eq('group_id', groupId)
          .is('left_at', null)
          .order('created_at', { ascending: true }),
      );
    },

    expenses(groupId: string): Promise<Expense[]> {
      return read<Expense>(
        supabase
          .from('expenses')
          .select(EXPENSE_COLUMNS)
          .eq('group_id', groupId)
          .order('created_at', { ascending: false }),
      );
    },

    settlements(groupId: string): Promise<Settlement[]> {
      return read<Settlement>(
        supabase
          .from('settlements')
          .select(
            `id, group_id, from_member_id, to_member_id, currency, amount, status,
             initiated_at, confirmed_at,
             allocations:settlement_allocations ( expense_id, amount )`,
          )
          .eq('group_id', groupId)
          .order('initiated_at', { ascending: false }),
      );
    },

    // ───────────────────────────────────────────────────── dashboard ──
    // Every read here is unfiltered by group on purpose: RLS returns exactly
    // the rows this session may see (ADR-013), so "my groups" is "the groups"
    // and the client never guesses at membership.

    myGroups(): Promise<GroupRow[]> {
      return read<GroupRow>(
        supabase
          .from('groups')
          .select(GROUP_ROW_COLUMNS)
          .is('archived_at', null)
          .order('created_at', { ascending: false }),
      );
    },

    /** Every member of every group I am in, keyed by group — one query. */
    async membersByGroup(): Promise<Map<string, MemberRow[]>> {
      const rows = await read<MemberRow>(
        supabase
          .from('group_members')
          .select(MEMBER_ROW_COLUMNS)
          .is('left_at', null)
          .order('created_at', { ascending: true }),
      );
      const byGroup = new Map<string, MemberRow[]>();
      for (const row of rows) {
        const list = byGroup.get(row.group_id);
        if (list) list.push(row);
        else byGroup.set(row.group_id, [row]);
      }
      return byGroup;
    },

    /** Just my own balance in each group — the one query the dashboard needs. */
    async myBalances(profileId: string): Promise<BalanceRow[]> {
      const rows = await read<BalanceRow & { member: { profile_id: string } }>(
        supabase
          .from('group_balances')
          .select(
            'group_id, member_id, currency, balance, member:group_members!inner ( profile_id )',
          )
          .eq('member.profile_id', profileId),
      );
      return rows.map(({ member: _member, ...row }) => row);
    },

    /** Every balance in every group I can see — for per-group nets. */
    allBalances(): Promise<BalanceRow[]> {
      return read<BalanceRow>(
        supabase.from('group_balances').select('group_id, member_id, currency, balance'),
      );
    },

    /** Activity across every group I can see; RLS does the filtering. */
    recentActivity(limit = 60): Promise<(ActivityRow & { group: ActivityGroup | null })[]> {
      return read<ActivityRow & { group: ActivityGroup | null }>(
        supabase
          .from('activity_log')
          .select(`${ACTIVITY_COLUMNS}, group:groups ( id, name, cover_emoji )`)
          .order('created_at', { ascending: false })
          .limit(limit),
      );
    },

    /** Groups with a settlement still waiting on someone to confirm (ADR-007). */
    pendingSettlements(): Promise<{ group_id: string; id: string }[]> {
      return read<{ group_id: string; id: string }>(
        supabase.from('settlements').select('id, group_id').eq('status', 'initiated'),
      );
    },

    /** Every person you are not square with, across every group, per currency. */
    peopleBalances(): Promise<PersonBalanceRow[]> {
      return read<PersonBalanceRow>(supabase.rpc('baaki_people_i_owe'));
    },

    /**
     * Writing an expense goes through the edge function, never straight to a
     * table. The server recomputes every share from the parameters and writes
     * its own answer; the client's numbers are a claim to be checked, not an
     * instruction (TDR §4). That rule does not relax because the caller is a
     * browser.
     */
    writeExpense(input: WriteExpenseInput): Promise<WriteExpenseResult> {
      return callFunction<WriteExpenseResult>('expense-write', {
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
        // The idempotency key. A guest on a flaky phone browser is exactly who
        // double-taps Save, and this is what makes the second one harmless.
        clientMutationId: input.clientMutationId,
      });
    },
  };
}

export type BaakiClient = ReturnType<typeof createBaakiClient>;

export interface WriteExpenseInput {
  groupId: string;
  expenseId?: string;
  description: string;
  category?: string | null;
  expenseDate: string;
  currency: string;
  amount: bigint;
  /** Already in wire form — use `serialiseSplitParams` from @baaki/core. */
  splitParams: unknown;
  participants: string[];
  payers: Record<string, bigint>;
  expectedShares?: Record<string, bigint>;
  notes?: string | null;
  clientMutationId: string;
}

export interface WriteExpenseResult {
  expenseId: string;
  versionId: string;
  versionNo: number;
  replayed?: boolean;
}

/**
 * Supabase wraps a non-2xx response, so the server's own message is one layer
 * down. Surfacing "This link has expired" instead of "Edge Function returned a
 * non-2xx status code" is the difference between a person knowing what to do
 * and filing a bug.
 */
async function describeFunctionError(error: unknown): Promise<BaakiApiError> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { code?: string; message?: string };
      if (body?.message) return new BaakiApiError(body.message, body.code);
    } catch {
      /* not JSON; fall through */
    }
  }
  return new BaakiApiError(error instanceof Error ? error.message : String(error));
}
