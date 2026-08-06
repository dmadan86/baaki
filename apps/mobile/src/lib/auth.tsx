import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import { checkPassword, planAuth, readIdentifier, type Viewer } from '@baaki/core';

import { supabase } from './supabase';

/**
 * What @baaki/core needs to know to pick the right call. The distinction that
 * matters is anonymous-with-data versus nobody: they look the same to a screen
 * and could not be more different to the person holding the phone.
 */
function viewerFrom(session: Session | null): Viewer {
  if (!session?.user) return { kind: 'nobody' };
  return session.user.is_anonymous === true
    ? { kind: 'guest', userId: session.user.id }
    : { kind: 'user', userId: session.user.id };
}

export interface Profile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  default_vpa: string | null;
  default_currency: string;
  locale: string;
}

interface AuthValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** ADR-006: a guest can use the app before deciding to be a user. */
  isGuest: boolean;
  sendOtp: (phone: string) => Promise<void>;
  verifyOtp: (phone: string, token: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  /**
   * Email or phone plus a password. Which Supabase call this makes is decided
   * by `planAuth` in @baaki/core, not here — a guest must be upgraded in place
   * (ADR-006), and getting that wrong strands their groups on an account they
   * can no longer reach.
   */
  withPassword: (
    identifier: string,
    password: string,
    intent: 'sign_in' | 'sign_up',
  ) => Promise<void>;
  /** Google. Links to the current account when there is one, for the same reason. */
  withGoogle: () => Promise<void>;
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

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
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

  useEffect(() => {
    if (!session?.user) return;
    let active = true;
    void (async () => {
      // The profile row is created by a trigger on auth.users, so it may land a
      // beat after the session does on a brand-new account.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data } = await supabase
          .from('profiles')
          .select('id, display_name, avatar_url, default_vpa, default_currency, locale')
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
        const { error } = await supabase.auth.signInWithOtp({ phone });
        if (error) throw error;
      },

      async verifyOtp(phone, token) {
        const { error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });
        if (error) throw error;
      },

      async continueAsGuest() {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) throw error;
      },

      async withPassword(identifier, password, intent) {
        const who = readIdentifier(identifier);
        checkPassword(password);
        const method = who.kind === 'email' ? 'email_password' : 'phone_password';
        const credential = who.kind === 'email' ? { email: who.value } : { phone: who.value };
        const action = planAuth(viewerFrom(session), method, intent);

        if (action.call === 'updateUser') {
          // The upgrade. Same user id, so the groups, the expenses and the
          // money owed all stay where they are (ADR-006).
          const { error } = await supabase.auth.updateUser({ ...credential, password });
          if (error) throw error;
          const { data } = await supabase.auth.getSession();
          setSession(data.session);
          return;
        }

        const { error } =
          action.call === 'signUp'
            ? await supabase.auth.signUp({ ...credential, password })
            : await supabase.auth.signInWithPassword({ ...credential, password });
        if (error) throw error;
      },

      async withGoogle() {
        const action = planAuth(viewerFrom(session), 'google');
        const redirectTo = makeRedirectUri({ scheme: 'baaki', path: 'auth' });

        // Both calls return a URL rather than opening it: the browser has to be
        // the in-app one, or the session comes back to a tab the app cannot see.
        const { data, error } =
          action.call === 'linkIdentity'
            ? await supabase.auth.linkIdentity({
                provider: 'google',
                options: { redirectTo, skipBrowserRedirect: true },
              })
            : await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo, skipBrowserRedirect: true },
              });
        if (error) throw error;
        if (!data?.url) throw new Error('Google did not give us a sign-in link');

        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
        if (result.type !== 'success') return;

        // The tokens come back in the URL fragment; nothing else reads them.
        const fragment = result.url.split('#')[1] ?? '';
        const params = new URLSearchParams(fragment);
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        if (!access_token || !refresh_token) {
          // A link, rather than a sign-in, returns no tokens — the session it
          // just added an identity to is the one already held.
          const { data: current } = await supabase.auth.getSession();
          setSession(current.session);
          return;
        }
        const { error: sessionError } = await supabase.auth.setSession({
          access_token,
          refresh_token,
        });
        if (sessionError) throw sessionError;
      },

      async updateProfile(patch) {
        if (!session?.user) throw new Error('Not signed in');
        const { data, error } = await supabase
          .from('profiles')
          .update(patch)
          .eq('id', session.user.id)
          .select('id, display_name, avatar_url, default_vpa, default_currency, locale')
          .single();
        if (error) throw error;
        setProfile(data as Profile);
      },

      async refresh() {
        const { data } = await supabase.auth.getSession();
        setSession(data.session);
      },

      async signOut() {
        await supabase.auth.signOut();
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
