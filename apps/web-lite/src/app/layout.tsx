import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';

import { StringsProvider } from '@/i18n-context';
import { isRtlLanguage, localeFor, pickLanguage, stringsFor } from '@/i18n';

import './globals.css';

export const metadata: Metadata = {
  title: 'Baaki',
  description: 'Split expenses without the argument at the end.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#7A5AF8',
};

/**
 * The language is read from `Accept-Language` here and nowhere else.
 *
 * Doing it on the server is what lets `lang` and `dir` be right in the first
 * paint. A guest opening an invite on an Arabic phone should find the page
 * already the right way round, not watch it turn around after hydration —
 * and unlike the app, the web has no restart problem: `dir` on `<html>` is
 * honoured by CSS the moment it is set.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const accept = (await headers()).get('accept-language');
  const language = pickLanguage(accept);
  const locale = localeFor(language, accept);
  const t = stringsFor(language);

  return (
    <html lang={language} dir={isRtlLanguage(language) ? 'rtl' : 'ltr'}>
      <head>
        <title>{t.home.title}</title>
      </head>
      <body>
        <StringsProvider language={language} locale={locale}>
          {children}
        </StringsProvider>
      </body>
    </html>
  );
}
