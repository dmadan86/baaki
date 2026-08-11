'use client';

/**
 * The frame every signed-in page sits in: brand, the section tabs, search, and
 * the account menu. Only Overview is built in Phase 1 — the other tabs are
 * shown but inert, so the shape is right and the later phases have somewhere to
 * land (PLAN.md).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useStrings } from '@/i18n-context';

export type Section = 'overview' | 'groups' | 'activity' | 'friends' | 'settle';

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

  const tabs: { key: Section; label: string }[] = [
    { key: 'overview', label: t.dash.nav.overview },
    { key: 'groups', label: t.dash.nav.groups },
    { key: 'activity', label: t.dash.nav.activity },
    { key: 'friends', label: t.dash.nav.friends },
    { key: 'settle', label: t.dash.nav.settle },
  ];

  const initial = userName.trim().charAt(0).toUpperCase() || '🙂';

  return (
    <div className="app">
      <div className="app-shell">
        <nav className="topnav">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              ₹
            </span>
            Baaki
          </div>

          <div className="navtabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className="navtab"
                role="tab"
                aria-current={tab.key === current}
                aria-disabled={tab.key !== 'overview'}
                disabled={tab.key !== 'overview'}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="nav-right">
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

            <div ref={menuRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className="avatar icon-btn"
                onClick={() => setMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title={userName}
                style={{ width: 38, height: 38, border: 0 }}
              >
                {avatarUrl ? (
                  // Google's avatar CDN, a small round photo — next/image would
                  // need every provider host allow-listed to render one <img>.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" />
                ) : (
                  initial
                )}
              </button>

              {menuOpen ? (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    insetInlineEnd: 0,
                    top: 46,
                    background: 'var(--app-surface)',
                    border: '1px solid var(--line-strong)',
                    borderRadius: 14,
                    boxShadow: '0 12px 30px rgba(80,45,20,0.16)',
                    padding: 10,
                    minWidth: 180,
                    zIndex: 20,
                  }}
                >
                  <div style={{ padding: '4px 8px 8px' }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{userName}</div>
                    {isGuest ? (
                      <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                        {t.dash.guestLabel}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn soft block"
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
            </div>
          </div>
        </nav>

        {children}
      </div>
    </div>
  );
}
