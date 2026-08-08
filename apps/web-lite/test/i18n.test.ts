/**
 * What the four pages owe every language.
 *
 * The same rule as the app's own table test, for the same reason: a key added
 * in English and forgotten everywhere else is a screen that silently reverts
 * to a language the reader came here to escape. `WebStrings` is a closed
 * interface with no spread of English underneath it, so the type checker
 * catches a *missing* key — what it cannot catch is an empty one, a lost
 * placeholder, or a translation that quietly kept the English.
 */

import { describe, expect, it } from 'vitest';

import {
  LANGUAGES,
  STRINGS_BY_LANGUAGE,
  fill,
  isRtlLanguage,
  localeFor,
  pickLanguage,
  plural,
} from '../src/i18n';

type Leaf = [path: string, text: string];

function leaves(node: unknown, path = ''): Leaf[] {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => leaves(value, `${path}.${key}`));
  }
  return [];
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('the language the browser asked for', () => {
  it('takes the first tag it recognises, in order', () => {
    expect(pickLanguage('ta-IN,ta;q=0.9,en;q=0.8')).toBe('ta');
    expect(pickLanguage('fr-FR,fr;q=0.9,hi;q=0.5')).toBe('hi');
    expect(pickLanguage('ar')).toBe('ar');
  });

  it('falls back to English rather than guessing', () => {
    expect(pickLanguage(null)).toBe('en');
    expect(pickLanguage('')).toBe('en');
    expect(pickLanguage('fr-FR,de;q=0.8')).toBe('en');
  });

  it('keeps the region, because a language is not a country', () => {
    // Reading in Hindi from Dubai still formats money as `hi-AE`.
    expect(localeFor('hi', 'hi-AE,hi;q=0.9,en;q=0.8')).toBe('hi-AE');
    expect(localeFor('ar', 'ar-EG,ar;q=0.9')).toBe('ar-EG');
    expect(localeFor('ta', 'en-GB,ta;q=0.7')).toBe('ta');
  });

  it('knows which way each one reads', () => {
    expect(LANGUAGES.filter(isRtlLanguage)).toEqual(['ar']);
  });
});

describe('what every table owes the others', () => {
  it('has a table for every language on offer', () => {
    expect([...LANGUAGES].sort()).toEqual(Object.keys(STRINGS_BY_LANGUAGE).sort());
  });

  it('never leaves a string blank', () => {
    for (const language of LANGUAGES) {
      for (const [path, text] of leaves(STRINGS_BY_LANGUAGE[language])) {
        expect(text.trim(), `${language}${path}`).not.toBe('');
      }
    }
  });

  /**
   * A singular, dual or paucal form may say the number in words instead of
   * printing it. The `other` form is the one that must carry the placeholder.
   */
  const mayOmitTheNumber = (path: string): boolean => /\.(zero|one|two|few|many)$/.test(path);

  it('keeps every placeholder the English says', () => {
    const english = new Map(leaves(STRINGS_BY_LANGUAGE.en));
    for (const language of LANGUAGES) {
      if (language === 'en') continue;
      for (const [path, text] of leaves(STRINGS_BY_LANGUAGE[language])) {
        const source = english.get(path);
        // Arabic has plural forms English does not, so a path English lacks is
        // not a fault.
        if (source === undefined) continue;
        const here = placeholders(text);
        const there = placeholders(source);
        // Never invent one: `{amount}` where English said `{value}` renders the
        // token itself at somebody, which is worse than the wrong language.
        for (const name of here) expect(there, `${language}${path}`).toContain(name);
        if (!mayOmitTheNumber(path)) expect(here, `${language}${path}`).toEqual(there);
      }
    }
  });

  it('says something different from English in every language', () => {
    const english = new Map(leaves(STRINGS_BY_LANGUAGE.en));
    for (const language of LANGUAGES) {
      if (language === 'en') continue;
      const table = leaves(STRINGS_BY_LANGUAGE[language]);
      // Not every string can differ — 'Baaki' is a name, and a currency code is
      // a currency code — so this is a proportion, not a rule per string.
      const translated = table.filter(([path, text]) => english.get(path) !== text);
      expect(translated.length / table.length, language).toBeGreaterThan(0.9);
    }
  });
});

describe('counting people', () => {
  it('uses the language’s own plural categories', () => {
    const { splittingHere } = STRINGS_BY_LANGUAGE.ar.join;
    // Arabic has six; two of them are not "one or many".
    expect(plural('ar', 1, splittingHere)).toBe(splittingHere.one);
    expect(plural('ar', 2, splittingHere)).toBe(splittingHere.two);
    expect(plural('ar', 3, splittingHere)).not.toBe(splittingHere.other);
  });

  it('formats the number for the locale', () => {
    expect(plural('en-IN', 4, STRINGS_BY_LANGUAGE.en.group.peopleCount)).toBe('4 people');
    // Arabic-Indic digits where the locale asks for them.
    expect(plural('ar-EG', 8, STRINGS_BY_LANGUAGE.ar.group.peopleCount)).toContain('٨');
  });
});

describe('filling in a name', () => {
  it('substitutes every placeholder it is given', () => {
    expect(fill(STRINGS_BY_LANGUAGE.en.join.joinGroup, { group: 'Goa' })).toBe('Join Goa');
    expect(fill('{a} and {a}', { a: 'x' })).toBe('x and x');
  });
});
