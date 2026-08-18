import 'server-only';

import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';

import { isValidToken, SESSION_COOKIE } from './session';

/**
 * The only place the service key is read.
 *
 * `server-only` at the top is not decoration: it makes the build fail if any of
 * this is ever imported from a client component, which is the single mistake
 * that would put a key that bypasses RLS on every table into a browser bundle
 * (ADR-013). It is cheaper to have the build refuse than to review for it.
 *
 * Every function here goes through `baaki_admin_*`, which return aggregates and
 * are granted to `service_role` alone. Nothing in this app selects from a table
 * directly — not because it could not, but so that what the console is able to
 * see is one reviewable list in one migration rather than a habit spread over a
 * dozen pages.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — see apps/admin/.env.example. ' +
        'Note these are not the NEXT_PUBLIC_ names the other apps use, on purpose: a ' +
        'NEXT_PUBLIC_ prefix is what would inline the key into the client bundle.',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Defence in depth behind the middleware.
 *
 * A route the matcher misses, a middleware that is skipped by a future Next
 * change, a page rendered by something other than a request — all of them end
 * here, with no session and no data.
 */
async function requireSession(): Promise<void> {
  const jar = await cookies();
  if (!(await isValidToken(jar.get(SESSION_COOKIE)?.value))) {
    throw new Error('Not signed in');
  }
}

/**
 * PostgREST's code for "no such function". The overwhelmingly likely reason to
 * see it is that `20260808190000_admin_analytics` has not been deployed to this
 * project yet, which is a first-run state rather than a fault — so it degrades
 * to no rows and lets the page say so, instead of answering a fresh setup with
 * a stack trace.
 */
const FUNCTION_MISSING = 'PGRST202';

/** The same first-run state, for a table rather than a function. */
const TABLE_MISSING = 'PGRST205';

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
  await requireSession();
  const { data, error } = await client().rpc(fn, args);
  if (error) {
    if (error.code === FUNCTION_MISSING) return [];
    // The message carries the function name: "permission denied for function"
    // on its own does not say which, and that is worth telling from a bug.
    throw new Error(`${fn} failed: ${error.message}`);
  }
  return (data ?? []) as T[];
}

export interface Overview {
  profiles_total: number;
  profiles_new_7d: number;
  profiles_new_30d: number;
  groups_total: number;
  groups_new_30d: number;
  groups_active_30d: number;
  expenses_total: number;
  expenses_new_30d: number;
  expenses_deleted: number;
  settlements_total: number;
  settlements_confirmed: number;
  active_profiles_7d: number;
  active_profiles_30d: number;
}

export interface DailyRow {
  day: string;
  new_profiles: number;
  new_groups: number;
  new_expenses: number;
  active_profiles: number;
}

export interface GeoRow {
  country_code: string | null;
  profile_count: number;
  group_count: number;
  expense_count: number;
}

export interface MoneyRow {
  currency: string;
  expense_count: number;
  /** Minor units. A string from PostgREST because numeric does not fit a double. */
  expense_minor: string;
  settlement_count: number;
  settlement_minor: string;
}

export interface AiCostRow {
  day: string;
  currency: string;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cost_minor: string;
}

export interface LoginRow {
  day: string;
  sign_ins: number;
}

export async function overview(): Promise<Overview | null> {
  const rows = await call<Overview>('baaki_admin_overview');
  return rows[0] ?? null;
}

export interface FlagRow {
  key: string;
  description: string;
  enabled: boolean;
  rollout_percent: number;
  variants: string[];
  updated_at: string;
}

export interface FlagResultRow {
  variant: string;
  people: number;
  expenses_created: number;
  active_30d: number;
}

/**
 * The one place this app reads a table rather than a function.
 *
 * `feature_flags` is configuration the console owns end to end — it is the
 * thing being edited, not an aggregate over somebody's data, and there is no
 * privacy question to keep at arm's length. The `baaki_admin_*` functions
 * exist to bound what can be seen about *people*; this is a switchboard.
 */
export async function flags(): Promise<FlagRow[]> {
  await requireSession();
  const { data, error } = await client()
    .from('feature_flags')
    .select('key, description, enabled, rollout_percent, variants, updated_at')
    .order('key');
  if (error) {
    if (error.code === TABLE_MISSING) return [];
    throw new Error(`reading feature_flags failed: ${error.message}`);
  }
  return (data ?? []) as FlagRow[];
}

export async function saveFlag(input: {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  variants: string[];
}): Promise<void> {
  await requireSession();

  // Checked here as well as by the CHECK constraints, so a typo comes back as
  // a sentence rather than as a Postgres error string.
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(input.key)) {
    throw new Error('A key is lowercase letters, digits and underscores, starting with a letter.');
  }
  if (input.rolloutPercent < 0 || input.rolloutPercent > 100) {
    throw new Error('Rollout is a percentage between 0 and 100.');
  }
  if (new Set(input.variants).size !== input.variants.length || input.variants.length < 2) {
    throw new Error('An experiment needs at least two distinct arms.');
  }

  const { error } = await client().from('feature_flags').upsert(
    {
      key: input.key,
      description: input.description,
      enabled: input.enabled,
      rollout_percent: input.rolloutPercent,
      variants: input.variants,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  );
  if (error) throw new Error(`saving ${input.key} failed: ${error.message}`);
}

export interface AppConfigRow {
  key: string;
  value: number;
  description: string;
  updated_at: string;
}

/**
 * The numeric knobs — the receipt cap and any limit that joins it. Like
 * `feature_flags`, this is configuration the console owns, not an aggregate
 * over somebody's data, so it is read straight from the table.
 */
export async function appConfig(): Promise<AppConfigRow[]> {
  await requireSession();
  const { data, error } = await client()
    .from('app_config')
    .select('key, value, description, updated_at')
    .order('key');
  if (error) {
    if (error.code === TABLE_MISSING) return [];
    throw new Error(`reading app_config failed: ${error.message}`);
  }
  return (data ?? []) as AppConfigRow[];
}

/**
 * Change a knob's value. An UPDATE, not an upsert: the keys are defined by the
 * migrations that read them, so the console turns existing knobs and cannot
 * invent one the code never looks at.
 */
export async function saveAppConfig(input: { key: string; value: number }): Promise<void> {
  await requireSession();

  if (!/^[a-z][a-z0-9_]{1,60}$/.test(input.key)) {
    throw new Error('A key is lowercase letters, digits and underscores, starting with a letter.');
  }
  if (!Number.isInteger(input.value) || input.value < 0) {
    throw new Error('A limit is a whole number, zero or more.');
  }

  const { error } = await client()
    .from('app_config')
    .update({ value: input.value, updated_at: new Date().toISOString() })
    .eq('key', input.key);
  if (error) throw new Error(`saving ${input.key} failed: ${error.message}`);
}

export interface PromoCodeRow {
  code: string;
  tier: string;
  days: number;
  max_redemptions: number;
  redeemed_count: number;
  expires_at: string | null;
  note: string;
  created_at: string;
}

export const promoCodes = () => call<PromoCodeRow>('baaki_admin_promo_codes');

export async function createPromoCode(input: {
  code: string;
  days: number;
  maxRedemptions: number;
  note: string;
}): Promise<void> {
  await requireSession();

  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,24}$/.test(code)) {
    throw new Error('A code is 4–24 letters and digits. It gets read aloud and typed by hand.');
  }
  if (input.days < 1 || input.days > 3650) throw new Error('Days must be between 1 and 3650.');
  if (input.maxRedemptions < 1) throw new Error('A code has to be redeemable at least once.');

  const { error } = await client().from('promo_codes').insert({
    code,
    days: input.days,
    max_redemptions: input.maxRedemptions,
    note: input.note,
  });
  if (error) {
    if (error.code === '23505') throw new Error(`${code} already exists.`);
    throw new Error(`creating ${code} failed: ${error.message}`);
  }
}

/**
 * Comp one named account.
 *
 * The RPC is keyed on the profile and the day, so pressing this twice in one
 * support conversation is the same grant rather than two months — it reports
 * `ALREADY_GRANTED_TODAY` instead of silently doubling.
 */
export async function grantPromo(profileId: string, days: number): Promise<string> {
  await requireSession();

  if (!UUID.test(profileId.trim())) {
    throw new Error('That is not a profile id. Copy the uuid from the account you mean.');
  }

  const { data, error } = await client().rpc('baaki_admin_grant_promo', {
    p_profile_id: profileId.trim(),
    p_days: days,
  });
  if (error) throw new Error(`granting failed: ${error.message}`);

  const verdict = data as { ok: boolean; reason?: string } | null;
  if (!verdict?.ok) {
    const reason = verdict?.reason ?? 'UNKNOWN';
    if (reason === 'NO_SUCH_PROFILE') throw new Error('No account has that id.');
    if (reason === 'ALREADY_GRANTED_TODAY') {
      throw new Error('That account already has a grant from today. Grant again tomorrow.');
    }
    throw new Error(reason);
  }
  return 'Granted.';
}

export interface CampaignRow {
  id: string;
  name: string;
  title: string;
  body: string;
  cta_label: string;
  promo_code: string | null;
  starts_at: string;
  ends_at: string;
  audience_countries: string[] | null;
  holdout_percent: number;
}

export interface FunnelRow {
  cohort: string;
  people: number;
  seen: number;
  redeemed: number;
  paid: number;
}

export interface CampaignRevenueRow {
  cohort: string;
  currency: string;
  payers: number;
  revenue_minor: string;
}

export async function campaigns(): Promise<CampaignRow[]> {
  await requireSession();
  const { data, error } = await client()
    .from('campaigns')
    .select(
      'id, name, title, body, cta_label, promo_code, starts_at, ends_at, audience_countries, holdout_percent',
    )
    .order('starts_at', { ascending: false });
  if (error) {
    if (error.code === TABLE_MISSING) return [];
    throw new Error(`reading campaigns failed: ${error.message}`);
  }
  return (data ?? []) as CampaignRow[];
}

export async function createCampaign(input: {
  name: string;
  title: string;
  body: string;
  ctaLabel: string;
  promoCode: string | null;
  endsAt: string;
  countries: string[] | null;
  holdoutPercent: number;
}): Promise<void> {
  await requireSession();

  if (!input.title.trim()) throw new Error('A campaign needs something to say.');
  if (!input.endsAt) throw new Error('A campaign needs an end date.');
  if (input.holdoutPercent < 0 || input.holdoutPercent > 90) {
    throw new Error('Holdout is between 0 and 90 percent.');
  }
  if (input.holdoutPercent === 0) {
    // Allowed, but the console says what it costs rather than quietly letting
    // the campaign become unmeasurable.
    throw new Error(
      'A 0% holdout leaves nothing to compare against, so the revenue impact cannot be ' +
        'computed. Use 5–10% unless you genuinely do not want to know.',
    );
  }

  const { error } = await client()
    .from('campaigns')
    .insert({
      name: input.name.trim() || input.title.trim(),
      title: input.title.trim(),
      body: input.body.trim(),
      cta_label: input.ctaLabel.trim(),
      promo_code: input.promoCode || null,
      ends_at: new Date(input.endsAt).toISOString(),
      audience_countries: input.countries,
      holdout_percent: input.holdoutPercent,
    });
  if (error) throw new Error(`creating the campaign failed: ${error.message}`);
}

export const campaignFunnel = (id: string) =>
  call<FunnelRow>('baaki_admin_campaign_funnel', { p_campaign_id: id });

export const campaignRevenue = (id: string) =>
  call<CampaignRevenueRow>('baaki_admin_campaign_revenue', { p_campaign_id: id });

export interface CampaignEmailStatRow {
  status: string;
  count: number;
}

/** How the broadcast is going: a count of queued/sent/failed rows for a campaign. */
export const campaignEmailStats = (id: string) =>
  call<CampaignEmailStatRow>('baaki_admin_campaign_email_stats', { p_campaign_id: id });

export interface BroadcastResult {
  sent: number;
  failed: number;
  retry: number;
  /** True when a run hit its per-invocation cap — press again to send the rest. */
  more: boolean;
}

/**
 * Email a campaign to its targeted cohort.
 *
 * Resend is only ever called from an edge function (TDR §7.3), so this does not
 * send anything itself — it invokes `campaign-broadcast` with the service key,
 * which claims the audience, holds the holdout back, and sends. Bounded per
 * invocation, so a large audience is several presses rather than one request
 * that runs for minutes and times out.
 */
export async function broadcastCampaign(campaignId: string): Promise<BroadcastResult> {
  await requireSession();
  if (!UUID.test(campaignId.trim())) {
    throw new Error('That is not a campaign id.');
  }

  const { data, error } = await client().functions.invoke('campaign-broadcast', {
    body: { campaign_id: campaignId.trim() },
  });
  if (error) {
    // supabase-js hands back a generic message and keeps the real one on the
    // Response it carried. The edge function answers `{ code, message }`, and
    // that message — "Email is not configured", say — is the one worth showing.
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      const detail = (await context.json().catch(() => null)) as { message?: string } | null;
      if (detail?.message) throw new Error(detail.message);
    }
    throw new Error(`broadcast failed: ${error.message}`);
  }
  return data as BroadcastResult;
}

export interface FeedbackRow {
  id: string;
  kind: string;
  message: string;
  rating: number | null;
  app_version: string | null;
  platform: string | null;
  locale: string | null;
  country_code: string | null;
  from_deleted_account: boolean;
  created_at: string;
}

/**
 * What people wrote. Note there is no author column and no way to ask for one:
 * knowing who complained is not needed in order to act on a complaint, and the
 * aggregates-only decision applies here too.
 */
export const feedback = (limit = 100) =>
  call<FeedbackRow>('baaki_admin_feedback', {
    p_limit: limit,
  });

export const flagResults = (key: string) =>
  call<FlagResultRow>('baaki_admin_flag_results', { p_key: key });

// ─────────────────────────────────────────────────── rate limiting ──
// The abuse limiter's numbers, made editable. `baaki_rate_limit` reads these
// tables on every call; a bucket with no row falls back to the code default in
// `_shared/rateLimit.ts`, and the master switch exempts everything at once.

export interface RateLimitRuleRow {
  bucket: string;
  enabled: boolean;
  max_calls: number;
  window_seconds: number;
  updated_at: string;
}

/** The master switch. Defaults to on if the table is not deployed yet. */
export async function rateLimitEnabled(): Promise<boolean> {
  await requireSession();
  const { data, error } = await client()
    .from('rate_limit_settings')
    .select('enabled')
    .eq('id', true)
    .maybeSingle();
  if (error) {
    if (error.code === TABLE_MISSING) return true;
    throw new Error(`reading rate_limit_settings failed: ${error.message}`);
  }
  return data?.enabled ?? true;
}

export async function rateLimitRules(): Promise<RateLimitRuleRow[]> {
  await requireSession();
  const { data, error } = await client()
    .from('rate_limit_rules')
    .select('bucket, enabled, max_calls, window_seconds, updated_at')
    .order('bucket');
  if (error) {
    if (error.code === TABLE_MISSING) return [];
    throw new Error(`reading rate_limit_rules failed: ${error.message}`);
  }
  return (data ?? []) as RateLimitRuleRow[];
}

export async function setRateLimitEnabled(enabled: boolean): Promise<void> {
  await requireSession();
  const { error } = await client()
    .from('rate_limit_settings')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) throw new Error(`saving the master switch failed: ${error.message}`);
}

export async function saveRateLimitRule(input: {
  bucket: string;
  enabled: boolean;
  maxCalls: number;
  windowSeconds: number;
}): Promise<void> {
  await requireSession();

  const bucket = input.bucket.trim();
  if (!bucket) throw new Error('A rule needs a bucket name.');
  if (!Number.isInteger(input.maxCalls) || input.maxCalls < 0) {
    throw new Error('Max calls is a whole number, zero or more.');
  }
  if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 1) {
    throw new Error('The window is a whole number of seconds, at least one.');
  }

  const { error } = await client().from('rate_limit_rules').upsert(
    {
      bucket,
      enabled: input.enabled,
      max_calls: input.maxCalls,
      window_seconds: input.windowSeconds,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'bucket' },
  );
  if (error) throw new Error(`saving ${bucket} failed: ${error.message}`);
}

// ─────────────────────────────────────────────────────── user admin ──
// The one place the console reaches into `auth`. Supabase owns that schema and
// grants it to nobody, so these go through the GoTrue admin API on the service
// client rather than a SQL read — searching, confirming an address by hand, and
// comping a paid grant for one named account.

export interface AdminUserRow {
  id: string;
  email: string | null;
  phone: string | null;
  email_confirmed: boolean;
  is_anonymous: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  display_name: string | null;
}

/**
 * Find a handful of accounts matching a typed fragment.
 *
 * GoTrue has no server-side search, so this pages through the directory and
 * filters here. Fine at the scale a support console works at; capped so a large
 * project cannot turn one lookup into a walk of every user.
 */
export async function searchUsers(query: string): Promise<AdminUserRow[]> {
  await requireSession();
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const matches: AdminUserRow[] = [];
  for (let page = 1; page <= 10 && matches.length < 25; page += 1) {
    const { data, error } = await client().auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listing users failed: ${error.message}`);
    for (const u of data.users) {
      const hay = `${u.email ?? ''} ${u.phone ?? ''} ${u.id}`.toLowerCase();
      if (hay.includes(q)) {
        matches.push({
          id: u.id,
          email: u.email ?? null,
          phone: u.phone ?? null,
          email_confirmed: Boolean(u.email_confirmed_at),
          is_anonymous: (u as { is_anonymous?: boolean }).is_anonymous ?? false,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
          display_name: null,
        });
      }
      if (matches.length >= 25) break;
    }
    if (data.users.length < 200) break;
  }

  // Names live in `profiles`, keyed by the same id. One round trip fills them.
  if (matches.length > 0) {
    const { data: profiles } = await client()
      .from('profiles')
      .select('id, display_name')
      .in(
        'id',
        matches.map((m) => m.id),
      );
    const names = new Map((profiles ?? []).map((p) => [p.id, p.display_name as string]));
    for (const row of matches) row.display_name = names.get(row.id) ?? null;
  }

  return matches;
}

export interface AdminUserListRow {
  id: string;
  email: string | null;
  phone: string | null;
  email_confirmed: boolean;
  is_anonymous: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  display_name: string | null;
  country_code: string | null;
  is_plus: boolean;
  device_count: number;
  app_version: string | null;
  platform: string | null;
}

export interface AdminUserList {
  total: number;
  rows: AdminUserListRow[];
}

/**
 * A page of the signup directory, filtered and sorted in SQL.
 *
 * Unlike `searchUsers`, which walks the GoTrue directory in Node because that
 * is all the admin API offers, this goes through `baaki_admin_users` — a
 * SECURITY DEFINER function that can read `auth.users` and join it to profiles,
 * subscriptions and device_sessions in one query. That is what lets it filter
 * by name or country and return a real total for pagination. A missing function
 * (first run before the migration is deployed) degrades to an empty page.
 */
export async function listUsers(params: {
  limit: number;
  offset: number;
  namePrefix?: string;
  country?: string;
}): Promise<AdminUserList> {
  await requireSession();
  const { data, error } = await client().rpc('baaki_admin_users', {
    p_limit: params.limit,
    p_offset: params.offset,
    p_name_prefix: params.namePrefix?.trim() || null,
    p_country: params.country?.trim() || null,
  });
  if (error) {
    if (error.code === FUNCTION_MISSING) return { total: 0, rows: [] };
    throw new Error(`baaki_admin_users failed: ${error.message}`);
  }
  const payload = (data ?? {}) as { total?: number | string; rows?: AdminUserListRow[] };
  return { total: Number(payload.total ?? 0), rows: payload.rows ?? [] };
}

/** Mark an address confirmed by hand — the OTP a person never received. */
export async function confirmUserEmail(userId: string): Promise<void> {
  await requireSession();
  if (!UUID.test(userId.trim())) throw new Error('That is not a user id.');
  const { error } = await client().auth.admin.updateUserById(userId.trim(), {
    email_confirm: true,
  });
  if (error) throw new Error(`confirming failed: ${error.message}`);
}

/**
 * Comp a paid grant for one account. The same SECURITY DEFINER path the
 * promotions page uses, keyed on the profile and the day so pressing it twice
 * in one conversation is the same grant rather than two.
 */
export async function upgradeUser(userId: string, days: number): Promise<string> {
  return grantPromo(userId, days);
}

export const daily = (days = 30) => call<DailyRow>('baaki_admin_daily', { p_days: days });
export const geo = () => call<GeoRow>('baaki_admin_geo');
export const money = () => call<MoneyRow>('baaki_admin_money');
export const aiCost = (days = 30) => call<AiCostRow>('baaki_admin_ai_cost', { p_days: days });
/**
 * Sign-ins, and the one panel allowed to fail on its own.
 *
 * It is the only aggregate that reads outside `public` — Supabase owns
 * `auth.audit_log_entries` and grants it to nobody by default — so it is the
 * one with a way to be unavailable that says nothing about the business. It
 * took the whole dashboard down once: `permission denied for table
 * audit_log_entries` reached the browser as "A server error occurred", with
 * five working panels behind it.
 *
 * Not folded into `call`, and not degraded to an empty array. Empty already
 * means "Supabase has pruned the window", which is a fact about retention; a
 * permission problem is a fact about deployment, and a panel that shows the
 * first when it means the second is worse than one that shows neither.
 */
export async function logins(days = 30): Promise<{ rows: LoginRow[]; unavailable?: string }> {
  try {
    return { rows: await call<LoginRow>('baaki_admin_logins', { p_days: days }) };
  } catch (caught) {
    return { rows: [], unavailable: caught instanceof Error ? caught.message : String(caught) };
  }
}
