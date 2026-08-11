'use client';

/**
 * The door for a real user: Google, or a passwordless email link (ADR-006
 * names both). A guest with an invite link does not come through here at all —
 * they open the link and the anonymous session is minted for them.
 */

import { useState } from 'react';

import { useAuth } from '@/lib/auth';
import { fill } from '@/i18n';
import { useStrings } from '@/i18n-context';

export function SignIn() {
  const { t } = useStrings();
  const { signInWithGoogle, signInWithEmail } = useAuth();
  const [busy, setBusy] = useState<null | 'google' | 'email'>(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onGoogle() {
    setBusy('google');
    setError(null);
    try {
      await signInWithGoogle(); // navigates away; no return
    } catch (caught) {
      setBusy(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function onEmail(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    // A local check only, to catch the obvious typo before the round trip;
    // the real validation is the server sending (or not) an email.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setError(t.dash.notAnEmail);
      return;
    }
    setBusy('email');
    setError(null);
    try {
      await signInWithEmail(address);
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
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

        {sent ? (
          <>
            <h2 style={{ marginBottom: 8 }}>{t.dash.linkSentTitle}</h2>
            <p>{fill(t.dash.linkSentBody, { email: email.trim() })}</p>
          </>
        ) : (
          <>
            <p>{t.dash.signInBody}</p>

            <button type="button" className="btn google" onClick={onGoogle} disabled={busy !== null}>
              <span aria-hidden>G</span>
              {busy === 'google' ? t.dash.signingIn : t.dash.continueWithGoogle}
            </button>

            <div className="signin-or">{t.dash.orDivider}</div>

            <form onSubmit={onEmail}>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                placeholder={t.dash.emailPlaceholder}
                onChange={(e) => setEmail(e.target.value)}
                aria-label={t.dash.emailPlaceholder}
                style={{ marginBottom: 12, textAlign: 'center' }}
              />
              <button type="submit" className="btn soft block" disabled={busy !== null}>
                {busy === 'email' ? t.dash.sendingLink : t.dash.sendMagicLink}
              </button>
            </form>

            {error ? <p className="error">{error}</p> : null}

            <p className="signin-or">{t.dash.guestInstead}</p>
          </>
        )}
      </div>
    </div>
  );
}
