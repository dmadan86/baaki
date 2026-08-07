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

describe('a market adds its own vocabulary', () => {
  it('reads a Gulf receipt that used to land in Other', () => {
    // Every one of these is a normal Dubai expense and every one of them
    // guessed nothing before markets existed — which made the Spending screen
    // look broken rather than empty.
    expect(guessCategory('Talabat dinner', 'AE')).toBe('food');
    expect(guessCategory('Careem to the airport', 'AE')).toBe('travel');
    expect(guessCategory('Lulu run', 'AE')).toBe('groceries');
    expect(guessCategory('Salik toll', 'AE')).toBe('travel');
    expect(guessCategory('DEWA bill', 'AE')).toBe('home');
  });

  it('shares the Gulf list across all six countries', () => {
    for (const country of ['AE', 'SA', 'QA', 'KW', 'BH', 'OM']) {
      expect(guessCategory('Talabat', country), country).toBe('food');
    }
  });

  it('knows Brazil and Southeast Asia too', () => {
    expect(guessCategory('iFood almoco', 'BR')).toBe('food');
    expect(guessCategory('Uber pro aeroporto', 'BR')).toBe('travel');
    expect(guessCategory('Grab to work', 'SG')).toBe('travel');
    expect(guessCategory('NTUC groceries', 'SG')).toBe('groceries');
    expect(guessCategory('Gojek', 'ID')).toBe('travel');
  });

  it('leaves the shared list working with no market at all', () => {
    // Every caller written before markets existed passes one argument.
    expect(guessCategory('Swiggy dinner')).toBe('food');
    expect(guessCategory('Auto to the station')).toBe('travel');
    expect(guessCategory('Swiggy dinner', undefined)).toBe('food');
  });

  it('treats a country nobody has written keywords for as no worse than before', () => {
    for (const country of ['ZZ', '', null, 'DE']) {
      expect(guessCategory('Dinner at the restaurant', country), String(country)).toBe('food');
      expect(guessCategory('Talabat', country), String(country)).toBeNull();
    }
  });

  it('still keeps India working when a market is named', () => {
    expect(guessCategory('Swiggy dinner', 'IN')).toBe('food');
    expect(guessCategory('Auto to the station', 'IN')).toBe('travel');
  });

  it('matches whole tokens in a market list too', () => {
    // 'du' is a UAE telecom and also the start of plenty of words.
    expect(guessCategory('Duplicate charge', 'AE')).not.toBe('home');
    expect(guessCategory('du bill', 'AE')).toBe('home');
  });
});
