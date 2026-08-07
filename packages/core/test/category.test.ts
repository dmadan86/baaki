/**
 * The guess is allowed to be wrong. It is not allowed to be wrong *silently* in
 * the ways that matter: matching inside another word, disagreeing with itself
 * between two devices, or claiming a category for a description that says
 * nothing.
 */

import { describe, expect, it } from 'vitest';

import { CATEGORIES, categoryOf, guessCategory, OTHER } from '../src/category/categories.js';

describe('guessCategory', () => {
  it('reads the ordinary vocabulary of an Indian bill', () => {
    expect(guessCategory('Auto to the station')).toBe('travel');
    expect(guessCategory('Biryani at Anjappar')).toBe('food');
    expect(guessCategory('Blinkit order')).toBe('groceries');
    expect(guessCategory('OYO for two nights')).toBe('stay');
    expect(guessCategory('BookMyShow tickets')).toBe('entertainment');
    expect(guessCategory('Electricity bill')).toBe('home');
    expect(guessCategory('Pharmacy run')).toBe('health');
    expect(guessCategory("Ananya's birthday gift")).toBe('gifts');
  });

  it('matches whole words, never substrings', () => {
    // 'ola' is a cab company and also the middle of chocolate; 'eb' is the
    // electricity board and also the middle of everything.
    expect(guessCategory('Chocolates')).not.toBe('travel');
    expect(guessCategory('Webcam')).not.toBe('home');
  });

  it('says nothing rather than guessing "other"', () => {
    expect(guessCategory('')).toBeNull();
    expect(guessCategory('   ')).toBeNull();
    expect(guessCategory('Saturday')).toBeNull();
  });

  it('is deterministic when two categories both match', () => {
    // 'hotel' is food (the Tamil sense) and 'room' is stay. Whichever wins, it
    // wins the same way on every device — an unstable guess would rewrite
    // somebody's category the next time the screen re-rendered.
    const mixed = 'Hotel room and dinner';
    const first = guessCategory(mixed);
    expect(guessCategory(mixed)).toBe(first);
    expect(first).toBe('food');
  });

  it('ignores case and punctuation', () => {
    expect(guessCategory('UBER — airport')).toBe('travel');
    expect(guessCategory('swiggy!!')).toBe('food');
  });
});

describe('categoryOf', () => {
  it('resolves every known id', () => {
    for (const category of CATEGORIES) {
      expect(categoryOf(category.id)).toBe(category);
    }
  });

  it('falls back to Other for anything a stored row might hold', () => {
    // The column is free text: an import, an older build, or a typo can put
    // anything there, and a chart is not worth crashing a screen over.
    expect(categoryOf(null)).toBe(OTHER);
    expect(categoryOf(undefined)).toBe(OTHER);
    expect(categoryOf('')).toBe(OTHER);
    expect(categoryOf('Entertainment ')).toBe(categoryOf('entertainment'));
    expect(categoryOf('vacation')).toBe(OTHER);
  });
});

describe('the category list itself', () => {
  it('has unique ids and no keyword claimed twice', () => {
    const ids = CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);

    const seen = new Map<string, string>();
    for (const category of CATEGORIES) {
      for (const keyword of category.keywords) {
        expect(keyword).toBe(keyword.toLowerCase());
        const owner = seen.get(keyword);
        expect(owner, `"${keyword}" is claimed by both ${owner} and ${category.id}`).toBeUndefined();
        seen.set(keyword, category.id);
      }
    }
  });
});
