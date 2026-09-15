/**
 * The trip rate, as a person reads and types it.
 *
 * The arithmetic is core's (`money/fx`, `money/fxPolicy`) and tested there. What
 * is tested here is the half that decides whether the number on the screen is
 * one anybody can check: which way round it is stated, how many places it
 * carries, and that turning the field around states the same fact rather than a
 * rounded copy of it.
 */

import { describe, expect, it } from 'vitest';

import { convert, money, rateFromDecimal } from '@waves/core';

import {
  homeFirstFor,
  rateFromTyped,
  rateLine,
  ratePlaces,
  shownText,
  tripRateFor,
} from '../src/lib/tripRates';

const VND_ROW = { from: 'VND', num: 32n, den: 10000n, source: 'manual' };
const USD_ROW = { from: 'USD', num: 9125n, den: 100n, source: 'ecb' };

describe('the rate a group has pinned', () => {
  it('is found by the currency the bill was paid in', () => {
    const rate = tripRateFor([VND_ROW, USD_ROW], 'USD', 'INR');
    expect(rate?.num).toBe(9125n);
    expect(rate?.to).toBe('INR');
  });

  it('is nothing at all for a pair the group has not pinned', () => {
    expect(tripRateFor([VND_ROW], 'THB', 'INR')).toBeNull();
  });

  it('is nothing for the group’s own currency, which needs no rate', () => {
    expect(tripRateFor([USD_ROW], 'INR', 'INR')).toBeNull();
  });

  it('survives a malformed row rather than taking the screen down', () => {
    expect(
      tripRateFor([{ from: 'VND', num: 0n, den: 0n, source: 'manual' }], 'VND', 'INR'),
    ).toBeNull();
  });
});

describe('a rate is stated the way somebody holds it', () => {
  it('turns a weak currency around: 1 rupee buys dong, not the other way', () => {
    const rate = tripRateFor([VND_ROW], 'VND', 'INR')!;
    // A rate that big carries no places: half a dong is not a fact about money.
    expect(rateLine(rate)).toBe('1 ₹ = ₫313');
    expect(homeFirstFor(rate)).toBe(true);
  });

  it('leaves a strong currency alone: 1 dollar is worth rupees', () => {
    const rate = tripRateFor([USD_ROW], 'USD', 'INR')!;
    expect(rateLine(rate)).toBe('1 $ = ₹91.25');
    expect(homeFirstFor(rate)).toBe(false);
  });

  it('carries the places the size of the number needs', () => {
    expect(ratePlaces(312.5)).toBe(0);
    expect(ratePlaces(91.25)).toBe(2);
    expect(ratePlaces(0.0032)).toBe(4);
  });
});

describe('typing a rate in either direction means the same rate', () => {
  it('reads "312 dong to the rupee" as a dong-to-rupee rate', () => {
    const typed = rateFromTyped('312', 'VND', 'INR', true)!;
    expect(typed.from).toBe('VND');
    expect(typed.to).toBe('INR');
    // ₫31,200,000 is ₹100,000 at that rate — dong carry no minor unit, rupees
    // carry paise, so the two sides of this are counted differently on purpose.
    expect(convert(money(31200000n, 'VND'), typed).minor).toBe(10000000n);
  });

  it('reads "91.25 rupees to the dollar" the other way round', () => {
    const typed = rateFromTyped('91.25', 'USD', 'INR', false)!;
    expect(convert(money(10000n, 'USD'), typed).minor).toBe(912500n);
  });

  it('is nothing for text that is not a rate', () => {
    expect(rateFromTyped('about 90', 'USD', 'INR', false)).toBeNull();
    expect(rateFromTyped('   ', 'USD', 'INR', false)).toBeNull();
  });

  it('rounds what it shows, which is why the editor carries the rate itself', () => {
    const rate = rateFromDecimal('91.25', 'USD', 'INR');
    expect(shownText(rate, false)).toBe('91.25');
    // Turned around, 1/91.25 is 0.010958…, and a field cannot hold that. What
    // is shown is a rounding, so reading the rate back out of the text would
    // lose a tenth of a percent every time somebody flipped the direction —
    // the reason `TripRateSheet` keeps the rate it already has and only uses
    // the text once the number is typed over.
    expect(shownText(rate, true)).toBe('0.011');
    const reparsed = rateFromTyped('0.011', 'USD', 'INR', true)!;
    expect(convert(money(10000n, 'USD'), reparsed).minor).not.toBe(912500n);
  });
});
