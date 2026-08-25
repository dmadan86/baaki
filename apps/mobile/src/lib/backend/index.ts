/**
 * The one seam between the app and its backend.
 *
 * Historically every file reached for `supabase` directly — `supabase.rpc(...)`,
 * `supabase.from(...)`, `supabase.auth.*` — so the whole app knew the name of
 * its vendor. This module is the single place that name is allowed. Everything
 * else imports `backend` and talks to the `Backend` interface below; the
 * concrete Supabase client is injected here and nowhere else (see
 * `lib/supabase.ts`, the adapter).
 *
 * Why this shape (and not deeper domain ports): the `Backend` surface is the
 * exact slice of the client the app uses, typed as an allow-list — so a second
 * implementation only has to provide these members, and a rogue `supabase.xyz`
 * elsewhere no longer type-checks. The read methods (`from`) keep PostgREST's
 * shape on purpose: the escape-hatch stack (`infra/self-host`) and any managed
 * PostgREST are drop-in, so the reads move untouched. Shedding PostgREST itself
 * (a non-REST backend) is the deeper `DataPort` work called out in MIGRATION.md
 * — deliberately not done here.
 *
 * The auth surface, by contrast, IS fully behind this interface — it is the
 * stickiest lock-in (anonymous guests, in-place upgrade, id-token sign-in), so
 * pinning exactly which calls the app makes is what makes a future swap legible.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabase, supabaseConfigured } from '@/lib/supabase';

/**
 * The auth calls the app actually makes. `startAutoRefresh`/`stopAutoRefresh`
 * are intentionally absent: they are the adapter's own lifecycle concern
 * (`lib/supabase.ts`), not something a screen calls.
 */
type BackendAuth = Pick<
  SupabaseClient['auth'],
  | 'getSession'
  | 'onAuthStateChange'
  | 'signInAnonymously'
  | 'signInWithOtp'
  | 'verifyOtp'
  | 'signInWithPassword'
  | 'signUp'
  | 'updateUser'
  | 'signInWithOAuth'
  | 'linkIdentity'
  | 'signInWithIdToken'
  | 'setSession'
  | 'signOut'
  | 'resend'
>;

/**
 * The backend surface the app is allowed to use. A structural subset of the
 * Supabase client today; a second adapter only needs to provide these members.
 */
export type Backend = Pick<
  SupabaseClient,
  'from' | 'rpc' | 'functions' | 'storage' | 'channel' | 'removeChannel'
> & {
  auth: BackendAuth;
};

/**
 * The injected backend. Swapping vendors means replacing this one binding with
 * a different `Backend` implementation — no call site changes.
 */
export const backend: Backend = supabase;

/** Whether the build shipped a usable backend config (see `lib/supabase.ts`). */
export const backendConfigured = supabaseConfigured;

/**
 * Auth value types re-exported so no screen imports `@supabase/supabase-js`
 * directly. When the backend changes, these change here and only here.
 */
export type { Session, User } from '@supabase/supabase-js';
