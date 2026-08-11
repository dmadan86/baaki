'use client';

/**
 * The frame every signed-in page shares.
 *
 * One place decides the three states — loading, no session, in — so the
 * dashboard and a group page cannot disagree about who is looking or draw the
 * shell two different ways. A page renders its body through the child function,
 * which is handed the reader's profile id and the current search text.
 */

import { useState, type ReactNode } from 'react';

import { useAccount, useAuth } from '@/lib/auth';
import { useStrings } from '@/i18n-context';
import { Shell, type Section } from '@/components/Shell';
import { SignIn } from '@/components/SignIn';

export function AppFrame({
  current,
  children,
}: {
  current: Section;
  children: (ctx: { profileId: string; query: string }) => ReactNode;
}) {
  const { t } = useStrings();
  const { session, profileId, isGuest, loading, signOut } = useAuth();
  const { userName, avatarUrl } = useAccount(t.dash.guestLabel);
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

  return (
    <Shell
      current={current}
      query={query}
      onQuery={setQuery}
      userName={userName}
      avatarUrl={avatarUrl}
      isGuest={isGuest}
      onSignOut={signOut}
    >
      {isGuest ? <GuestBanner /> : null}
      {children({ profileId, query })}
    </Shell>
  );
}

function GuestBanner() {
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
          {t.dash.guestCta}
        </button>
      </div>
    </div>
  );
}
