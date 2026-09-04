/**
 * `WEB_URL` is read from `process.env.EXPO_PUBLIC_WEB_URL` at module load, so
 * exercising an override means setting the env var and reloading the module
 * fresh — `vi.resetModules()` plus a dynamic `import()`, same pattern as
 * `watchSendFailure.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEY = 'EXPO_PUBLIC_WEB_URL';

async function loadWith(value: string | undefined) {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  vi.resetModules();
  return import('@/lib/webUrl');
}

afterEach(() => {
  delete process.env[ENV_KEY];
  vi.resetModules();
});

describe('WEB_URL', () => {
  it('defaults to the site’s real domain when unset', async () => {
    const mod = await loadWith(undefined);
    expect(mod.WEB_URL).toBe('https://app.wavs.co.in');
    expect(mod.INVITE_BASE).toBe('https://app.wavs.co.in/join');
    expect(mod.INVITE_HOST).toBe('app.wavs.co.in');
  });

  it('takes a clean origin override as-is', async () => {
    const mod = await loadWith('https://staging.example.com');
    expect(mod.WEB_URL).toBe('https://staging.example.com');
    expect(mod.INVITE_BASE).toBe('https://staging.example.com/join');
    expect(mod.INVITE_HOST).toBe('staging.example.com');
  });

  /**
   * The bug a review pass caught: `INVITE_BASE` assumes it can append `/join`
   * to `WEB_URL` and get exactly that path back. A misconfigured override
   * carrying its own path would otherwise produce `.../app/join`, which
   * `tokenFromScan`'s hardcoded `path !== '/join'` check would then reject —
   * including the app's own freshly generated links.
   */
  it('strips a path, query and fragment off an override to just its origin', async () => {
    const mod = await loadWith('https://staging.example.com/app/sub?x=1#y');
    expect(mod.WEB_URL).toBe('https://staging.example.com');
    expect(mod.INVITE_BASE).toBe('https://staging.example.com/join');
  });

  it('falls back to the default rather than shipping a broken URL', async () => {
    const mod = await loadWith('not a url at all');
    expect(mod.WEB_URL).toBe('https://app.wavs.co.in');
  });

  it('builds a join link with the token as the fragment', async () => {
    const mod = await loadWith(undefined);
    expect(mod.groupJoinLink('abc123')).toBe('https://app.wavs.co.in/join#abc123');
  });
});
