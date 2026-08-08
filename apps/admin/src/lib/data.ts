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

  if (!/^[0-9a-f-]{36}$/i.test(profileId.trim())) {
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

export const daily = (days = 30) => call<DailyRow>('baaki_admin_daily', { p_days: days });
export const geo = () => call<GeoRow>('baaki_admin_geo');
export const money = () => call<MoneyRow>('baaki_admin_money');
export const aiCost = (days = 30) => call<AiCostRow>('baaki_admin_ai_cost', { p_days: days });
export const logins = (days = 30) => call<LoginRow>('baaki_admin_logins', { p_days: days });
