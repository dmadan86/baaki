/**
 * The specific-icon guess follows the same rules as the category guess: whole
 * words only, deterministic, a real null when it has nothing to say — and the
 * ordering promise that a more specific reading beats the general one it sits
 * above.
 */

import { describe, expect, it } from 'vitest';

import { guessIcon } from '../src/category/icons.js';

describe('guessIcon', () => {
  it('draws the specific thing a person typed', () => {
    expect(guessIcon('Morning coffee')).toBe('cafe-outline');
    expect(guessIcon('Chai and vada')).toBe('cafe-outline');
    expect(guessIcon('Breakfast at the hostel')).toBe('egg-outline');
    expect(guessIcon('Bike ride to the point')).toBe('bicycle-outline');
    expect(guessIcon('Flight to Hanoi')).toBe('airplane-outline');
    expect(guessIcon('Dinner')).toBe('restaurant-outline');
    expect(guessIcon('Movie night')).toBe('film-outline');
    expect(guessIcon('Gym membership')).toBe('barbell-outline');
  });

  it('prefers the specific reading over the general one below it', () => {
    // "car rental" must be the sportier car, not the plain cab that follows it.
    expect(guessIcon('Car rental for the trip')).toBe('car-sport-outline');
    expect(guessIcon('Cab to airport')).toBe('car-outline');
    // "breakfast" outranks a "coffee" in the same line (egg sits above cafe).
    expect(guessIcon('Breakfast coffee')).toBe('egg-outline');
  });

  it('matches whole words, never substrings', () => {
    // 'car' inside 'carton', 'bar' inside 'barber' — neither should hit.
    expect(guessIcon('Carton of juice')).not.toBe('car-outline');
    expect(guessIcon('Barber shop')).not.toBe('wine-outline');
  });

  it('returns null when it has nothing to say, so the caller keeps the category icon', () => {
    expect(guessIcon('Miscellaneous')).toBeNull();
    expect(guessIcon('')).toBeNull();
    expect(guessIcon(null)).toBeNull();
    expect(guessIcon(undefined)).toBeNull();
  });

  it('is case-insensitive and Unicode-safe', () => {
    expect(guessIcon('COFFEE')).toBe('cafe-outline');
    expect(guessIcon('Coffee ☕ break')).toBe('cafe-outline');
  });
});
