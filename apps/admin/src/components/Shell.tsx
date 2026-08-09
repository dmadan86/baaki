'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { Sidebar } from './Sidebar';

/**
 * The chrome around every page except the login screen.
 *
 * A Client Component so it can read the path: it both hides itself on `/login`
 * (which has no business behind a signed-in shell) and names the current
 * section in the top bar. The pages it wraps stay Server Components — they are
 * passed in as `children`, rendered on the server, and slotted into the light
 * content column without joining this file's client bundle.
 */

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/users': 'Users',
  '/promotions': 'Promotions',
  '/campaigns': 'Campaigns',
  '/flags': 'Experiments',
  '/rate-limits': 'Rate limits',
  '/feedback': 'Feedback',
};

function titleFor(path: string): string {
  if (TITLES[path]) return TITLES[path];
  const hit = Object.entries(TITLES).find(([href]) => href !== '/' && path.startsWith(href));
  return hit?.[1] ?? 'Admin';
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();

  // The login page renders its own centred card and must not gain a rail.
  if (path === '/login') return <>{children}</>;

  return (
    <div className="shell">
      <Sidebar />
      <div className="content">
        <div className="topbar">
          <div className="crumb">
            Admin <span aria-hidden>›</span> <b>{titleFor(path)}</b>
          </div>
          <span className="pill">Aggregates only · service role</span>
        </div>
        {children}
      </div>
    </div>
  );
}
