import { describe, expect, it, vi } from 'vitest';

// friendlyError reports the raw error to the crash reporter, which pulls the
// native Sentry pipeline — stub it so the pure string logic can be tested.
vi.mock('@/lib/observability', () => ({ reportHandled: vi.fn() }));

import { friendlyError } from '@/lib/errors';

const FALLBACK = 'Could not sign in.';
const OFFLINE = 'Check your connection.';
const TOO_MANY = 'Too many attempts. Wait a minute.';

const friendly = (caught: unknown): string =>
  friendlyError(caught, FALLBACK, 'test', OFFLINE, TOO_MANY);

describe('friendlyError', () => {
  it('maps a 429 status to the too-many-tries sentence', () => {
    // supabase-js AuthError shape on an email send-rate limit.
    expect(friendly({ status: 429, message: 'email rate limit exceeded' })).toBe(TOO_MANY);
  });

  it('maps a rate-limit message with no status to the too-many-tries sentence', () => {
    expect(friendly({ message: 'over_email_send_rate_limit' })).toBe(TOO_MANY);
  });

  it('returns the connection sentence for a network failure, never the raw string', () => {
    // The exact native-transport noise the offline branch exists to hide.
    const raw =
      'fetch failed: UnexpectedException: A TLS error caused the secure connection to fail. (at ExpoModulesCore/Promise.swift:56)';
    expect(friendly({ message: raw })).toBe(OFFLINE);
  });

  it('falls back for a schema-cache error rather than naming a function', () => {
    expect(friendly({ code: 'PGRST202', message: 'Could not find the function public.x' })).toBe(
      FALLBACK,
    );
  });

  it('falls back for anything unrecognised', () => {
    expect(friendly({ message: 'something odd' })).toBe(FALLBACK);
  });

  it('prefers the too-many sentence over the network branch when both could match', () => {
    // A 429 whose message also contains a network-ish word must still read as
    // rate-limited, because the rate-limit branch is checked first.
    expect(friendly({ status: 429, message: 'request failed: rate limit' })).toBe(TOO_MANY);
  });
});
