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

  it('covers everyday food, grocery, and shopping descriptions', () => {
    expect(guessIcon('Fresh juice')).toBe('nutrition-outline');
    expect(guessIcon('Sushi dinner')).toBe('fish-outline');
    expect(guessIcon('Zomato rolls')).toBe('fast-food-outline');
    expect(guessIcon('Blinkit milk and atta')).toBe('basket-outline');
    // A grocery run outranks the generic fruit word — a basket, not nutrition.
    expect(guessIcon('Blinkit fruits')).toBe('basket-outline');
    expect(guessIcon('Fresh fruit')).toBe('basket-outline');
    // …while a drink stays with the nutrition glyph.
    expect(guessIcon('Orange juice')).toBe('nutrition-outline');
    expect(guessIcon('Nykaa order')).toBe('bag-handle-outline');
    expect(guessIcon('Shoes laundry')).toBe('shirt-outline');
  });

  it('covers travel, stay, and local commute descriptions', () => {
    expect(guessIcon('Akasa flight')).toBe('airplane-outline');
    expect(guessIcon('Petrol and toll')).toBe('speedometer-outline');
    expect(guessIcon('Airport namma yatri')).toBe('car-outline');
    expect(guessIcon('Parking at mall')).toBe('location-outline');
    expect(guessIcon('Treebo guesthouse checkin')).toBe('bed-outline');
    expect(guessIcon('Flat society deposit')).toBe('business-outline');
  });

  it('covers entertainment, home, health, and gifts', () => {
    expect(guessIcon('Hotstar subscription')).toBe('tv-outline');
    expect(guessIcon('Museum sightseeing')).toBe('camera-outline');
    expect(guessIcon('Rent deposit')).toBe('home-outline');
    expect(guessIcon('Maid cook payment')).toBe('people-outline');
    expect(guessIcon('Lab scan')).toBe('flask-outline');
    expect(guessIcon('Charity donation')).toBe('heart-outline');
    expect(guessIcon('Birthday shagun')).toBe('gift-outline');
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
