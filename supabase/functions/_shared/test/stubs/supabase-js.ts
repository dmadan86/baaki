/**
 * Test stub for `npm:@supabase/supabase-js@2`.
 *
 * The edge functions import the Supabase SDK through a Deno `npm:` specifier
 * that Node/vitest cannot resolve. Tests never exercise a real client — every
 * handler takes its Supabase clients as injected dependencies and the tests
 * pass hand-rolled mocks — so this stub only has to exist and expose the two
 * names `auth.ts` imports: the `createClient` value and the `SupabaseClient`
 * type. `createClient` returns a sentinel object so the rare test that calls
 * `asCaller`/`asService` (the SDK-construction path) still gets *something*
 * back instead of a resolution error.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupabaseClient = any;

export function createClient(
  _url: string,
  _key: string,
  _options?: unknown,
): { __stub: 'supabase-client' } {
  return { __stub: 'supabase-client' };
}
