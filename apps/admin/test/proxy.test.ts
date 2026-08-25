import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { proxy } from '@/proxy';
import { issueToken, ORIGIN_SECRET_HEADER, SESSION_COOKIE } from '@/lib/session';

const ORIGIN_SECRET = 'origin-secret-value';

// The real vercel.app back door: an attacker sending a request straight to the
// origin sets Host to the custom domain, but cannot forge the Cloudflare header.
const VERCEL_ORIGIN = 'https://baaki-admin.vercel.app';
const SPOOFED_HOST = 'baaki.dmadan.com';

beforeAll(() => {
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_ORIGIN_SECRET = ORIGIN_SECRET;
  process.env.NODE_ENV = 'production';
});

async function validCookie(): Promise<string> {
  const token = await issueToken();
  return `${SESSION_COOKIE}=${token.value}`;
}

function request(
  path: string,
  headers: Record<string, string>,
  origin = 'https://baaki.dmadan.com',
): NextRequest {
  return new NextRequest(new URL(path, origin), { headers });
}

describe('proxy origin + session gate', () => {
  it('rejects a valid cookie with a missing origin header and a spoofed Host (the back door)', async () => {
    const res = await proxy(
      request('/', { cookie: await validCookie(), host: SPOOFED_HOST }, VERCEL_ORIGIN),
    );
    expect(res.status).toBe(403);
  });

  it('passes a valid origin header + valid cookie', async () => {
    const res = await proxy(
      request('/', {
        cookie: await validCookie(),
        [ORIGIN_SECRET_HEADER]: ORIGIN_SECRET,
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a valid cookie WITHOUT the origin header', async () => {
    const res = await proxy(request('/', { cookie: await validCookie() }));
    expect(res.status).toBe(403);
  });

  it('redirects a valid origin header but NO cookie to /login', async () => {
    const res = await proxy(request('/', { [ORIGIN_SECRET_HEADER]: ORIGIN_SECRET }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('lets the login form through the origin gate without a cookie', async () => {
    const res = await proxy(request('/login', { [ORIGIN_SECRET_HEADER]: ORIGIN_SECRET }));
    expect(res.status).toBe(200);
  });

  it('refuses even the login form when the origin header is missing (custom-domain back door)', async () => {
    const res = await proxy(request('/login', { host: SPOOFED_HOST }, VERCEL_ORIGIN));
    expect(res.status).toBe(403);
  });
});
