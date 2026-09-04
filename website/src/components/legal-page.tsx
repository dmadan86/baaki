import Link from 'next/link';

import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/dictionaries';
import { site } from '@/lib/site';
import { Aurora } from './aurora';
import { ArrowRight } from './icons';
import { Wordmark } from './logo';
import { Container } from './ui';

export type LegalSection = { heading: string; body: string[] };

/**
 * The shell every legal page shares. The document itself is published in
 * English in all four locales and carries `lang="en"` so a screen reader
 * switches voice rather than reading English with a Tamil pronunciation — a
 * translated policy that nobody has had reviewed would be worse than an honest
 * English one.
 */
export function LegalPage({
  locale,
  title,
  updated,
  intro,
  sections,
  t,
}: {
  locale: Locale;
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
  t: Dictionary['legal'];
}) {
  return (
    <>
      <Aurora />

      <header className="border-b border-white/[0.07]">
        <Container className="flex h-18 items-center justify-between">
          <Link href={`/${locale}`} aria-label={site.name}>
            <Wordmark />
          </Link>
          <Link
            href={`/${locale}`}
            className="group inline-flex items-center gap-2 text-sm text-white/60 transition-colors hover:text-white"
          >
            {t.backHome}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
          </Link>
        </Container>
      </header>

      <main className="py-20 sm:py-28">
        <Container className="max-w-3xl">
          <p className="text-xs tracking-[0.16em] text-white/35 uppercase">
            {t.lastUpdated} · {updated}
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
            {title}
          </h1>
          <p className="mt-3 text-xs text-white/35">{t.englishOnly}</p>

          <div lang="en" dir="ltr" className="mt-12 space-y-10">
            <p className="text-pretty leading-relaxed text-white/65">{intro}</p>

            {sections.map((section) => (
              <section key={section.heading}>
                <h2 className="text-lg font-semibold tracking-[-0.02em] text-white">
                  {section.heading}
                </h2>
                <div className="mt-3 space-y-3">
                  {section.body.map((paragraph) => (
                    <p key={paragraph} className="text-sm leading-relaxed text-white/55">
                      {paragraph}
                    </p>
                  ))}
                </div>
              </section>
            ))}

            <p className="text-sm text-white/45">
              Questions about any of this:{' '}
              <a
                className="text-brand-200 underline-offset-4 hover:underline"
                href={`mailto:${site.supportEmail}`}
              >
                {site.supportEmail}
              </a>
            </p>
          </div>
        </Container>
      </main>
    </>
  );
}
