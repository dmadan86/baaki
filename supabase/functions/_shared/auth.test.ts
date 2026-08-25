/**
 * Coverage for the shared edge-function plumbing (ADR-013).
 *
 * These are the pieces every function leans on: how a bad amount becomes a 400
 * rather than a 500, how an error maps to a response body, how CORS is answered
 * once in `serveWithCors`, and how `requireMembership` turns a missing token or
 * a non-member into the right 401/403. Getting any of these wrong shows up as a
 * confusing status on every endpoint at once, so they are pinned here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  asCaller,
  errorResponse,
  HttpError,
  json,
  parseMinor,
  requireMembership,
  serveWithCors,
} from './auth.ts';
import { lastServeHandler } from './test/setup.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseMinor', () => {
  it('parses a well-formed minor-unit string to bigint', () => {
    expect(parseMinor('1234', 'amount')).toBe(1234n);
    expect(parseMinor('-1234', 'amount')).toBe(-1234n);
    expect(parseMinor('0', 'amount')).toBe(0n);
  });

  it.each([
    ['not-a-number', 'letters'],
    ['12.34', 'a decimal'],
    ['12e3', 'exponent notation'],
    ['', 'the empty string'],
    ['  12', 'leading whitespace'],
  ])('rejects %j (%s) with a 400 INVALID_AMOUNT, never a throw-through 500', (value) => {
    try {
      parseMinor(value, 'amount');
      throw new Error('expected parseMinor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe('INVALID_AMOUNT');
    }
  });

  it.each([[42], [null], [undefined], [{}]])('rejects the non-string %j with a 400', (value) => {
    expect(() => parseMinor(value, 'amount')).toThrowError(HttpError);
  });

  it('rejects a bigint (a non-string) with a 400', () => {
    expect(() => parseMinor(12n, 'amount')).toThrowError(HttpError);
  });
});

describe('json', () => {
  it('serialises the body, sets the status and carries CORS + content-type', async () => {
    const response = json({ ok: true }, 201, { 'x-extra': 'y' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-extra')).toBe('y');
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('errorResponse', () => {
  it('maps an HttpError to its own status, code and message', async () => {
    const response = await errorResponse(new HttpError(403, 'NOT_A_MEMBER', 'nope'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'NOT_A_MEMBER', message: 'nope' });
  });

  it('carries an HttpError’s extra headers (e.g. Retry-After on a 429)', async () => {
    const response = await errorResponse(
      new HttpError(429, 'RATE_LIMITED', 'slow down', { 'Retry-After': '30' }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('maps an unexpected error to a generic 500 that leaks no internals', async () => {
    const response = await errorResponse(new Error('secret stack detail'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ code: 'INTERNAL', message: 'Something went wrong' });
    expect(JSON.stringify(body)).not.toContain('secret stack detail');
  });
});

describe('serveWithCors', () => {
  it('answers an OPTIONS preflight with the CORS headers and never calls the handler', async () => {
    const handler = vi.fn();
    serveWithCors(handler);
    const response = await lastServeHandler()(
      new Request('https://fn.example/r2-sign', { method: 'OPTIONS' }),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('runs the handler for a real request and stamps the resolved origin', async () => {
    serveWithCors(async () => json({ ok: true }));
    const response = await lastServeHandler()(
      new Request('https://fn.example/r2-sign', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

/**
 * A Supabase client mock is only ever asked two things by `requireMembership`:
 * who the caller is (`auth.getUser`) and the caller's member id in a group
 * (`rpc('baaki_my_member_id')`). Everything else on the real client is absent
 * on purpose — a test that needs more is testing the wrong seam.
 */
function callerMock(options: {
  user?: { id: string } | null;
  userError?: unknown;
  memberId?: string | null;
  rpcError?: { message: string } | null;
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: options.user ?? null },
        error: options.userError ?? null,
      }),
    },
    rpc: vi.fn().mockResolvedValue({
      data: options.memberId ?? null,
      error: options.rpcError ?? null,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('requireMembership', () => {
  it('returns the profile and member id for a live member', async () => {
    const caller = callerMock({ user: { id: 'user-1' }, memberId: 'member-9' });
    await expect(requireMembership(caller, 'group-1')).resolves.toEqual({
      profileId: 'user-1',
      memberId: 'member-9',
    });
    expect(caller.rpc).toHaveBeenCalledWith('baaki_my_member_id', { p_group_id: 'group-1' });
  });

  it('401s when the JWT resolves to no user', async () => {
    const caller = callerMock({ user: null });
    await expect(requireMembership(caller, 'group-1')).rejects.toMatchObject({
      status: 401,
      code: 'NOT_AUTHENTICATED',
    });
  });

  it('403s an authenticated outsider (no member row in the group)', async () => {
    const caller = callerMock({ user: { id: 'user-1' }, memberId: null });
    await expect(requireMembership(caller, 'group-1')).rejects.toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
    });
  });
});

describe('asCaller', () => {
  it('401s when the Authorization header is missing', () => {
    const request = new Request('https://fn.example/r2-sign', { method: 'POST' });
    try {
      asCaller(request);
      throw new Error('expected asCaller to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(401);
      expect((error as HttpError).code).toBe('NOT_AUTHENTICATED');
    }
  });

  it('builds a client when an Authorization header is present and env is set', () => {
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
    const request = new Request('https://fn.example/r2-sign', {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt' },
    });
    expect(asCaller(request)).toBeTruthy();
  });
});
