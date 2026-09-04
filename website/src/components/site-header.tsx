'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { languageNames, locales, type Locale } from '@/i18n/config';
import { Chevron, Close, Globe, Menu } from './icons';
import { Wordmark } from './logo';

type Nav = {
  features: string;
  how: string;
  trips: string;
  pricing: string;
  faq: string;
  openApp: string;
  getApp: string;
  menu: string;
  close: string;
  language: string;
};

export function SiteHeader({ locale, nav, appUrl }: { locale: Locale; nav: Nav; appUrl: string }) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  /**
   * A drawer that stays open behind a route change is a trap on a phone. Rather
   * than closing it from an effect on `pathname` — which is a render, then a
   * second render to undo it — each overlay remembers the path it was opened
   * on, so navigating away closes it as part of the same render.
   */
  const [menuOpenOn, setMenuOpenOn] = useState<string | null>(null);
  const [langOpenOn, setLangOpenOn] = useState<string | null>(null);
  const menuOpen = menuOpenOn === pathname;
  const langOpen = langOpenOn === pathname;

  const setMenuOpen = (open: boolean) => setMenuOpenOn(open ? pathname : null);
  const setLangOpen = (open: boolean) => setLangOpenOn(open ? pathname : null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  const links = [
    { href: '#features', label: nav.features },
    { href: '#how', label: nav.how },
    { href: '#trips', label: nav.trips },
    { href: '#pricing', label: nav.pricing },
    { href: '#faq', label: nav.faq },
  ];

  /** Swap only the locale segment, so the switcher keeps you on the page. */
  const localeHref = (next: Locale) => {
    const rest = pathname.split('/').slice(2).join('/');
    return `/${next}${rest ? `/${rest}` : ''}`;
  };

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-500 ${
        scrolled
          ? 'border-b border-white/[0.07] bg-night-950/70 backdrop-blur-xl'
          : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:h-18 sm:px-8">
        <Link href={`/${locale}`} aria-label="Waves" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-full px-3.5 py-2 text-sm text-white/65 transition-colors hover:bg-white/5 hover:text-white"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <div className="relative hidden sm:block">
            <button
              type="button"
              onClick={() => setLangOpen(!langOpen)}
              aria-expanded={langOpen}
              aria-haspopup="menu"
              className="inline-flex h-10 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 text-sm text-white/75 transition-colors hover:border-white/25 hover:text-white"
            >
              <Globe className="h-4 w-4" />
              <span className="hidden md:inline">{languageNames[locale].endonym}</span>
              <Chevron
                className={`h-3.5 w-3.5 transition-transform duration-200 ${langOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {langOpen ? (
              <>
                <button
                  type="button"
                  aria-label={nav.close}
                  className="fixed inset-0 z-0 cursor-default"
                  onClick={() => setLangOpen(false)}
                />
                <div
                  role="menu"
                  className="glass-strong absolute end-0 z-10 mt-2 w-52 overflow-hidden rounded-2xl p-1.5"
                >
                  {locales.map((l) => (
                    <Link
                      key={l}
                      href={localeHref(l)}
                      role="menuitem"
                      lang={l}
                      aria-current={l === locale ? 'true' : undefined}
                      className={`flex items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-colors ${
                        l === locale
                          ? 'bg-white/10 text-white'
                          : 'text-white/70 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      <span>{languageNames[l].endonym}</span>
                      <span className="text-xs text-white/40">{languageNames[l].english}</span>
                    </Link>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <a
            href={appUrl}
            className="hidden h-10 items-center rounded-full px-4 text-sm font-medium text-white/75 transition-colors hover:text-white md:inline-flex"
          >
            {nav.openApp}
          </a>

          <a
            href={appUrl}
            className="hidden h-10 items-center rounded-full bg-white px-4 text-sm font-semibold text-night-950 transition-all duration-300 hover:-translate-y-0.5 hover:bg-brand-50 sm:inline-flex"
          >
            {nav.getApp}
          </a>

          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? nav.close : nav.menu}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white lg:hidden"
          >
            {menuOpen ? <Close /> : <Menu />}
          </button>
        </div>
      </div>

      {menuOpen ? (
        <div className="border-t border-white/[0.07] bg-night-950/95 backdrop-blur-xl lg:hidden">
          <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8">
            <nav className="flex flex-col" aria-label="Mobile">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="border-b border-white/5 py-3.5 text-lg text-white/80"
                >
                  {link.label}
                </a>
              ))}
            </nav>

            <div className="mt-6">
              <p className="mb-3 text-xs tracking-[0.16em] text-white/40 uppercase">
                {nav.language}
              </p>
              <div className="flex flex-wrap gap-2">
                {locales.map((l) => (
                  <Link
                    key={l}
                    href={localeHref(l)}
                    lang={l}
                    aria-current={l === locale ? 'true' : undefined}
                    className={`rounded-full border px-3.5 py-2 text-sm ${
                      l === locale
                        ? 'border-brand-400/60 bg-brand-500/20 text-white'
                        : 'border-white/10 bg-white/[0.03] text-white/70'
                    }`}
                  >
                    {languageNames[l].endonym}
                  </Link>
                ))}
              </div>
            </div>

            <a
              href={appUrl}
              className="mt-7 flex h-12 items-center justify-center rounded-full bg-white text-sm font-semibold text-night-950"
            >
              {nav.getApp}
            </a>
          </div>
        </div>
      ) : null}
    </header>
  );
}
