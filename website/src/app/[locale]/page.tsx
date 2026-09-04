import { notFound } from 'next/navigation';

import { Aurora } from '@/components/aurora';
import { Audience } from '@/components/audience';
import { Faq } from '@/components/faq';
import { Features } from '@/components/features';
import { FinalCta } from '@/components/final-cta';
import { Hero } from '@/components/hero';
import { Marquee } from '@/components/marquee';
import { Pricing } from '@/components/pricing';
import { PrivacySection } from '@/components/privacy-section';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { Stats } from '@/components/stats';
import { HowItWorks } from '@/components/how-it-works';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { absoluteUrl, site } from '@/lib/site';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const t = await getDictionary(locale);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: site.name,
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Android, iOS, Web',
        description: t.meta.description,
        url: absoluteUrl(`/${locale}`),
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: t.faq.items.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };

  return (
    <>
      {/* A scroll animation must never be the reason a page is empty. */}
      <noscript>
        <style>{`.reveal{opacity:1;transform:none}`}</style>
      </noscript>

      <script
        type="application/ld+json"
        // The payload is our own copy, not user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Aurora />
      <SiteHeader locale={locale} nav={t.nav} appUrl={site.appUrl} />

      <main id="main">
        <Hero t={t.hero} banner={t.banner} appUrl={site.appUrl} />
        <Marquee t={t.marquee} />
        <Stats t={t.stats} />
        <Features t={t.features} visuals={t.visuals} />
        <HowItWorks t={t.how} />
        <Audience t={t.audience} />
        <PrivacySection t={t.privacy} />
        <Pricing t={t.pricing} appUrl={site.appUrl} />
        <Faq t={t.faq} />
        <FinalCta t={t.cta} appUrl={site.appUrl} />
      </main>

      <SiteFooter locale={locale} t={t.footer} appUrl={site.appUrl} />
    </>
  );
}
