'use client';

/**
 * The door for a real user: Google, an email-and-password account, or a
 * passwordless email link (ADR-006 names them). A guest with an invite link
 * does not come through here at all — they open the link and the anonymous
 * session is minted for them.
 *
 * Which Supabase call the password form makes — sign up, sign in, or upgrade a
 * guest in place — is decided by @baaki/core inside the client, never guessed
 * here (see `withPassword`).
 */

import { useState } from 'react';

import { useAuth } from '@/lib/auth';
import { fill } from '@/i18n';
import { useStrings } from '@/i18n-context';

export function SignIn() {
  const { t } = useStrings();
  const { signInWithGoogle, signInWithEmail, withPassword } = useAuth();
  const [busy, setBusy] = useState<null | 'google' | 'password' | 'link'>(null);
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  // A local check only, to catch the obvious typo before the round trip; the
  // real validation is the server's.
  function looksLikeEmail(address: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  }

  async function onPassword(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setError(t.dash.notAnEmail);
      return;
    }
    setBusy('password');
    setError(null);
    try {
      // The core picks the call; a guest is upgraded in place, keeping groups.
      await withPassword(address, password, mode);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  async function onMagicLink() {
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setError(t.dash.notAnEmail);
      return;
    }
    setBusy('link');
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

            <button
              type="button"
              className="btn google"
              onClick={onGoogle}
              disabled={busy !== null}
            >
              <span aria-hidden>G</span>
              {busy === 'google' ? t.dash.signingIn : t.dash.continueWithGoogle}
            </button>

            <div className="signin-or">{t.dash.orDivider}</div>

            <form onSubmit={onPassword}>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                placeholder={t.dash.emailPlaceholder}
                onChange={(e) => setEmail(e.target.value)}
                aria-label={t.dash.emailPlaceholder}
                style={{ textAlign: 'start' }}
              />
              <input
                type="password"
                autoComplete={mode === 'sign_up' ? 'new-password' : 'current-password'}
                value={password}
                placeholder={t.dash.passwordPlaceholder}
                onChange={(e) => setPassword(e.target.value)}
                aria-label={t.dash.passwordPlaceholder}
                style={{ textAlign: 'start' }}
              />
              <button type="submit" className="btn block" disabled={busy !== null}>
                {busy === 'password'
                  ? t.dash.signingIn
                  : mode === 'sign_up'
                    ? t.dash.passwordSignUp
                    : t.dash.passwordSignIn}
              </button>
            </form>

            <button
              type="button"
              className="linklike"
              onClick={() => {
                setError(null);
                setMode((m) => (m === 'sign_in' ? 'sign_up' : 'sign_in'));
              }}
              disabled={busy !== null}
            >
              {mode === 'sign_in' ? t.dash.toggleToSignUp : t.dash.toggleToSignIn}
            </button>

            <div className="signin-or">{t.dash.orDivider}</div>

            <button
              type="button"
              className="btn soft block"
              onClick={onMagicLink}
              disabled={busy !== null}
            >
              {busy === 'link' ? t.dash.sendingLink : t.dash.sendMagicLink}
            </button>

            {error ? <p className="error">{error}</p> : null}

            <p className="signin-or">{t.dash.guestInstead}</p>
          </>
        )}
      </div>
    </div>
  );
}
