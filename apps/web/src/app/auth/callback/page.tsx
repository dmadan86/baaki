'use client';

/**
 * Where Google sends the browser back.
 *
 * The client is configured not to read the URL on its own
 * (`detectSessionInUrl: false` in lib/baaki.ts) so this is the one place a
 * code is exchanged for a session — deliberately explicit, so an invite link
 * carrying its own token is never mistaken for a login. Once the session is
 * written, `onAuthChange` in the AuthProvider re-renders the app and we send
 * the person to the dashboard.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { supabase } from '@/lib/baaki';
import { useStrings } from '@/i18n-context';

export default function AuthCallback() {
  const router = useRouter();
  const { t } = useStrings();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const code = new URLSearchParams(window.location.search).get('code');
        if (!code) throw new Error('Missing authorization code');
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError) throw exchangeError;
        router.replace('/');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [router]);

  return (
    <div className="spinner-page">
      {error ? <p className="error">{error}</p> : <p>{t.dash.signingIn}</p>}
    </div>
  );
}
