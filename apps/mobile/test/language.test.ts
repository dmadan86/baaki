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
