import Link from 'next/link';

import { languageNames, locales, type Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries';
import { site } from '@/lib/site';
import { WaveMark } from './logo';
import { Container } from './ui';

export function SiteFooter({
  locale,
  t,
  appUrl,
}: {
  locale: Locale;
  t: Dictionary['footer'];
  appUrl: string;
}) {
  const columns = [
    {
      heading: t.product,
      links: [
        { label: t.links.features, href: '#features' },
        { label: t.links.how, href: '#how' },
        { label: t.links.pricing, href: '#pricing' },
        { label: t.links.faq, href: '#faq' },
        { label: t.links.webApp, href: appUrl, external: true },
      ],
    },
    {
      heading: t.company,
      links: [
        { label: t.links.contact, href: `mailto:${site.supportEmail}`, external: true },
        { label: t.links.support, href: `mailto:${site.supportEmail}`, external: true },
      ],
    },
    {
      heading: t.legal,
      links: [
        { label: t.links.privacy, href: `/${locale}/privacy` },
        { label: t.links.terms, href: `/${locale}/terms` },
      ],
    },
  ];

  return (
    <footer className="relative border-t border-white/[0.07] py-16">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[1.4fr_2fr]">
          <div>
            <Link href={`/${locale}`} className="inline-flex items-center gap-2.5">
              <WaveMark className="h-8 w-8" />
              <span className="text-xl font-semibold tracking-[-0.03em] text-white">
                {site.name}
              </span>
            </Link>
            <p className="mt-5 max-w-sm text-sm leading-relaxed text-white/45">{t.tagline}</p>
            <p className="mt-6 text-xs text-white/30">{t.madeIn}</p>
          </div>

          <div className="grid gap-10 sm:grid-cols-3">
            {columns.map((column) => (
              <div key={column.heading}>
                <h2 className="text-xs font-medium tracking-[0.16em] text-white/40 uppercase">
                  {column.heading}
                </h2>
                <ul className="mt-4 space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      {'external' in link && link.external ? (
                        <a
                          href={link.href}
                          className="text-sm text-white/60 transition-colors hover:text-white"
                        >
                          {link.label}
                        </a>
                      ) : link.href.startsWith('#') ? (
                        <a
                          href={link.href}
                          className="text-sm text-white/60 transition-colors hover:text-white"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href}
                          className="text-sm text-white/60 transition-colors hover:text-white"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="hairline my-10" />

        <div className="flex flex-col-reverse items-start justify-between gap-6 sm:flex-row sm:items-center">
          <p className="text-xs text-white/35">
            © {new Date().getFullYear()} {site.name}. {t.rights}
          </p>

          <nav aria-label={t.language} className="flex flex-wrap items-center gap-1.5">
            {locales.map((l) => (
              <Link
                key={l}
                href={`/${l}`}
                lang={l}
                hrefLang={l}
                aria-current={l === locale ? 'true' : undefined}
                className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                  l === locale
                    ? 'bg-white/10 text-white'
                    : 'text-white/45 hover:bg-white/5 hover:text-white'
                }`}
              >
                {languageNames[l].endonym}
              </Link>
            ))}
          </nav>
        </div>
      </Container>
    </footer>
  );
}
