import type { Locale } from './config';
import en from './dictionaries/en.json';

/**
 * English is the shape of the contract: every other dictionary is typed as
 * `Dictionary`, so a missing key is a build error rather than a blank space on
 * a page nobody on the team can read.
 */
export type Dictionary = typeof en;

const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
  en: async () => en,
  ta: () => import('./dictionaries/ta.json').then((m) => m.default as Dictionary),
  hi: () => import('./dictionaries/hi.json').then((m) => m.default as Dictionary),
  ar: () => import('./dictionaries/ar.json').then((m) => m.default as Dictionary),
};

export function getDictionary(locale: Locale): Promise<Dictionary> {
  return dictionaries[locale]();
}
