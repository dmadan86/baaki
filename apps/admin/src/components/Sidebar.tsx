'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The dark rail. A Client Component only because the active link is decided
 * from the current path (`usePathname`) rather than threaded through every page
 * as a `here` prop — which is what the old row-of-links `Nav` did, and what let
 * a page forget to say where it was.
 */

type Item = { href: string; label: string; icon: ReactNode };
type Section = { heading: string; items: Item[] };

// Stroke icons inline, for the same reason the charts were hand-drawn before a
// library was allowed in: an icon set is a dependency that renders a few paths.
const I = {
  overview: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 19" />
    </svg>
  ),
  flags: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M9 3v7l-3.5 6.5A2 2 0 0 0 7.3 20h9.4a2 2 0 0 0 1.8-3L15 10V3" />
      <path d="M7.5 3h9" />
    </svg>
  ),
  gauge: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 15a8 8 0 0 1 16 0" />
      <path d="M12 15l4-3.5" />
      <circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  ),
  tag: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 4h7l9 9-7 7-9-9V4z" />
      <circle cx="8.5" cy="8.5" r="1.4" />
    </svg>
  ),
  megaphone: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 9v6h4l9 5V4L8 9H4z" />
      <path d="M19 9a3.5 3.5 0 0 1 0 6" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 5h16v11H9l-5 4V5z" />
    </svg>
  ),
};

const SECTIONS: Section[] = [
  { heading: 'Overview', items: [{ href: '/', label: 'Dashboard', icon: I.overview }] },
  { heading: 'People', items: [{ href: '/users', label: 'Users', icon: I.users }] },
  {
    heading: 'Growth',
    items: [
      { href: '/promotions', label: 'Promotions', icon: I.tag },
      { href: '/campaigns', label: 'Campaigns', icon: I.megaphone },
    ],
  },
  {
    heading: 'Config',
    items: [
      { href: '/flags', label: 'Experiments', icon: I.flags },
      { href: '/config', label: 'Limits', icon: I.gauge },
      { href: '/rate-limits', label: 'Rate limits', icon: I.gauge },
    ],
  },
  { heading: 'Voice', items: [{ href: '/feedback', label: 'Feedback', icon: I.chat }] },
];

export function Sidebar() {
  const path = usePathname();

  return (
    <nav className="sidebar" aria-label="Sections">
      <div className="brand">
        <span className="mark">B</span>
        <span>Baaki</span>
      </div>
      {SECTIONS.map((section) => (
        <div key={section.heading}>
          <div className="side-group">{section.heading}</div>
          {section.items.map((item) => {
            const active = item.href === '/' ? path === '/' : path.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="side-link"
                aria-current={active ? 'page' : undefined}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
