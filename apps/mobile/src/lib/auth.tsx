import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';

import { supabase } from './supabase';

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
  updateProfile: (patch: Partial<Profile>) => Promise<void>;
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
