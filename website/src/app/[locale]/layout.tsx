import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import {
  Geist,
  Instrument_Serif,
  Noto_Sans_Arabic,
  Noto_Sans_Devanagari,
  Noto_Sans_Tamil,
} from 'next/font/google';

import '../globals.css';
import { dirFor, htmlLang, isLocale, locales, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { absoluteUrl, site } from '@/lib/site';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });

const instrument = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: 'italic',
  variable: '--font-display',
  display: 'swap',
});

const notoArabic = Noto_Sans_Arabic({
  subsets: ['arabic'],
  variable: '--font-arabic',
  display: 'swap',
});

const notoDevanagari = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  variable: '--font-devanagari',
  display: 'swap',
});

const notoTamil = Noto_Sans_Tamil({
  subsets: ['tamil'],
  variable: '--font-tamil',
  display: 'swap',
});

/** Only the script this page is written in is loaded. */
const scriptFont: Record<Locale, string> = {
  en: '',
  ar: notoArabic.variable,
  hi: notoDevanagari.variable,
  ta: notoTamil.variable,
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  themeColor: '#08080f',
  colorScheme: 'dark',
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getDictionary(locale);

  return {
    metadataBase: new URL(site.url),
    title: { default: t.meta.title, template: `%s · ${site.name}` },
    description: t.meta.description,
    applicationName: site.name,
    alternates: {
      canonical: absoluteUrl(`/${locale}`),
      languages: {
        ...Object.fromEntries(locales.map((l) => [htmlLang[l], absoluteUrl(`/${l}`)])),
        'x-default': absoluteUrl('/en'),
      },
    },
    openGraph: {
      type: 'website',
      siteName: site.name,
      title: t.meta.title,
      description: t.meta.description,
      url: absoluteUrl(`/${locale}`),
      locale: htmlLang[locale],
    },
    twitter: {
      card: 'summary_large_image',
      title: t.meta.title,
      description: t.meta.description,
    },
    robots: { index: true, follow: true },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html
      lang={htmlLang[locale]}
      dir={dirFor(locale)}
      className={`${geist.variable} ${instrument.variable} ${scriptFont[locale]}`}
      suppressHydrationWarning
    >
      <body className="grain relative min-h-screen antialiased">{children}</body>
    </html>
  );
}
