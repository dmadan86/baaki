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

  it('actually translated every language rather than copying English', () => {
    // The failure this catches is a half-done language: the table exists, the
    // keys are all there, and half the app is still in English. It went
    // unnoticed for three milestones because `ta` and `hi` opened with a
    // `...en` spread — every key they forgot compiled, passed the key test
    // above, and shipped in English. The spread is gone; this is the check
    // that says so out loud.
    const english = STRINGS_BY_LANGUAGE.en;
    for (const language of ['ta', 'hi', 'ar'] as const) {
      const table = STRINGS_BY_LANGUAGE[language];
      const untranslated = Object.keys(english).filter(
        (key) =>
          typeof english[key as keyof typeof english] === 'string' &&
          english[key as keyof typeof english] === table[key as keyof typeof table],
      );
      expect(untranslated, language).toEqual([]);

      const categories = Object.keys(english.categories).filter(
        (key) =>
          english.categories[key as keyof typeof english.categories] ===
          table.categories[key as keyof typeof table.categories],
      );
      expect(categories, `${language}.categories`).toEqual([]);

      // Onboarding is the first screen anybody sees, and the easiest to leave
      // in English because it is the furthest from the code being changed.
      for (const [index, card] of table.onboarding.entries()) {
        expect(card.title, `${language}.onboarding[${index}]`).not.toBe(
          english.onboarding[index]?.title,
        );
      }
    }
  });

  it('writes each language in its own script, not transliterated', () => {
    expect(STRINGS_BY_LANGUAGE.ta.settleUp).toMatch(/\p{Script=Tamil}/u);
    expect(STRINGS_BY_LANGUAGE.hi.settleUp).toMatch(/\p{Script=Devanagari}/u);
    expect(STRINGS_BY_LANGUAGE.ar.settleUp).toMatch(/\p{Script=Arabic}/u);
  });

  it('knows which languages read right to left', () => {
    expect(RTL_LANGUAGES).toEqual(['ar']);
  });
});

/**
 * The plural rules are ours, not the platform's.
 *
 * `Intl.PluralRules` is absent from the Hermes build this app ships on: the
 * constructor throws, the old helper caught it, and every plural in the app
 * quietly rendered its `other` form. The home screen read "across 1 groups" and
 * nothing in CI could see it, because Node has full ICU and always answered
 * correctly. These run against the rules directly for that reason.
 */
describe('plural rules', () => {
  it('picks singular for one, in every language that has one', async () => {
    const { plural } = await import('../src/i18n');
    expect(plural('en', 1, { one: '{n} change', other: '{n} changes' })).toBe('1 change');
    expect(plural('en-US', 1, { one: '{n} change', other: '{n} changes' })).toBe('1 change');
    expect(plural('ta', 1, { one: 'one', other: 'many' })).toBe('one');
    expect(plural('hi', 1, { one: 'one', other: 'many' })).toBe('one');
    expect(plural('ar', 1, { one: 'one', other: 'many' })).toBe('one');
  });

  it('picks the plural for everything else', async () => {
    const { plural } = await import('../src/i18n');
    for (const count of [0, 2, 5, 21, 100]) {
      expect(plural('en', count, { one: 'one', other: 'many' })).toBe('many');
    }
  });

  it('follows Hindi in treating zero as singular', async () => {
    const { plural } = await import('../src/i18n');
    expect(plural('hi', 0, { one: 'one', other: 'many' })).toBe('one');
    expect(plural('en', 0, { one: 'one', other: 'many' })).toBe('many');
  });

  it('walks all six Arabic categories', async () => {
    const { plural } = await import('../src/i18n');
    const forms = {
      zero: 'zero',
      one: 'one',
      two: 'two',
      few: 'few',
      many: 'many',
      other: 'other',
    };
    expect(plural('ar', 0, forms)).toBe('zero');
    expect(plural('ar', 1, forms)).toBe('one');
    expect(plural('ar', 2, forms)).toBe('two');
    expect(plural('ar', 3, forms)).toBe('few');
    expect(plural('ar', 10, forms)).toBe('few');
    expect(plural('ar', 11, forms)).toBe('many');
    expect(plural('ar', 99, forms)).toBe('many');
    expect(plural('ar', 100, forms)).toBe('other');
  });

  it('still renders a sentence when the platform has no Intl at all', async () => {
    const { plural } = await import('../src/i18n');
    // Hermes does not merely get this wrong — it does not define it, and the
    // constructor throws. Standing that up here is the only way CI can see what
    // a phone sees, because Node ships full ICU and always answers.
    const intl = Intl as unknown as Record<string, unknown>;
    const original = intl.PluralRules;
    delete intl.PluralRules;
    try {
      expect(plural('en', 1, { one: '{n} change', other: '{n} changes' })).toBe('1 change');
      expect(plural('ar', 2, { one: 'one', two: 'two', other: 'other' })).toBe('two');
    } finally {
      intl.PluralRules = original;
    }
  });
});
