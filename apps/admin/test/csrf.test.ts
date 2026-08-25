import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const headerStore = new Map<string, string>();
const cookieStore = new Map<string, string>();

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (key: string) => headerStore.get(key.toLowerCase()) ?? null,
  }),
  cookies: async () => ({
    get: (key: string) => {
      const value = cookieStore.get(key);
      return value === undefined ? undefined : { value };
    },
  }),
}));

import { assertCsrfToken, assertSameOrigin, csrfToken, guardMutation } from '@/lib/csrf';
import { SESSION_COOKIE, csrfTokenFor, issueToken } from '@/lib/session';

const HOST = 'baaki.dmadan.com';

beforeEach(() => {
  headerStore.clear();
  cookieStore.clear();
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  delete process.env.ADMIN_ALLOWED_ORIGIN;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signedIn(): Promise<{ form: FormData }> {
  const token = await issueToken();
  cookieStore.set(SESSION_COOKIE, token.value);
  const form = new FormData();
  form.set('_csrf', await csrfTokenFor(token.value));
  return { form };
}

describe('assertSameOrigin', () => {
  it('rejects a missing Origin', async () => {
    headerStore.set('host', HOST);
    await expect(assertSameOrigin()).rejects.toThrow(/without an Origin/);
  });

  it('rejects a foreign Origin', async () => {
    headerStore.set('host', HOST);
    headerStore.set('origin', 'https://evil.example.com');
    await expect(assertSameOrigin()).rejects.toThrow(/another site/);
  });

  it('accepts a same-origin request', async () => {
    headerStore.set('host', HOST);
    headerStore.set('origin', `https://${HOST}`);
    await expect(assertSameOrigin()).resolves.toBeUndefined();
  });

  it('honours a pinned ADMIN_ALLOWED_ORIGIN over the Host header', async () => {
    process.env.ADMIN_ALLOWED_ORIGIN = `https://${HOST}`;
    // Host is attacker-controlled on the back door; the pin ignores it.
    headerStore.set('host', 'baaki-admin.vercel.app');
    headerStore.set('origin', `https://${HOST}`);
    await expect(assertSameOrigin()).resolves.toBeUndefined();

    headerStore.set('origin', 'https://baaki-admin.vercel.app');
    await expect(assertSameOrigin()).rejects.toThrow(/another site/);
  });
});

describe('CSRF token', () => {
  it('accepts a matching session-bound token', async () => {
    const { form } = await signedIn();
    await expect(assertCsrfToken(form)).resolves.toBeUndefined();
  });

  it('rejects a missing token', async () => {
    await signedIn();
    await expect(assertCsrfToken(new FormData())).rejects.toThrow(/stale or forged/);
  });

  it('rejects a forged token', async () => {
    await signedIn();
    const form = new FormData();
    form.set('_csrf', 'not-the-real-token');
    await expect(assertCsrfToken(form)).rejects.toThrow(/stale or forged/);
  });

  it('rejects when there is no session', async () => {
    const form = new FormData();
    form.set('_csrf', 'anything');
    await expect(assertCsrfToken(form)).rejects.toThrow(/session has expired/);
  });

  it('emits an empty token when signed out', async () => {
    await expect(csrfToken()).resolves.toBe('');
  });
});

describe('guardMutation', () => {
  it('passes a same-origin request with a valid session token', async () => {
    headerStore.set('host', HOST);
    headerStore.set('origin', `https://${HOST}`);
    const { form } = await signedIn();
    await expect(guardMutation(form)).resolves.toBeUndefined();
  });

  it('rejects a foreign Origin before the token is considered', async () => {
    headerStore.set('host', HOST);
    headerStore.set('origin', 'https://evil.example.com');
    const { form } = await signedIn();
    await expect(guardMutation(form)).rejects.toThrow(/another site/);
  });
});
