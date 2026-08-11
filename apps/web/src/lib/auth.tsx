'use client';

/**
 * Who is looking at the page.
 *
 * One source of truth for the session, shared by the shell, the sign-in
 * screen and every data page. The session is read once and then kept live by
 * `onAuthChange`, so signing in on the callback route or out from the avatar
 * menu re-renders the whole app without a reload.
 *
 * `isGuest` is the ceiling that matters (ADR-006): a bare anonymous session
 * may read everything it joined but its writes are gated. The UI reads this to
 * decide whether to prompt the upgrade; the server enforces it regardless.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';

import { baaki } from '@/lib/baaki';

interface AuthValue {
  session: Session | null;
  profileId: string | null;
  isGuest: boolean;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void baaki.session().then((next) => {
      if (!active) return;
      setSession(next);
      setLoading(false);
    });
    const unsubscribe = baaki.onAuthChange((next) => {
      setSession(next);
      setLoading(false);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    // Back to the callback route with the code in the URL; it finishes there.
    await baaki.signInWithGoogle(`${window.location.origin}/auth/callback`);
  }, []);

  const signOut = useCallback(async () => {
    await baaki.signOut();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profileId: session?.user.id ?? null,
      isGuest: session?.user.is_anonymous === true,
      loading,
      signInWithGoogle,
      signOut,
    }),
    [session, loading, signInWithGoogle, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
