'use client';

/**
 * The front door.
 *
 * No session — a real login (Google) or an invite link to open. A session,
 * guest or full — the dashboard. A guest who opened an invite link lands here
 * too: they have an anonymous session, so they see the one group they joined,
 * with the writes their ten-day / one-group ceiling allows (ADR-006). The
 * upgrade prompt is the shell's job, not a gate on reading.
 */

import { useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useStrings } from '@/i18n-context';
import { Shell } from '@/components/Shell';
import { SignIn } from '@/components/SignIn';
import { Overview } from '@/components/Overview';

export default function Home() {
  const { t } = useStrings();
  const { session, profileId, isGuest, loading, signOut } = useAuth();
  const [query, setQuery] = useState('');

  if (loading) {
    return (
      <div className="spinner-page">
        <p>{t.dash.loading}</p>
      </div>
    );
  }

  if (!session || !profileId) {
    return <SignIn />;
  }

  const meta = session.user.user_metadata ?? {};
  const userName =
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    (typeof session.user.email === 'string' && session.user.email) ||
    (isGuest ? t.dash.guestLabel : 'You');
  const avatarUrl =
    (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
    (typeof meta.picture === 'string' && meta.picture) ||
    null;

  return (
    <Shell
      current="overview"
      query={query}
      onQuery={setQuery}
      userName={userName}
      avatarUrl={avatarUrl}
      isGuest={isGuest}
      onSignOut={signOut}
    >
      {isGuest ? <GuestBanner cta={t.dash.guestCta} /> : null}
      <Overview profileId={profileId} query={query} />
    </Shell>
  );
}

function GuestBanner({ cta }: { cta: string }) {
  const { t } = useStrings();
  const { signInWithGoogle } = useAuth();
  return (
    <div style={{ padding: '18px 24px 0' }}>
      <div className="banner">
        <span className="tile-emoji" aria-hidden>
          ✨
        </span>
        <span className="grow">
          <span className="b-title">{t.dash.guestTitle}</span>
          <span className="b-body"> {t.dash.guestBody}</span>
        </span>
        <button type="button" className="btn" onClick={() => void signInWithGoogle()}>
          {cta}
        </button>
      </div>
    </div>
  );
}
