/**
 * Choosing a language, and what a choice does not change.
 *
 * The provider itself needs React and AsyncStorage and is checked on a device.
 * What is checked here is the arithmetic under it: which languages read the
 * other way, what each one calls itself, and the locale a chosen language is
 * formatted in — which is the one that can quietly move somebody's money to a
 * different country.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeLocale {
  languageCode?: string;
  regionCode?: string;
  languageTag?: string;
}

let locales: FakeLocale[] = [];

vi.mock('expo-localization', () => ({ getLocales: () => locales }));

const {
  deviceLanguage,
  isRtlLanguage,
  LANGUAGE_NAMES,
  LANGUAGES,
  localeFor,
  RTL_LANGUAGES,
  STRINGS_BY_LANGUAGE,
} = await import('../src/i18n');

beforeEach(() => {
  locales = [{ languageCode: 'en', regionCode: 'IN', languageTag: 'en-IN' }];
});

describe('the languages on offer', () => {
  it('offers exactly the languages there are string tables for', () => {
    expect([...LANGUAGES].sort()).toEqual(Object.keys(STRINGS_BY_LANGUAGE).sort());
  });

  it('names every one of them', () => {
    for (const language of LANGUAGES) {
      expect(LANGUAGE_NAMES[language].own.trim(), language).not.toBe('');
      expect(LANGUAGE_NAMES[language].english.trim(), language).not.toBe('');
    }
  });

  it('writes each name in its own script', () => {
    // The whole point of the endonym. Somebody who has opened the app in a
    // language they cannot read is scanning for the shape of their own
    // writing, and "Tamil" in Latin letters is not that shape.
    expect(LANGUAGE_NAMES.ta.own).toMatch(/\p{Script=Tamil}/u);
    expect(LANGUAGE_NAMES.hi.own).toMatch(/\p{Script=Devanagari}/u);
    expect(LANGUAGE_NAMES.ar.own).toMatch(/\p{Script=Arabic}/u);
  });

  it('agrees with RTL_LANGUAGES about which way each one reads', () => {
    for (const language of LANGUAGES) {
      expect(isRtlLanguage(language), language).toBe(RTL_LANGUAGES.includes(language));
    }
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('en')).toBe(false);
  });
});

describe('the locale a chosen language is formatted in', () => {
  it('keeps the country and swaps only the language', () => {
    // Reading the app in Hindi in Dubai does not move you to India. Dates and
    // currency belong to where somebody is, not to what they read.
    locales = [{ languageCode: 'ar', regionCode: 'AE', languageTag: 'ar-AE' }];
    expect(localeFor('hi')).toBe('hi-AE');
    expect(localeFor('en')).toBe('en-AE');
  });

  it('falls back to the bare language when the phone will not say where it is', () => {
    locales = [{ languageCode: 'en' }];
    expect(localeFor('ta')).toBe('ta');
  });

  it('ignores a region the phone reports as nonsense', () => {
    locales = [{ languageCode: 'en', regionCode: '419' }];
    expect(localeFor('en')).toBe('en');
  });

  it('produces a tag Intl will actually take', () => {
    // A tag assembled by hand is a tag that can be malformed, and the first
    // thing it touches is money.
    locales = [{ languageCode: 'en', regionCode: 'ae' }];
    for (const language of LANGUAGES) {
      const tag = localeFor(language);
      expect(() => new Intl.NumberFormat(tag), tag).not.toThrow();
      expect(new Intl.NumberFormat(tag).resolvedOptions().locale, tag).toContain(language);
    }
  });
});

describe('falling back to the phone', () => {
  it('takes a language it speaks', () => {
    locales = [{ languageCode: 'ta', regionCode: 'IN' }];
    expect(deviceLanguage()).toBe('ta');
  });

  it('answers English for one it does not', () => {
    locales = [{ languageCode: 'fr', regionCode: 'FR' }];
    expect(deviceLanguage()).toBe('en');
  });
});

describe('what every table owes the others', () => {
  /**
   * TypeScript guarantees the four tables have the same *shape*. It cannot
   * check what is inside a string, and two things inside these strings matter:
   * that somebody actually wrote words, and that the `{placeholders}` survived
   * translation. A dropped `{n}` is a sentence that silently loses its number.
   */
  const leaves = (value: unknown, path = ''): [string, string][] => {
    if (typeof value === 'string') return [[path, value]];
    if (Array.isArray(value)) return value.flatMap((item, i) => leaves(item, `${path}[${i}]`));
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, inner]) => leaves(inner, `${path}.${key}`));
    }
    return [];
  };

  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('never leaves a string blank', () => {
    for (const language of LANGUAGES) {
      for (const [path, text] of leaves(STRINGS_BY_LANGUAGE[language])) {
        expect(text.trim(), `${language}${path}`).not.toBe('');
      }
    }
  });

  /**
   * A singular or dual form is allowed to say the number in words rather than
   * print it — Arabic's "بعد ثانيتين" is "after two seconds" with no numeral in it, and
   * demanding a `{n}` there would force a translation nobody says aloud. The
   * `other` form is the one that must carry it.
   */
  const mayOmitTheNumber = (path: string): boolean => /\.(zero|one|two|few|many)$/.test(path);

  it('keeps every placeholder the English says', () => {
    const english = new Map(leaves(STRINGS_BY_LANGUAGE.en));
    for (const language of LANGUAGES) {
      if (language === 'en') continue;
      for (const [path, text] of leaves(STRINGS_BY_LANGUAGE[language])) {
        const source = english.get(path);
        // Plural tables legitimately have forms English does not (Arabic's
        // `two`, `few`, `many`), so a path English lacks is not a fault.
        if (source === undefined) continue;
        const here = placeholders(text);
        const there = placeholders(source);

        // Never invent one: `{amount}` where English said `{value}` renders the
        // token itself at somebody, which is worse than the wrong language.
        for (const name of here) expect(there, `${language}${path}`).toContain(name);
        if (!mayOmitTheNumber(path)) {
          expect(here, `${language}${path}`).toEqual(there);
        }
      }
    }
  });
});

/**
 * The restart is described twice, once for each direction, and the two are not
 * interchangeable. Telling somebody who has just chosen English that reopening
 * will "mirror it" describes the opposite of what will happen — on the one
 * screen they are reading to find out why it has not turned back.
 */
describe('the two directions of the restart', () => {
  const PAIRS: readonly [string, string][] = [
    ['account.languageRestartHint', 'account.languageRestartHintBack'],
    ['account.restartBannerMirror', 'account.restartBannerUnmirror'],
    ['signIn.restartToMirror', 'signIn.restartToUnmirror'],
  ];

  const at = (table: object, path: string): string =>
    path.split('.').reduce<never>((node, key) => (node as never)[key], table as never);

  it('says something different about each direction, in every language', () => {
    for (const language of LANGUAGES) {
      const table = STRINGS_BY_LANGUAGE[language];
      for (const [mirror, unmirror] of PAIRS) {
        expect(at(table, mirror).trim(), `${language}.${mirror}`).not.toBe('');
        expect(at(table, unmirror), `${language}.${unmirror}`).not.toBe(at(table, mirror));
      }
    }
  });

  it('names the language in the settings row either way', () => {
    for (const language of LANGUAGES) {
      const table = STRINGS_BY_LANGUAGE[language];
      expect(at(table, 'account.languageRestartHint'), language).toContain('{language}');
      expect(at(table, 'account.languageRestartHintBack'), language).toContain('{language}');
    }
  });
});
