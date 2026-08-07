/**
 * Every language says everything.
 *
 * A missing key is not a crash — it is `undefined` rendered as a blank space on
 * one screen in one language, which is exactly the kind of thing that ships.
 * TypeScript catches a missing *top-level* key because `UiStrings` is a closed
 * interface, but it cannot catch a string left in English by accident, and it
 * cannot catch a category map that quietly lost an entry.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));

const { STRINGS_BY_LANGUAGE, RTL_LANGUAGES } = await import('../src/i18n');

const LANGUAGES = ['en', 'ta', 'hi', 'ar'] as const;

describe('the string tables', () => {
  it('has all four languages', () => {
    expect(Object.keys(STRINGS_BY_LANGUAGE).sort()).toEqual([...LANGUAGES].sort());
  });

  it('gives every language every key', () => {
    const english = Object.keys(STRINGS_BY_LANGUAGE.en).sort();
    for (const language of LANGUAGES) {
      expect(Object.keys(STRINGS_BY_LANGUAGE[language]).sort(), language).toEqual(english);
    }
  });

  it('gives every language every category', () => {
    const categories = Object.keys(STRINGS_BY_LANGUAGE.en.categories).sort();
    for (const language of LANGUAGES) {
      expect(Object.keys(STRINGS_BY_LANGUAGE[language].categories).sort(), language).toEqual(
        categories,
      );
    }
  });

  it('leaves nothing blank', () => {
    for (const language of LANGUAGES) {
      for (const [key, value] of Object.entries(STRINGS_BY_LANGUAGE[language])) {
        if (typeof value === 'string') {
          expect(value.trim(), `${language}.${key}`).not.toBe('');
        }
      }
      for (const [key, value] of Object.entries(STRINGS_BY_LANGUAGE[language].categories)) {
        expect(value.trim(), `${language}.categories.${key}`).not.toBe('');
      }
    }
  });

  it('gives every language three onboarding cards, filled in', () => {
    // These were literals inside `Onboarding.tsx` until Arabic arrived, which
    // meant the very first screen of the app was in English whatever the phone
    // said — and told the reader about rupees and UPI apps.
    for (const language of LANGUAGES) {
      const cards = STRINGS_BY_LANGUAGE[language].onboarding;
      expect(cards, language).toHaveLength(3);
      for (const [index, card] of cards.entries()) {
        expect(card.title.trim(), `${language}.onboarding[${index}].title`).not.toBe('');
        expect(card.body.trim(), `${language}.onboarding[${index}].body`).not.toBe('');
      }
    }
  });

  it('does not name one country’s payment rail on the first screen', () => {
    // "your UPI app" is the wrong first sentence for somebody in Dubai or São
    // Paulo, and the onboarding runs before anybody has chosen a country.
    for (const language of LANGUAGES) {
      for (const card of STRINGS_BY_LANGUAGE[language].onboarding) {
        expect(card.body, language).not.toMatch(/\bUPI\b/i);
        expect(card.body, language).not.toMatch(/rupee/i);
      }
    }
  });

  it('keeps the placeholder in the one string that has one', () => {
    // `acrossGroups` interpolates {count}. A translation that drops it renders
    // "across groups" and the number simply disappears.
    for (const language of LANGUAGES) {
      expect(STRINGS_BY_LANGUAGE[language].acrossGroups, language).toContain('{count}');
    }
  });

  it('actually translated Arabic rather than copying English', () => {
    // The failure this catches is a half-done language: the table exists, the
    // keys are all there, and half the app is still in English.
    const arabic = STRINGS_BY_LANGUAGE.ar;
    const english = STRINGS_BY_LANGUAGE.en;
    const untranslated = Object.keys(english).filter(
      (key) =>
        typeof english[key as keyof typeof english] === 'string' &&
        english[key as keyof typeof english] === arabic[key as keyof typeof arabic],
    );
    expect(untranslated).toEqual([]);

    // And it is written in Arabic script, not transliterated.
    expect(arabic.settleUp).toMatch(/\p{Script=Arabic}/u);
  });

  it('knows which languages read right to left', () => {
    expect(RTL_LANGUAGES).toEqual(['ar']);
  });
});
