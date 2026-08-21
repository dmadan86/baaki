/**
 * The Supabase client the tools act through — always as a real signed-in user.
 *
 * This is the whole safety argument of the server. It is built with the public
 * anon key and the user's own session (an access token, optionally with a
 * refresh token), exactly the way the mobile app builds its client
 * (`apps/mobile/src/lib/supabase.ts`). Every call therefore carries that user's
 * JWT, so Row-Level Security and the RPC boundary (ADR-013, #274) apply to the
 * agent identically to the human: it can do what that person can do, and
 * nothing more. No service-role key is read here on purpose — a service key
 * would bypass RLS and turn a helpful agent into a way to forge another
 * person's ledger.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface WavesEnv {
  url: string;
  anonKey: string;
  accessToken: string;
  refreshToken?: string;
  /** When true, the write tools are not registered at all. */
  readOnly: boolean;
}

export function readEnv(): WavesEnv {
  const url = process.env.WAVES_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.WAVES_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const accessToken = process.env.WAVES_SUPABASE_ACCESS_TOKEN;
  const refreshToken = process.env.WAVES_SUPABASE_REFRESH_TOKEN;
  const readOnly = ['1', 'true', 'yes'].includes(
    (process.env.WAVES_MCP_READONLY ?? '').toLowerCase(),
  );

  const missing: string[] = [];
  if (!url) missing.push('WAVES_SUPABASE_URL');
  if (!anonKey) missing.push('WAVES_SUPABASE_ANON_KEY');
  if (!accessToken) missing.push('WAVES_SUPABASE_ACCESS_TOKEN');
  if (missing.length) {
    throw new Error(
      `Missing required environment: ${missing.join(', ')}. ` +
        'The server acts as a signed-in user, so it needs that user\'s Supabase ' +
        'session (a WAVES_SUPABASE_ACCESS_TOKEN, and ideally a ' +
        'WAVES_SUPABASE_REFRESH_TOKEN so long sessions keep working).',
    );
  }

  return { url: url!, anonKey: anonKey!, accessToken: accessToken!, refreshToken, readOnly };
}

/**
 * Build the client and attach the user's session. With a refresh token the
 * client is told to keep the access token fresh itself, so a long-running agent
 * does not fall over an hour in; with only an access token it works until that
 * token expires and then every call returns an auth error — which is the honest
 * failure, not a silent one.
 */
export async function makeClient(env: WavesEnv): Promise<SupabaseClient> {
  const client = createClient(env.url, env.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: Boolean(env.refreshToken),
      detectSessionInUrl: false,
    },
    global: {
      // Set the header too, so the very first call (before setSession resolves)
      // already carries the user's JWT rather than the bare anon key.
      headers: { Authorization: `Bearer ${env.accessToken}` },
    },
  });

  if (env.refreshToken) {
    const { error } = await client.auth.setSession({
      access_token: env.accessToken,
      refresh_token: env.refreshToken,
    });
    if (error) throw new Error(`Could not establish the user session: ${error.message}`);
  }

  return client;
}

/** The signed-in user's own id — used to find "me" among a group's members. */
export async function currentUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw new Error(`Not signed in (the session may have expired): ${error?.message ?? 'no user'}`);
  }
  return data.user.id;
}
