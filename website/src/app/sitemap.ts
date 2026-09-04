import type { MetadataRoute } from 'next';

import { htmlLang, locales } from '@/i18n/config';
import { absoluteUrl } from '@/lib/site';

const paths = ['', '/privacy', '/terms'] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return locales.flatMap((locale) =>
    paths.map((path) => ({
      url: absoluteUrl(`/${locale}${path}`),
      lastModified: new Date(),
      changeFrequency: path === '' ? ('weekly' as const) : ('yearly' as const),
      priority: path === '' ? 1 : 0.4,
      alternates: {
        languages: Object.fromEntries(
          locales.map((l) => [htmlLang[l], absoluteUrl(`/${l}${path}`)]),
        ),
      },
    })),
  );
}
