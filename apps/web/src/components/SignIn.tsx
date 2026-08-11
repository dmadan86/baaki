'use client';

/**
 * The door for a real user. Google only in Phase 1 (ADR-006 names it); a guest
 * with an invite link does not come through here at all — they open the link
 * and the anonymous session is minted for them.
 */

import { useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useStrings } from '@/i18n-context';

export function SignIn() {
  const { t } = useStrings();
  const { signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onGoogle() {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle(); // navigates away; no return
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="signin-wrap">
      <div className="signin-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ₹
          </span>
          {t.dash.signInTitle}
        </div>
        <p>{t.dash.signInBody}</p>

        <button type="button" className="btn google" onClick={onGoogle} disabled={busy}>
          <span aria-hidden>G</span>
          {busy ? t.dash.signingIn : t.dash.continueWithGoogle}
        </button>

        {error ? <p className="error">{error}</p> : null}

        <p className="signin-or">{t.dash.guestInstead}</p>
      </div>
    </div>
  );
}
