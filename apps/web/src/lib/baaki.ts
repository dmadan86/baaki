'use client';

import { createClient } from '@supabase/supabase-js';

import { createBaakiClient, type BaakiClient } from '@waves/api-client';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. ' +
      'Copy apps/web/.env.example to .env.local.',
  );
}

/**
 * The anon key ships in the page, the same as it ships in the app binary.
 * That is what it is for: every table is behind RLS, so this key can only ever
 * read rows the signed-in session is entitled to (ADR-013).
 *
 * The session is stored per browser. A guest who opens a link, joins, and
 * comes back tomorrow is the same account — which is what makes the later
 * upgrade to a real login keep their history (ADR-006).
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export const baaki: BaakiClient = createBaakiClient({ supabase });
