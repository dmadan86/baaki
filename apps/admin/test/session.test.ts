import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hasTrustedOrigin, isValidToken, issueToken, checkPassword } from '@/lib/session';

const ORIGIN_SECRET = 'origin-secret-value';

beforeAll(() => {
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
});

describe('hasTrustedOrigin', () => {
  afterEach(() => {
    process.env.ADMIN_ORIGIN_SECRET = ORIGIN_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('accepts the exact secret in the header', async () => {
    process.env.ADMIN_ORIGIN_SECRET = ORIGIN_SECRET;
    await expect(hasTrustedOrigin(ORIGIN_SECRET)).resolves.toBe(true);
  });

  it('rejects a missing header even when a secret is configured', async () => {
    process.env.ADMIN_ORIGIN_SECRET = ORIGIN_SECRET;
    await expect(hasTrustedOrigin(null)).resolves.toBe(false);
    await expect(hasTrustedOrigin(undefined)).resolves.toBe(false);
    await expect(hasTrustedOrigin('')).resolves.toBe(false);
  });

  it('rejects a wrong header value', async () => {
    process.env.ADMIN_ORIGIN_SECRET = ORIGIN_SECRET;
    await expect(hasTrustedOrigin('not-the-secret')).resolves.toBe(false);
  });

  it('fails closed in production when the secret is unset', async () => {
    delete process.env.ADMIN_ORIGIN_SECRET;
    process.env.NODE_ENV = 'production';
    await expect(hasTrustedOrigin('anything')).resolves.toBe(false);
    await expect(hasTrustedOrigin(null)).resolves.toBe(false);
  });

  it('opens off production when the secret is unset (localhost dev)', async () => {
    delete process.env.ADMIN_ORIGIN_SECRET;
    process.env.NODE_ENV = 'development';
    await expect(hasTrustedOrigin(null)).resolves.toBe(true);
  });
});

describe('session cookie', () => {
  it('accepts a freshly issued token and rejects tampering', async () => {
    const token = await issueToken();
    await expect(isValidToken(token.value)).resolves.toBe(true);
    await expect(isValidToken(undefined)).resolves.toBe(false);
    await expect(isValidToken(`${token.value}x`)).resolves.toBe(false);
    const [expiry] = token.value.split('.');
    await expect(isValidToken(`${expiry}.forged`)).resolves.toBe(false);
  });

  it('checks the password constant-time-style', async () => {
    await expect(checkPassword('correct horse battery staple')).resolves.toBe(true);
    await expect(checkPassword('wrong')).resolves.toBe(false);
    await expect(checkPassword('')).resolves.toBe(false);
  });
});
