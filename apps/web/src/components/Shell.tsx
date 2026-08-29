'use client';

/**
 * The frame every signed-in page sits in — reworked into the developer-portal
 * shape (Port): a dark left rail that carries the brand, the navigation, and the
 * account, against a light canvas where the widgets live. The top bar holds the
 * page's name and the global search.
 *
 * Phases 1–3 filled every destination in; each rail item is a real route.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';

import { useStrings } from '@/i18n-context';

export enum Section {
  Overview = 'overview',
  Groups = 'groups',
  Activity = 'activity',
  Friends = 'friends',
  Settle = 'settle',
}

export function Shell({
  current,
  query,
  onQuery,
  userName,
  avatarUrl,
  isGuest,
  onSignOut,
  children,
}: {
  current: Section;
  query: string;
  onQuery: (value: string) => void;
  userName: string;
  avatarUrl: string | null;
  isGuest: boolean;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const { t } = useStrings();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  // A group page reports `current: 'groups'`, but there is no separate Groups
  // destination in the rail — the groups live on the overview — so it lights the
  // overview item rather than nothing.
  const activeKey: Section = current === Section.Groups ? Section.Overview : current;

  const nav: { key: Section; label: string; href: string; icon: string }[] = [
    { key: Section.Overview, label: t.dash.nav.overview, href: '/', icon: '▤' },
    { key: Section.Activity, label: t.dash.nav.activity, href: '/activity', icon: '📈' },
    { key: Section.Friends, label: t.dash.nav.friends, href: '/friends', icon: '🙂' },
    { key: Section.Settle, label: t.dash.nav.settle, href: '/settle', icon: '⇄' },
  ];

  const pageTitle = nav.find((item) => item.key === activeKey)?.label ?? t.dash.nav.overview;
  const initial = userName.trim().charAt(0).toUpperCase() || '🙂';

  return (
    <div className="app">
      <div className="app-shell">
        <aside className="sidebar">
          <div className="side-brand">
            <span className="brand-mark" aria-hidden>
              ₹
            </span>
            Waves
          </div>

          <nav className="side-nav">
            {nav.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className="side-link"
                aria-current={item.key === activeKey}
              >
                <span className="side-ico" aria-hidden>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            ))}
          </nav>

          <div ref={menuRef} className="side-foot">
            {menuOpen ? (
              <div role="menu" className="side-menu">
                <button
                  type="button"
                  className="side-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onSignOut();
                  }}
                >
                  {t.dash.signOut}
                </button>
              </div>
            ) : null}

            <button
              type="button"
              className="side-account"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="avatar" aria-hidden>
                {avatarUrl ? (
                  // Google's avatar CDN, a small round photo — next/image would
                  // need every provider host allow-listed to render one <img>.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" />
                ) : (
                  initial
                )}
              </span>
              <span className="grow">
                <span className="side-account-name">{userName}</span>
                {isGuest ? <span className="side-account-role">{t.dash.guestLabel}</span> : null}
              </span>
              <span className="side-account-caret" aria-hidden>
                ⋯
              </span>
            </button>
          </div>
        </aside>

        <div className="main-col">
          <header className="topbar">
            <h1 className="topbar-title">{pageTitle}</h1>
            {/* The one action a split app is for, present on every page — no
                need to open a group first to reach it (the picker at /add does
                that). This is the loudest thing in the bar on purpose. */}
            <Link href="/add" className="btn topbar-add">
              <span aria-hidden>＋</span>
              <span className="topbar-add-label">{t.dash.addExpense}</span>
            </Link>
            <label className="search">
              <span aria-hidden>🔍</span>
              <input
                type="search"
                value={query}
                placeholder={t.dash.searchPlaceholder}
                onChange={(event) => onQuery(event.target.value)}
                aria-label={t.dash.searchPlaceholder}
              />
            </label>
          </header>

          {children}
        </div>
      </div>
    </div>
  );
}
