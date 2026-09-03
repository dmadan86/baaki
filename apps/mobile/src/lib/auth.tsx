import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import type { Session } from '@/lib/backend';
import { makeRedirectUri } from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import {
  appleFullName,
  AuthMethod,
  checkPassword,
  OAuthMethod,
  planAuth,
  readIdentifier,
  readOAuthCallback,
  type Viewer,
} from '@waves/core';

import { identifyForReporting, reportHandled } from './observability';
import { refreshPushToken, revokePushToken } from './push';
import { backend } from './backend';

/**
 * What @waves/core needs to know to pick the right call. The distinction that
 * matters is anonymous-with-data versus nobody: they look the same to a screen
 * and could not be more different to the person holding the phone.
 */
function viewerFrom(session: Session | null): Viewer {
  if (!session?.user) return { kind: 'nobody' };
  return session.user.is_anonymous === true
    ? { kind: 'guest', userId: session.user.id }
    : { kind: 'user', userId: session.user.id };
}

/**
 * A provider sign-in that goes through the browser.
 *
 * Every case — a fresh sign-in and *any* upgrade of an account that already
 * exists — comes through here. That last one is not an edge case in this app:
 * ADR-006 puts everybody through the guest door first, so linking is the common
 * path.
 *
 * Returns the session to store, or `undefined` when there is nothing to change
 * because somebody closed the browser.
 */
async function oauthThroughBrowser(
  provider: OAuthMethod,
  link: boolean,
): Promise<Session | null | undefined> {
  const redirectTo = makeRedirectUri({ scheme: 'baaki', path: 'auth' });

  // Both calls return a URL rather than opening it: the browser has to be the
  // in-app one, or the session comes back to a tab the app cannot see.
  const { data, error } = link
    ? await backend.auth.linkIdentity({
        provider,
        options: { redirectTo, skipBrowserRedirect: true },
      })
    : await backend.auth.signInWithOAuth({
        provider,
        options: { redirectTo, skipBrowserRedirect: true },
      });
  if (error) throw error;
  if (!data?.url) throw new Error(`${provider} did not give us a sign-in link`);

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return undefined;

  // PKCE (`flowType` in lib/supabase.ts): the redirect carries a one-time
  // code, and only this client holds the verifier that redeems it. The refresh
  // token never travels through the URL, so another app that claims the same
  // scheme and catches the redirect gets nothing it can use.
  const callback = readOAuthCallback(result.url);
  if (callback.kind === 'error') throw new Error(callback.message);
  if (callback.kind === 'none') {
    // A redirect that added nothing: the session it just linked an identity
    // to is the one already held.
    const { data: current } = await backend.auth.getSession();
    return current.session;
  }

  const { data: signedIn, error: sessionError } = await backend.auth.exchangeCodeForSession(
    callback.code,
  );
  if (sessionError) throw sessionError;
  return signedIn.session;
}

/**
 * Sign in with Apple's native sheet — iOS only.
 *
 * The module is a native one, so it is required lazily behind a catch: a build
 * that predates the `expo-apple-authentication` dependency (Android, web, or an
 * old dev client) must fall back to the browser flow rather than crash at
 * launch (see the native-module rule).
 */
type AppleAuthModule = typeof import('expo-apple-authentication');

function loadAppleAuth(): AppleAuthModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-apple-authentication') as AppleAuthModule;
  } catch {
    return null;
  }
}

/**
 * Present Apple's native sheet and hand back the identity token plus, only on
 * the very first authorization, the person's name — Apple returns it once and
 * never again. `undefined` means they dismissed the sheet.
 *
 * The token is bound to this one request with a nonce: Apple is given its
 * SHA-256 and stamps that into the identity token, Supabase is given the raw
 * value and checks the hash matches. Without it, an identity token captured
 * anywhere — another app, a log, an old device — is a valid sign-in here.
 */
async function appleNativeCredential(apple: AppleAuthModule): Promise<
  | {
      identityToken: string;
      nonce: string;
      fullName: {
        givenName: string | null;
        middleName: string | null;
        familyName: string | null;
      } | null;
    }
  | undefined
> {
  const nonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
  try {
    const credential = await apple.signInAsync({
      requestedScopes: [
        apple.AppleAuthenticationScope.FULL_NAME,
        apple.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
    if (!credential.identityToken) {
      throw new Error('Apple sign-in returned no identity token');
    }
    return { identityToken: credential.identityToken, nonce, fullName: credential.fullName };
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') return undefined;
    throw error;
  }
}

/**
 * Persist the name Apple hands over on the first authorization — the one time
 * it is ever sent. The `profiles` row is created by a trigger on `auth.users`
 * that can land a beat after the session (the same lag the profile-load effect
 * retries around), so a lone `UPDATE` can match zero rows and lose a value that
 * can never be re-fetched. So: write it to user metadata first — that never
 * depends on the row — then retry the profile update until a row is affected.
 */
async function persistAppleName(userId: string, name: string): Promise<void> {
  await backend.auth.updateUser({ data: { display_name: name } }).catch(() => undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await backend
      .from('profiles')
      .update({ display_name: name })
      .eq('id', userId)
      .select('id');
    if (!error && data && data.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
}

export interface Profile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  /** The UPI-shaped field. Superseded by the rail pair; still read as a fallback. */
  default_vpa: string | null;
  /** How this person is paid: a `RailId` from `@waves/core`, and a handle on it. */
  payment_rail: string | null;
  payment_handle: string | null;
  /** ISO-3166 alpha-2 — seeds a new group's country and the default currency. */
  country_code: string | null;
  /** Optional postal address, one free-text field. Null until they type one. */
  address: string | null;
  default_currency: string;
  locale: string;
}

/**
 * What a password attempt led to, for the one case the caller must react to:
 * an email sign-up with confirmations on returns no session until the link is
 * followed, so `verifyEmail` carries the address to send them to a
 * check-your-inbox screen. Empty for every path that lands a session (sign-in,
 * a guest upgraded in place, or a project with confirmations off).
 */
export interface PasswordOutcome {
  verifyEmail?: string;
}

interface AuthValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** ADR-006: a guest can use the app before deciding to be a user. */
  isGuest: boolean;
  sendOtp: (phone: string) => Promise<void>;
  verifyOtp: (phone: string, token: string) => Promise<void>;
  /**
   * A one-time code mailed to an address — the passwordless way in, and the
   * recovery path behind "Forgot password". `createUser` is false on the login
   * door (a typo must not mint an empty account) and true on sign-up.
   */
  sendEmailOtp: (email: string, createUser: boolean) => Promise<void>;
  verifyEmailOtp: (email: string, token: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  /**
   * Email or phone plus a password. Which Supabase call this makes is decided
   * by `planAuth` in @waves/core, not here — a guest must be upgraded in place
   * (ADR-006), and getting that wrong strands their groups on an account they
   * can no longer reach.
   */
  withPassword: (
    identifier: string,
    password: string,
    intent: 'sign_in' | 'sign_up',
  ) => Promise<PasswordOutcome>;
  /** Google. Links to the current account when there is one, for the same reason. */
  withGoogle: () => Promise<void>;
  /** Apple. Native sheet on iOS for a fresh sign-in; browser otherwise and for links. */
  withApple: () => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => Promise<void>;
  /** Re-read the session after it changes underneath us (e.g. a linked email). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // No `.catch` here used to mean a rejected getSession — a corrupt stored
    // session, a storage read that fails, no network on a cold start — became
    // an unhandled rejection at boot ("Uncaught (in promise, id: 0)") and left
    // the app stuck on the loading spinner, because `setLoading(false)` only
    // ran on the happy path. A failure to read a session is a signed-out
    // launch, not a dead one: clear it and let the auth gate send them to
    // sign-in.
    backend.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setSession(data.session);
      })
      .catch((caught) => {
        reportHandled(caught, 'auth.getSession');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const { data: subscription } = backend.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  // Adjusting state during render (rather than in an effect) is the documented
  // React pattern for "reset derived state when the input changes": it avoids a
  // render pass that would briefly show the previous user's profile.
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const currentUserId = session?.user?.id ?? null;
  if (currentUserId !== profileFor) {
    setProfileFor(currentUserId);
    setProfile(null);
  }

  // A crash report carries the account id and nothing else about who it is —
  // enough to tell one person hitting a bug fifty times from fifty people.
  useEffect(() => {
    identifyForReporting(currentUserId);
  }, [currentUserId]);

  // Silent, and only when permission already exists — a push token can change
  // on its own (a restore, a reinstall), and a stale one is somebody who
  // quietly stops hearing from us. Asking for permission happens on the
  // notifications screen, never here.
  useEffect(() => {
    if (!currentUserId) return;
    void refreshPushToken();
  }, [currentUserId]);

  useEffect(() => {
    if (!session?.user) return;
    let active = true;
    void (async () => {
      // The profile row is created by a trigger on auth.users, so it may land a
      // beat after the session does on a brand-new account.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data } = await backend
          .from('profiles')
          .select(
            'id, display_name, avatar_url, default_vpa, payment_rail, payment_handle, country_code, address, default_currency, locale',
          )
          .eq('id', session.user.id)
          .maybeSingle();
        if (!active) return;
        if (data) {
          setProfile(data as Profile);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    })();
    return () => {
      active = false;
    };
  }, [session?.user]);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profile,
      loading,
      isGuest: session?.user?.is_anonymous === true,

      async sendOtp(phone) {
        const { error } = await backend.auth.signInWithOtp({ phone });
        if (error) throw error;
      },

      async verifyOtp(phone, token) {
        const { error } = await backend.auth.verifyOtp({ phone, token, type: 'sms' });
        if (error) throw error;
      },

      async sendEmailOtp(email, createUser) {
        // A one-time code mailed to the address, the passwordless way in. On the
        // login door `shouldCreateUser` is false so a typo cannot silently mint
        // a new empty account; on sign-up it is true so the code both makes the
        // account and lands the session. Supabase mails a six-digit code (not a
        // magic link) as long as the email template carries `{{ .Token }}`.
        const { error } = await backend.auth.signInWithOtp({
          email: email.trim(),
          options: { shouldCreateUser: createUser },
        });
        if (error) throw error;
      },

      async verifyEmailOtp(email, token) {
        const { error } = await backend.auth.verifyOtp({
          email: email.trim(),
          token: token.trim(),
          type: 'email',
        });
        if (error) throw error;
      },

      async continueAsGuest() {
        const { error } = await backend.auth.signInAnonymously();
        if (error) throw error;
      },

      async withPassword(identifier, password, intent) {
        const who = readIdentifier(identifier);
        checkPassword(password);
        const method = who.kind === 'email' ? AuthMethod.EmailPassword : AuthMethod.PhonePassword;
        const credential = who.kind === 'email' ? { email: who.value } : { phone: who.value };
        const action = planAuth(viewerFrom(session), method, intent);

        if (action.call === 'updateUser') {
          // The upgrade. Same user id, so the groups, the expenses and the
          // money owed all stay where they are (ADR-006).
          const { error } = await backend.auth.updateUser({ ...credential, password });
          if (error) throw error;
          const { data } = await backend.auth.getSession();
          setSession(data.session);
          return {};
        }

        const result =
          action.call === 'signUp'
            ? await backend.auth.signUp({ ...credential, password })
            : await backend.auth.signInWithPassword({ ...credential, password });
        if (result.error) throw result.error;

        // A fresh email account, with confirmations turned on, comes back with
        // a user but no session — the link in the inbox is what mints it. Say
        // so, so the screen can send them to check their mail rather than sit on
        // a form that looks like it did nothing.
        if (action.call === 'signUp' && who.kind === 'email' && !result.data.session) {
          return { verifyEmail: who.value };
        }
        return {};
      },

      async withGoogle() {
        const action = planAuth(viewerFrom(session), AuthMethod.Google);
        const next = await oauthThroughBrowser(OAuthMethod.Google, action.call === 'linkIdentity');
        if (next !== undefined) setSession(next);
      },

      async withApple() {
        const action = planAuth(viewerFrom(session), AuthMethod.Apple);
        // The native id-token flow is a fresh sign-in only: Supabase has no
        // id-token form of linkIdentity, so a guest upgrading (the ADR-006
        // common path) still goes through the browser, exactly like Google.
        if (Platform.OS === 'ios' && action.call === 'signInWithOAuth') {
          const apple = loadAppleAuth();
          if (apple) {
            const credential = await appleNativeCredential(apple);
            if (credential === undefined) return; // sheet dismissed
            const { data, error } = await backend.auth.signInWithIdToken({
              provider: 'apple',
              token: credential.identityToken,
              nonce: credential.nonce,
            });
            if (error) throw error;
            // Apple hands over the name only on the first authorization; seed
            // the profile with it before it is gone for good.
            const name = appleFullName(credential.fullName);
            if (name && data.user) {
              await persistAppleName(data.user.id, name);
            }
            setSession(data.session);
            return;
          }
          // No native module in this build — fall through to the browser.
        }
        const next = await oauthThroughBrowser(OAuthMethod.Apple, action.call === 'linkIdentity');
        if (next !== undefined) setSession(next);
      },

      async updateProfile(patch) {
        if (!session?.user) throw new Error('Not signed in');
        const { data, error } = await backend
          .from('profiles')
          .update(patch)
          .eq('id', session.user.id)
          .select(
            'id, display_name, avatar_url, default_vpa, payment_rail, payment_handle, country_code, address, default_currency, locale',
          )
          .single();
        if (error) throw error;
        setProfile(data as Profile);
      },

      async refresh() {
        const { data } = await backend.auth.getSession();
        setSession(data.session);
      },

      async signOut() {
        // Before the session goes: afterwards there is no identity to attach
        // the revocation to, and the token would keep receiving notifications
        // for an account nobody is signed in on.
        await revokePushToken();
        await backend.auth.signOut();
      },
    }),
    [session, profile, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
