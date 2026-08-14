'use client';

/**
 * The front door.
 *
 * No session — a real login (Google or email) or an invite link to open. A
 * session, guest or full — the Overview dashboard. A guest who opened an invite
 * link lands here too: they have an anonymous session, so they see the one
 * group they joined, with the writes their ten-day / one-group ceiling allows
 * (ADR-006). Auth-routing and the shell live in AppFrame now.
 */

import { AppFrame } from '@/components/AppFrame';
import { Section } from '@/components/Shell';
import { Overview } from '@/components/Overview';

export default function Home() {
  return (
    <AppFrame current={Section.Overview}>
      {({ profileId, query }) => <Overview profileId={profileId} query={query} />}
    </AppFrame>
  );
}
