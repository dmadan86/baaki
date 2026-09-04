/**
 * The site speaks the same four languages the app does — en, ta, hi, ar — and
 * Arabic reads right to left. On the web that is one `dir` attribute on <html>
 * rather than the native restart the app needs, so every locale is reachable
 * from every page and the switcher is a plain link.
 *
 * The locale lives in the first path segment (`/ta/...`), not a cookie: a
 * shared link has to open in the language it was written in, and a static page
 * per locale is what lets the whole site prerender.
 */

export const locales = ['en', 'ta', 'hi', 'ar'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/** The languages that read right to left. */
const rtlLocales: readonly Locale[] = ['ar'];

export function dirFor(locale: Locale): 'rtl' | 'ltr' {
  return rtlLocales.includes(locale) ? 'rtl' : 'ltr';
}

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/**
 * What each language calls itself, and what English calls it. The endonym
 * leads — somebody looking for their own language scans for its own name, not
 * for the English word for it.
 */
export const languageNames: Record<Locale, { endonym: string; english: string }> = {
  en: { endonym: 'English', english: 'English' },
  ta: { endonym: 'தமிழ்', english: 'Tamil' },
  hi: { endonym: 'हिन्दी', english: 'Hindi' },
  ar: { endonym: 'العربية', english: 'Arabic' },
};

/** BCP-47 tags for <html lang> and hreflang. */
export const htmlLang: Record<Locale, string> = {
  en: 'en',
  ta: 'ta',
  hi: 'hi',
  ar: 'ar',
};
