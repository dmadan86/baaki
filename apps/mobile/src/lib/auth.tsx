import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@/lib/backend';
import { makeRedirectUri } from 'expo-auth-session';
import * as Linking from 'expo-linking';
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

import { cancelNudges } from './captureNudge/schedule';
import { clearCaptureNudge } from './captureNudge/settings';
import { appleNativeSignIn, googleNativeSignIn } from './nativeIdentity';
import { identifyForReporting, reportHandled } from './observability';
import { claimCode } from './oauthClaim';
import { confirmPhoneCode, sendPhoneCode } from './phoneAuth';
import { lockPersonal, syncPersonalAccount } from './personalLock';
import { refreshPushToken, revokePushToken } from './push';
import { backend } from './backend';
// A leaf module with no imports of its own, reached directly rather than
// through `@/sync` — the sync barrel pulls in `SyncProvider`, which imports
// this file, and that circle is not worth one function.
import { markDeliberateSignOut } from '@/sync/retention';

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
 * Redeem the code in a callback URL, if it has one nobody has claimed yet.
 *
 * `undefined` means there was nothing here to do — no code, or somebody else
 * already took it. That is not a failure and must not be reported as one.
 */
async function claimOAuthCode(url: string | null): Promise<Session | null | undefined> {
  if (!url) return undefined;
  const callback = readOAuthCallback(url);
  if (callback.kind !== 'code' || !claimCode(callback.code)) return undefined;
  const { data, error } = await backend.auth.exchangeCodeForSession(callback.code);
  if (error) throw error;
  return data.session;
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
  const redirectTo = makeRedirectUri({ scheme: 'waves', path: 'auth' });

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
  if (__DEV__) console.log(`[oauth] ${provider} redirectTo=${redirectTo} came back ${result.type}`);
  // Closed the browser, or swiped the tab away. Nothing failed and nothing
  // changed, so the screen stays exactly as they left it.
  if (result.type !== 'success') return undefined;

  // PKCE (`flowType` in lib/supabase.ts): the redirect carries a one-time
  // code, and only this client holds the verifier that redeems it. The refresh
  // token never travels through the URL, so another app that claims the same
  // scheme and catches the redirect gets nothing it can use.
  const callback = readOAuthCallback(result.url);
  if (callback.kind === 'error') throw new Error(callback.message);
  if (callback.kind === 'none') {
    // A redirect that added nothing means two opposite things depending on
    // what was asked for.
    //
    // Linking an identity: nothing is *supposed* to come back. The session the
    // identity was just attached to is the one already held, so return it.
    //
    // Signing in: the whole point of the round trip was to come back with a
    // code, and there isn't one. Returning the current session here — which is
    // null, because nobody was signed in — put somebody back on the sign-in
    // screen with no message, no spinner and no clue, looking exactly like the
    // button did nothing. It has to be an error, even a generic one.
    if (!link) {
      throw new Error(`${provider} sign-in came back without a code`);
    }
    const { data: current } = await backend.auth.getSession();
    return current.session;
  }

  // Through the same claim as the deep-link route, so whichever of the two
  // gets there first is the one that spends the code.
  const claimed = await claimOAuthCode(result.url);
  if (claimed !== undefined) return claimed;
  // Somebody else already redeemed it — the link handler, most likely, on an
  // app that was restarted mid-sign-in. Their session is the one to keep.
  const { data: current } = await backend.auth.getSession();
  return current.session;
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
 * Every column a screen reads off the signed-in person. One list, because the
 * initial load, the self-heal re-read and `updateProfile` must all come back
 * shaped the same — a `Profile` assembled from three different column sets is
 * three subtly different objects.
 */
const PROFILE_COLUMNS =
  'id, display_name, avatar_url, default_vpa, payment_rail, payment_handle, country_code, address, default_currency, locale';

/** The name an OAuth provider sent, under whichever key it chose. */
function metadataName(user: Session['user']): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ['display_name', 'full_name', 'name'] as const) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** The photo an OAuth provider sent, under whichever key it chose. */
function metadataAvatar(user: Session['user']): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ['avatar_url', 'picture'] as const) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** The locale a provider sent, when it sent one. */
function metadataLocale(user: Session['user']): string | null {
  const value = (user.user_metadata ?? {})['locale'] as unknown;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Read this account's profile row, and make one if the database never did.
 *
 * The row is normally written by a trigger on `auth.users`, which can land a
 * beat after the session on a brand-new account — hence the short retry.
 *
 * The retry used to be the whole story, and that was the bug: when the row was
 * *absent* rather than late, this gave up after a second or two and left
 * `profile` null forever. Nothing retried it, nothing reported it, and every
 * screen that waits on a profile waited for good — the settings tab sat on its
 * skeleton and the dashboard showed initials for a name it did not have. That
 * is exactly what happened when the rebuilt project lost the trigger.
 *
 * So the absent case is now handled rather than waited out: `profiles_insert_self`
 * lets somebody create their own row, so the client writes the same row the
 * trigger would have, from the metadata the provider sent. Both paths converge
 * on one re-read, so what lands in state came from the database either way.
 *
 * Returns true when a profile was handed to `set`, false when it gave up — the
 * caller shows an error with a retry rather than an endless skeleton.
 */
async function loadProfile(
  user: Session['user'],
  set: (profile: Profile) => void,
): Promise<boolean> {
  const read = async (): Promise<Profile | null> => {
    const { data, error } = await backend
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', user.id)
      .maybeSingle();
    // A refused or failed read is not "no profile" — it must not lead to an
    // insert that would then collide with a row that is already there.
    if (error) throw new Error(error.message);
    return (data as Profile | null) ?? null;
  };

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const found = await read();
      if (found) {
        set(found);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }

    // Still nothing: the trigger is not going to write it. Write it here.
    // The same three columns the trigger writes, read the same way — a profile
    // must not depend on which of the three paths happened to create it.
    const { error: insertError } = await backend.from('profiles').insert({
      id: user.id,
      // ADR-006: anonymous guests get an account too, just an unnamed one.
      display_name: metadataName(user) ?? 'Guest',
      avatar_url: metadataAvatar(user),
      locale: metadataLocale(user) ?? 'en',
    });
    // A conflict means the trigger won the race after all — the re-read below
    // picks up its row, so this is a success, not a failure.
    if (insertError && insertError.code !== '23505') throw new Error(insertError.message);

    const healed = await read();
    if (healed) {
      set(healed);
      return true;
    }
    reportHandled(new Error('profile row missing after self-heal'), 'auth.loadProfile');
    return false;
  } catch (caught) {
    reportHandled(caught, 'auth.loadProfile');
    return false;
  }
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
  /**
   * The profile load has finished without a profile — it is not coming on its
   * own. Screens that need one show an error with a retry on this rather than
   * holding a skeleton for ever; `profile === null && !profileSettled` is the
   * honest "still loading".
   */
  profileSettled: boolean;
  /** Run the profile load again, for the retry that error offers. */
  reloadProfile: () => void;
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
  /**
   * Google. The phone's own sheet for a fresh sign-in, the browser when this
   * build or device cannot present one — and always the browser for a link,
   * because linking an identity has no id-token form.
   */
  withGoogle: () => Promise<void>;
  /** Apple. The same three cases, through the same seam (`lib/nativeIdentity`). */
  withApple: () => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => Promise<void>;
  /** Re-read the session after it changes underneath us (e.g. a linked email). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // The profile, and the settled flag, are stored *with the account they belong
  // to* rather than on their own.
  //
  // The load is asynchronous and takes seconds. Clearing state during render
  // when the account changes is not enough to make a late write safe: passive
  // effects run after the commit, so between the render that switches to
  // account B and the cleanup that stops account A's effect there is a window
  // where A's callback still fires — and it would put A's name and face on
  // screen for B. Guarding the *write* with a flag closes it only if the flag
  // is already false, which in that window it is not.
  //
  // Owning the id makes the question structural instead of a matter of timing:
  // a value written for A is simply not read while B is signed in, whenever it
  // lands. `loadProfile` selects by id, so `owner` is exactly whose row it is.
  const [profileState, setProfileState] = useState<{
    owner: string | null;
    profile: Profile | null;
    settled: boolean;
  }>({ owner: null, profile: null, settled: false });
  const [profileAttempt, setProfileAttempt] = useState(0);

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
        syncPersonalAccount(data.session?.user?.id ?? null);
        setSession(data.session);
      })
      .catch((caught) => {
        reportHandled(caught, 'auth.getSession');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const { data: subscription } = backend.auth.onAuthStateChange((_event, next) => {
      // Whoever proved they were holding this phone proved it for one account.
      // Most sign-outs never reach the `signOut` action below — a revoked
      // refresh token, a remote sign-out from another device, an account
      // deleted elsewhere, a refresh that simply fails — and the personal
      // ledger's unlock is module-scoped, so it would outlive the unmounted
      // tree and greet the next account with no check at all. Keyed on the user
      // id, so a switch of account counts too and a token refresh does not.
      syncPersonalAccount(next?.user?.id ?? null);
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
  const currentUserId = session?.user?.id ?? null;
  // Reading through the owner is what resets it: a profile belonging to anybody
  // but the account signed in right now is not this account's profile. No
  // render-time clear, and nothing to go stale.
  const profile = profileState.owner === currentUserId ? profileState.profile : null;
  const profileSettled = profileState.owner === currentUserId && profileState.settled;

  /**
   * Finish a sign-in that outlived the process which started it.
   *
   * `oauthThroughBrowser` awaits the browser and redeems the code itself, and
   * that is the normal path. It only works while this process is alive — and
   * on a phone it frequently is not: Android is free to kill a backgrounded
   * app, and while Chrome is in front showing a consent screen, Waves is a
   * backgrounded app. Several OEM builds do it eagerly. When that happens the
   * awaiting promise dies with the process, `waves://auth?code=…` arrives at a
   * cold start with nobody listening, and somebody who really did sign in with
   * Google lands back on the welcome screen. The screen recording that found
   * this shows it plainly: the splash plays a second time, then the door.
   *
   * The verifier is in the keystore, not in memory, so the fresh process can
   * still redeem the code — it just has to notice it. This is the noticing:
   * the launch URL, and every link that arrives afterwards.
   */
  useEffect(() => {
    let active = true;

    const finish = (url: string | null): void => {
      void claimOAuthCode(url)
        .then((next) => {
          if (active && next) setSession(next);
        })
        .catch((caught) => {
          // An expired or already-spent code is the ordinary shape of a
          // duplicate delivery, not something to put on screen.
          reportHandled(caught, 'auth.linkCallback');
        });
    };

    void Linking.getInitialURL()
      .then(finish)
      .catch(() => undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => finish(url));

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

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
    const user = session.user;
    let active = true;
    // `profileSettled` is already false here — reset during render when the
    // account changes, and by `reloadProfile` on a retry — so this effect only
    // ever has to record the giving-up, never the starting.
    void (async () => {
      const loaded = await loadProfile(user, (next) => {
        if (active) setProfileState({ owner: user.id, profile: next, settled: false });
      });
      if (active && !loaded) {
        setProfileState((current) =>
          current.owner === user.id
            ? { ...current, settled: true }
            : { owner: user.id, profile: null, settled: true },
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [session?.user, profileAttempt]);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profile,
      loading,
      profileSettled,
      reloadProfile: () => {
        setProfileState((current) => ({ ...current, settled: false }));
        setProfileAttempt((n) => n + 1);
      },
      isGuest: session?.user?.is_anonymous === true,

      // Firebase sends the code, not Supabase — the only way to deliver an SMS
      // worldwide without a registered company, a DLT filing per country and a
      // monthly bill. What it proves is the number; `phone-verify` turns that
      // proof into a session. See `lib/phoneAuth` for why the module is loaded
      // lazily, and the `phone-verify` handler for why a session cannot simply
      // be minted from a Firebase token.
      //
      // ADR-006 is enforced where it always was, on the server: that function
      // asks GoTrue with `create_user: false`, so a number nobody owns is a
      // refusal rather than a new account. Firebase having verified a number
      // does not make it one.
      async sendOtp(phone) {
        await sendPhoneCode(phone);
      },

      async verifyOtp(phone, token) {
        await confirmPhoneCode(phone, token);
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
        // Native first, and only for a fresh sign-in: Supabase has no id-token
        // form of `linkIdentity`, so a guest upgrading (the ADR-006 common
        // path) has to go out through the browser however good the sheet is.
        if (action.call === 'signInWithOAuth') {
          const outcome = await googleNativeSignIn();
          if (outcome.kind === 'dismissed') return;
          if (outcome.kind === 'credential') {
            const { data, error } = await backend.auth.signInWithIdToken({
              provider: 'google',
              token: outcome.credential.idToken,
            });
            if (error) throw error;
            setSession(data.session);
            return;
          }
          // `unavailable`: no module, no Play services, no OAuth client for
          // this build's signature. The browser flow below is what this phone
          // can still do, so it runs — the person sees a sign-in, not a fault.
        }
        const next = await oauthThroughBrowser(OAuthMethod.Google, action.call === 'linkIdentity');
        if (next !== undefined) setSession(next);
      },

      async withApple() {
        const action = planAuth(viewerFrom(session), AuthMethod.Apple);
        // Same shape as Google, and the same reason for the same limit: this is
        // a fresh sign-in only, and everything else falls through.
        if (action.call === 'signInWithOAuth') {
          const outcome = await appleNativeSignIn();
          if (outcome.kind === 'dismissed') return;
          if (outcome.kind === 'credential') {
            const { data, error } = await backend.auth.signInWithIdToken({
              provider: 'apple',
              token: outcome.credential.identityToken,
              nonce: outcome.credential.nonce,
            });
            if (error) throw error;
            // Apple hands over the name only on the first authorization; seed
            // the profile with it before it is gone for good.
            const name = appleFullName(outcome.credential.fullName);
            if (name && data.user) {
              await persistAppleName(data.user.id, name);
            }
            setSession(data.session);
            return;
          }
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
        setProfileState({ owner: session.user.id, profile: data as Profile, settled: false });
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
        // And the reminders this phone set for itself. A local alarm survives
        // the session that created it, so leaving one scheduled means a phone
        // nobody is signed in on announcing "you saved 3 expenses for later" —
        // about drafts that are no longer on it. The stored switch and the
        // marker go with it, scoped to the account that is leaving.
        const leaving = session?.user?.id ?? '';
        await cancelNudges().catch(() => {});
        await clearCaptureNudge(leaving).catch(() => {});
        // The private ledger's unlock belongs to whoever proved they were
        // holding the phone, not to the phone. It does not survive the account
        // it was granted under.
        lockPersonal();
        // The one bit `SyncProvider` cannot work out for itself. Every way a
        // session ends arrives at `onAuthStateChange` as the same `SIGNED_OUT`
        // with the same null session — a revoked token looks exactly like this
        // — and only one of them earns the wipe that destroys the unsent queue.
        // Marked here, immediately before the call, so the window in which it
        // could be mistaken for a later involuntary loss is as narrow as the
        // call itself. See `sync/retention.ts`.
        markDeliberateSignOut();
        await backend.auth.signOut();
      },
    }),
    [session, profile, loading, profileSettled],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/**
 * Who the person holding the phone is, for the purpose of finding themselves in
 * a group's member list.
 *
 * This is `session.user.id`, deliberately, and not `profile.id`. They are the
 * same id by construction — `loadProfile` selects the profile row whose id *is*
 * the session user's — but they do not arrive together:
 *
 *   * The **session** is restored from secure storage during launch. No
 *     network. It is there on the first frame, offline included.
 *   * The **profile** is a fetch with up to five retries. On mobile data it
 *     lands a second or more later; with no signal it may not land at all.
 *
 * Taking identity from the profile therefore made a network round trip a
 * prerequisite for answering a question the device could already answer, which
 * is the opposite of what ADR-005 asks of every other surface. And the gap had
 * a *wrong* answer in it rather than an empty one: with `profile?.id`
 * undefined, `member.profile_id === profile?.id` matches the first ghost in the
 * group — a ghost being exactly a member with no profile id — so screens
 * computed balances, payers and shares from somebody else's point of view and
 * rendered them with complete confidence. The dashboard showed a −₹82,001 that
 * was really a +₹112,807.
 *
 * So identity comes from here, and the comparison goes through
 * `data/types.isViewer`, which matches nothing at all when there is no viewer.
 * The **profile** remains the right source for what a profile actually holds —
 * a display name, an avatar, a default currency — and a name that arrives a
 * beat late is not a wrong name.
 */
export function useViewerId(): string | null {
  return useAuth().session?.user?.id ?? null;
}
