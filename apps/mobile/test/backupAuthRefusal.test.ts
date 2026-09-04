/**
 * A revoked Drive grant must read as "re-authorise", not "nothing is linked".
 *
 * The two states look identical from the outside — no usable tokens either way
 * — and the engine used to flatten them into one with a `.catch(() => null)`
 * around the refresh. The screen then offered connect-from-scratch as the
 * remedy for a link that already existed, while the dead tokens sat on disk
 * being retried forever.
 *
 * The provider seam is what tells them apart: `ensureValid` normalises an OAuth
 * error that means the grant is gone into the same 401 a Drive API call
 * produces, so one predicate covers both halves. A refresh that failed because
 * the network dropped is deliberately *not* that, and must not sign anybody out
 * of their own backup over a bad minute of signal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  keystore: new Map<string, string>(),
  /** What `ensureValid` should do on the next call. */
  refresh: 'ok' as 'ok' | 'revoked' | 'network',
  find: vi.fn(),
  put: vi.fn(),
  read: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: async (key: string) => hoisted.keystore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    hoisted.keystore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    hoisted.keystore.delete(key);
  },
}));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
}));

vi.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isInternetReachable: true, type: 'wifi' }),
  NetworkStateType: { WIFI: 'wifi', CELLULAR: 'cellular' },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
}));

vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: () => undefined }));

vi.mock('expo-auth-session', () => ({
  AuthRequest: class {},
  exchangeCodeAsync: async () => ({}),
  makeRedirectUri: () => 'waves://oauthredirect',
  refreshAsync: async () => ({}),
}));

// A stand-in for Google Drive. `isConfigured` is true so the engine gets past
// the client-id gate without this build needing OAuth ids.
vi.mock('@/lib/cloud/providers', async () => {
  const { CloudHttpError } = await import('../src/lib/cloud/http');
  const provider = {
    id: 'gdrive' as const,
    label: 'Google Drive',
    isConfigured: () => true,
    connect: async () => null,
    async ensureValid(tokens: unknown) {
      if (hoisted.refresh === 'revoked') {
        // What googleDrive.ensureValid produces for `invalid_grant`.
        throw new CloudHttpError(401, 'invalid_grant: Token has been expired or revoked.');
      }
      if (hoisted.refresh === 'network') throw new TypeError('Network request failed');
      return tokens;
    },
    account: async () => 'someone@example.com',
    find: hoisted.find,
    put: hoisted.put,
    read: hoisted.read,
  };
  return { providerFor: () => provider, allProviders: () => [provider] };
});

const { loadTokens, saveTokens } = await import('../src/lib/cloud/tokens');
const { runBackup, scanBackup } = await import('../src/lib/backup/engine');
const { parseRecoveryKey } = await import('../src/lib/backup/recoveryKey');
const { SyncNetworkPreference } = await import('../src/lib/syncNetwork');
const { asAuthFailure } = await import('../src/lib/cloud/oauth');
const { isAuthFailure } = await import('../src/lib/cloud/http');

const OWNER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const KEY = parseRecoveryKey('11'.repeat(32))!;
const TOKENS = { accessToken: 'stale', refreshToken: 'revoked-by-the-user', expiresAt: 1 };

const backupInput = {
  ownerId: OWNER,
  records: [],
  key: KEY,
  network: SyncNetworkPreference.Both,
  manual: true,
};

beforeEach(() => {
  hoisted.keystore.clear();
  hoisted.refresh = 'ok';
  hoisted.find.mockReset().mockResolvedValue(null);
  hoisted.put.mockReset().mockResolvedValue({
    remoteId: 'file-1',
    name: 'x.json',
    size: 100,
    modifiedAt: null,
  });
  hoisted.read.mockReset();
});

describe('a refresh token the user has revoked', () => {
  it('makes a backup say "auth", not "not connected"', async () => {
    await saveTokens('gdrive', OWNER, TOKENS);
    hoisted.refresh = 'revoked';

    const result = await runBackup(backupInput);
    expect(result).toEqual({ ok: false, refusal: 'auth' });
  });

  it('drops the dead tokens, so the screen stops offering a retry that cannot work', async () => {
    await saveTokens('gdrive', OWNER, TOKENS);
    hoisted.refresh = 'revoked';

    await runBackup(backupInput);
    expect(await loadTokens('gdrive', OWNER)).toBeNull();
  });

  it('never reaches Drive with tokens it already knows are dead', async () => {
    await saveTokens('gdrive', OWNER, TOKENS);
    hoisted.refresh = 'revoked';

    await runBackup(backupInput);
    expect(hoisted.find).not.toHaveBeenCalled();
    expect(hoisted.put).not.toHaveBeenCalled();
  });

  it('makes a restore say "auth" too', async () => {
    await saveTokens('gdrive', OWNER, TOKENS);
    hoisted.refresh = 'revoked';

    const result = await scanBackup({ ownerId: OWNER, key: KEY, localIds: new Set() });
    expect(result).toEqual({ ok: false, refusal: 'auth' });
    expect(hoisted.read).not.toHaveBeenCalled();
  });
});

describe('no tokens at all', () => {
  it('is still "not connected", which is a different problem with a different fix', async () => {
    expect(await runBackup(backupInput)).toEqual({ ok: false, refusal: 'not-connected' });
    expect(await scanBackup({ ownerId: OWNER, key: KEY, localIds: new Set() })).toEqual({
      ok: false,
      refusal: 'not-connected',
    });
  });
});

describe('a refresh that failed for any other reason', () => {
  it('throws, so the caller launders it — a dropped connection is not a dead link', async () => {
    await saveTokens('gdrive', OWNER, TOKENS);
    hoisted.refresh = 'network';

    await expect(runBackup(backupInput)).rejects.toThrow(/network request failed/i);
  });

  it('leaves the tokens alone, so the next attempt on a good connection works', async () => {
    await saveTokens('gdrive', OWNER, TOKENS);
    hoisted.refresh = 'network';

    await runBackup(backupInput).catch(() => undefined);
    expect(await loadTokens('gdrive', OWNER)).toEqual(TOKENS);

    hoisted.refresh = 'ok';
    expect((await runBackup(backupInput)).ok).toBe(true);
  });
});

describe('a Drive call that 401s after a good refresh', () => {
  it('is the same "auth" refusal, and clears the tokens the same way', async () => {
    const { CloudHttpError } = await import('../src/lib/cloud/http');
    await saveTokens('gdrive', OWNER, TOKENS);
    hoisted.find.mockRejectedValue(new CloudHttpError(401, 'insufficient permissions'));

    expect(await runBackup(backupInput)).toEqual({ ok: false, refusal: 'auth' });
    expect(await loadTokens('gdrive', OWNER)).toBeNull();
  });
});

describe('what the provider seam recognises as a dead grant', () => {
  // The engine's half is mocked above; this is the real mapping the Drive
  // provider applies, so the two halves are known to meet.
  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'])(
    'turns %s into the 401 the rest of the code already understands',
    (code) => {
      const mapped = asAuthFailure({ code, description: 'Token has been revoked.' });
      expect(mapped?.status).toBe(401);
      expect(isAuthFailure(mapped)).toBe(true);
    },
  );

  it('leaves a transport failure alone — it is not about the grant', () => {
    expect(asAuthFailure(new TypeError('Network request failed'))).toBeNull();
    expect(asAuthFailure({ code: 'server_error' })).toBeNull();
    expect(asAuthFailure(undefined)).toBeNull();
  });
});
