/**
 * Drive authorization, now that Google's browser redirect is gone on Android.
 *
 * The flow this replaces could be reasoned about from the URL: a code came back
 * to `waves://oauthredirect`, was exchanged for a refresh token, and the refresh
 * token renewed itself for as long as the grant stood. None of that exists any
 * more. Play services holds the grant, hands out an access token that lasts
 * about an hour, and says nothing about when it was minted.
 *
 * So the properties worth pinning down are the ones that changed shape:
 *
 *   * a renewal is **silent** — a backup running in the background must never
 *     put a sheet in front of somebody who did not ask for one;
 *   * a grant that is gone reads as **401**, the same thing a Drive call would
 *     say, because that is the one signal the engine acts on;
 *   * a dismissed sheet is **not an error**, because they meant it;
 *   * unlinking tells **Google**, not only this phone's keystore.
 *
 * And one the flow added: a refusal has to say *which* refusal it was. Play
 * services answers "why" with a status code the SDK's own `statusCodes` does
 * not name, so an unclassified failure is a failure nobody can act on — the
 * screen says "try again" for a build Google will never issue a token to.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Classification files the failure with the crash reporter on the way past,
// which pulls the native Sentry pipeline; stub it, and assert on it.
const reportHandled = vi.hoisted(() => vi.fn());
vi.mock('@/lib/observability', () => ({ reportHandled }));

const platform = { OS: 'android' };

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.OS;
    },
    select: (o: Record<string, unknown>) => o[platform.OS] ?? o.default,
  },
}));

const { googleDrive } = await import('../src/lib/cloud/googleDrive');
const { setSigninModuleForTests } = await import('../src/lib/cloud/nativeGoogle');
const { isConfigured } = await import('../src/lib/cloud/config');
const { CloudHttpError } = await import('../src/lib/cloud/http');
const { CloudAuthError } = await import('../src/lib/cloud/oauth');

const SIGN_IN_CANCELLED = 'SIGN_IN_CANCELLED';
const SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED';
const PLAY_SERVICES_NOT_AVAILABLE = 'PLAY_SERVICES_NOT_AVAILABLE';
/** Not in the SDK's `statusCodes`; Android rejects with the bare number. */
const DEVELOPER_ERROR = '10';

interface FakeState {
  /** What the interactive sheet does. */
  signIn: 'success' | 'cancelled' | 'throws-cancelled' | 'developer-error' | 'network';
  /** Whether Google's services are there to present the sheet at all. */
  play: 'present' | 'missing';
  /** What a silent renewal finds. */
  silent: 'success' | 'nobody' | 'required' | 'throws';
  /** Whether native revoke completes or throws after a partial Play-services failure. */
  revoke: 'success' | 'throws';
  accessToken: string;
}

const state: FakeState = {
  signIn: 'success',
  play: 'present',
  silent: 'success',
  revoke: 'success',
  accessToken: 'token-1',
};
const calls = {
  signIn: vi.fn(),
  signInSilently: vi.fn(),
  getTokens: vi.fn(),
  cleared: vi.fn(),
  revoked: vi.fn(),
  configured: vi.fn(),
  fetch: vi.fn(),
};

function cancelled(code: string): Error & { code: string } {
  return Object.assign(new Error('cancelled'), { code });
}

/** Only the surface `nativeGoogle` actually touches. */
function fakeModule() {
  return {
    GoogleSignin: {
      configure: (params: unknown) => calls.configured(params),
      async hasPlayServices() {
        if (state.play === 'missing') throw cancelled(PLAY_SERVICES_NOT_AVAILABLE);
        return true;
      },
      async signIn() {
        calls.signIn();
        if (state.signIn === 'throws-cancelled') throw cancelled(SIGN_IN_CANCELLED);
        if (state.signIn === 'developer-error') {
          // Exactly what RNGoogleSigninModule rejects with: the bare number, and
          // a message pointing at the library's troubleshooting page.
          throw Object.assign(
            new Error('DEVELOPER_ERROR: Follow troubleshooting instructions at ...'),
            { code: DEVELOPER_ERROR },
          );
        }
        if (state.signIn === 'network') throw new Error('network error');
        if (state.signIn === 'cancelled') return { type: 'cancelled', data: null };
        return { type: 'success', data: { user: { email: 'someone@example.com' } } };
      },
      async signInSilently() {
        calls.signInSilently();
        if (state.silent === 'throws') throw new Error('network error');
        if (state.silent === 'required') throw cancelled(SIGN_IN_REQUIRED);
        if (state.silent === 'nobody') return { type: 'noSavedCredentialFound', data: null };
        return { type: 'success', data: { user: { email: 'someone@example.com' } } };
      },
      async getTokens() {
        calls.getTokens();
        return { idToken: 'id', accessToken: state.accessToken };
      },
      async clearCachedAccessToken(token: string) {
        calls.cleared(token);
        return null;
      },
      async revokeAccess() {
        calls.revoked();
        if (state.revoke === 'throws') throw new Error('native revoke failed');
        return null;
      },
      async signOut() {
        return null;
      },
    },
    isSuccessResponse: (response: { type: string }) => response.type === 'success',
    isErrorWithCode: (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error,
    statusCodes: { SIGN_IN_CANCELLED, SIGN_IN_REQUIRED, PLAY_SERVICES_NOT_AVAILABLE },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  platform.OS = 'android';
  state.signIn = 'success';
  state.play = 'present';
  state.silent = 'success';
  state.revoke = 'success';
  state.accessToken = 'token-1';
  calls.fetch.mockResolvedValue({ ok: true, text: async () => '' });
  vi.stubGlobal('fetch', calls.fetch);
  process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_WEB = '1234.apps.googleusercontent.com';

  setSigninModuleForTests(fakeModule() as any);
});

describe('asking for consent', () => {
  it('hands back a token that expires, and no refresh token to renew it with', async () => {
    const tokens = await googleDrive.connect();
    expect(tokens?.accessToken).toBe('token-1');
    // The absence matters: `isExpired` waits for a refresh when one exists, and
    // there is nothing here that could ever perform it.
    expect(tokens?.refreshToken).toBeNull();
    expect(tokens?.expiresAt).toBeGreaterThan(Date.now());
    // Under an hour, because Google's are an hour and this one is already older
    // than the moment it was asked for.
    expect(tokens?.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
  });

  it('names the project it is asking on behalf of', async () => {
    await googleDrive.connect();
    expect(calls.configured).toHaveBeenCalledWith(
      expect.objectContaining({
        webClientId: '1234.apps.googleusercontent.com',
        scopes: ['https://www.googleapis.com/auth/drive.appdata'],
        // A code meant for a server holding a client secret. There is no such
        // server, and asking for one would put a longer-lived grant on a phone.
        offlineAccess: false,
      }),
    );
  });

  it('treats a dismissed sheet as a decision, not a failure', async () => {
    state.signIn = 'cancelled';
    await expect(googleDrive.connect()).resolves.toBeNull();
  });

  it('treats a cancellation raised as an error the same way', async () => {
    // Android reports this by rejecting rather than resolving.
    state.signIn = 'throws-cancelled';
    await expect(googleDrive.connect()).resolves.toBeNull();
  });
});

describe('saying which refusal it was', () => {
  it('calls DEVELOPER_ERROR what it is: a build nothing can be retried into', async () => {
    state.signIn = 'developer-error';
    // The screen offers "try again" for `failed` and does not for `not-set-up`,
    // which is the entire point of classifying: no Android OAuth client is
    // registered for this package name and signing certificate, and tapping the
    // button again cannot register one.
    await expect(googleDrive.connect()).rejects.toMatchObject({
      fault: 'not-set-up',
      status: DEVELOPER_ERROR,
    });
  });

  it('separates Google services being absent from the request being refused', async () => {
    state.play = 'missing';
    await expect(googleDrive.connect()).rejects.toMatchObject({ fault: 'play-services' });
    expect(calls.signIn).not.toHaveBeenCalled();
  });

  it('leaves an ordinary failure retryable, because it is', async () => {
    state.signIn = 'network';
    await expect(googleDrive.connect()).rejects.toMatchObject({ fault: 'failed', status: null });
  });

  it('says so when the build carries no module to ask with', async () => {
    setSigninModuleForTests(null);
    await expect(googleDrive.connect()).rejects.toMatchObject({ fault: 'not-set-up' });
  });

  it('says so when the build names no Cloud project', async () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_WEB;
    await expect(googleDrive.connect()).rejects.toMatchObject({ fault: 'not-set-up' });
  });

  it('files the status code with the crash reporter, and nothing identifying', async () => {
    state.signIn = 'developer-error';
    await expect(googleDrive.connect()).rejects.toBeInstanceOf(CloudAuthError);

    expect(reportHandled).toHaveBeenCalledTimes(1);
    const [reported, where] = reportHandled.mock.calls[0] as [Error, string];
    expect(where).toBe('cloud.googleAuthorize');
    // The code is the diagnosis and the reason this is reported at all.
    expect(reported.message).toContain(DEVELOPER_ERROR);
    expect(reported.message).toContain('DEVELOPER_ERROR');
    // The account and the token are not, and must never ride along.
    expect(reported.message).not.toContain('someone@example.com');
    expect(reported.message).not.toContain('token-1');
  });

  it('reports a renewal that fails behind a scheduled backup, where no screen would', async () => {
    // The half of the flow with nobody watching: a silent renewal runs under
    // AutoBackup, so a failure there that is not reported is invisible
    // entirely. A grant that is merely *gone* is still not this — that resolves
    // to null and becomes the 401 the engine already knows how to act on.
    state.silent = 'throws';
    const expired = { accessToken: 'token-1', refreshToken: null, expiresAt: Date.now() - 1_000 };

    await expect(googleDrive.ensureValid(expired)).rejects.toMatchObject({ fault: 'failed' });
    expect(reportHandled).toHaveBeenCalledWith(expect.anything(), 'cloud.googleReauthorize');
  });

  it('does not report a cancellation — they meant it', async () => {
    state.signIn = 'throws-cancelled';
    await googleDrive.connect();
    expect(reportHandled).not.toHaveBeenCalled();
  });
});

describe('renewing an expired token', () => {
  const expired = { accessToken: 'token-1', refreshToken: null, expiresAt: Date.now() - 1_000 };

  it('does it without a sheet', async () => {
    state.accessToken = 'token-2';
    const renewed = await googleDrive.ensureValid(expired);
    expect(renewed.accessToken).toBe('token-2');
    expect(calls.signInSilently).toHaveBeenCalled();
    expect(calls.signIn).not.toHaveBeenCalled();
  });

  it('drops the stale token first, or Android returns it again', async () => {
    await googleDrive.ensureValid(expired);
    expect(calls.cleared).toHaveBeenCalledWith('token-1');
  });

  it('leaves a token that is still good alone', async () => {
    const fresh = { accessToken: 'token-1', refreshToken: null, expiresAt: Date.now() + 600_000 };
    await expect(googleDrive.ensureValid(fresh)).resolves.toBe(fresh);
    expect(calls.getTokens).not.toHaveBeenCalled();
  });

  it('reports a revoked grant as a 401, which is what the engine acts on', async () => {
    state.silent = 'nobody';
    await expect(googleDrive.ensureValid(expired)).rejects.toBeInstanceOf(CloudHttpError);
    await expect(googleDrive.ensureValid(expired)).rejects.toMatchObject({ status: 401 });
  });

  it('says the same when Google wants the person to sign in again', async () => {
    state.silent = 'required';
    await expect(googleDrive.ensureValid(expired)).rejects.toMatchObject({ status: 401 });
  });
});

describe('unlinking', () => {
  it('gives the grant back to Google rather than only forgetting it here', async () => {
    await googleDrive.revoke?.({
      accessToken: 'token-1',
      refreshToken: null,
      expiresAt: Date.now(),
    });
    expect(calls.revoked).toHaveBeenCalled();
    expect(calls.cleared).toHaveBeenCalledWith('token-1');
    expect(calls.fetch).not.toHaveBeenCalled();
  });

  it('falls back to HTTP revoke when native revoke fails partway through', async () => {
    state.revoke = 'throws';
    await googleDrive.revoke?.({
      accessToken: 'token-1',
      refreshToken: null,
      expiresAt: Date.now(),
    });

    expect(calls.revoked).toHaveBeenCalled();
    expect(calls.fetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=token-1',
    });
  });

  it('falls back to HTTP revoke when tokens exist but the native module does not', async () => {
    setSigninModuleForTests(null);
    await googleDrive.revoke?.({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now(),
    });

    expect(calls.fetch).toHaveBeenCalledWith('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=refresh-token',
    });
  });
});

describe('whether the row is offered at all', () => {
  it('is not, on a build that names no project', () => {
    delete process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_WEB;
    expect(isConfigured('gdrive')).toBe(false);
    expect(googleDrive.isConfigured()).toBe(false);
  });

  it('is not, on a build whose binary predates the module', () => {
    setSigninModuleForTests(null);
    // The project is still named; the phone simply cannot ask.
    expect(isConfigured('gdrive')).toBe(true);
    expect(googleDrive.isConfigured()).toBe(false);
  });

  it('is not offered on web even when a project is named', () => {
    platform.OS = 'web';
    expect(isConfigured('gdrive')).toBe(false);
    expect(googleDrive.isConfigured()).toBe(false);
  });

  it('requires the iOS client id on iOS builds', () => {
    platform.OS = 'ios';
    delete process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_IOS;
    expect(isConfigured('gdrive')).toBe(false);
    expect(googleDrive.isConfigured()).toBe(false);
  });

  it('configures the iOS client id only on iOS builds', async () => {
    platform.OS = 'ios';
    process.env.EXPO_PUBLIC_GOOGLE_DRIVE_CLIENT_ID_IOS = 'ios-client.apps.googleusercontent.com';
    expect(isConfigured('gdrive')).toBe(true);

    await googleDrive.connect();

    expect(calls.configured).toHaveBeenCalledWith(
      expect.objectContaining({ iosClientId: 'ios-client.apps.googleusercontent.com' }),
    );
  });
});
