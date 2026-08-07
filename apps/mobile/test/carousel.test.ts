/**
 * The paged tour, in a layout that may run either way.
 *
 * The bug this is about is not visible in a screenshot of the first card: the
 * pager opens on the right one, and only the arrow lands somewhere wrong. So
 * the arithmetic is pulled out of the component and checked here, rather than
 * left to be found on a device nobody has.
 */

import { describe, expect, it } from 'vitest';

import { pageForSlide, pageOrder, slideForPage } from '../src/lib/carousel';

const SLIDES = ['a', 'b', 'c'] as const;

describe('paging a tour', () => {
  it('changes nothing left to right', () => {
    expect(SLIDES.map((_, index) => pageForSlide(index, 3, false))).toEqual([0, 1, 2]);
    expect(pageOrder(SLIDES, false).map((entry) => entry.slide)).toEqual(['a', 'b', 'c']);
  });

  it('puts the first card on the right, right to left', () => {
    expect(SLIDES.map((_, index) => pageForSlide(index, 3, true))).toEqual([2, 1, 0]);
    expect(pageOrder(SLIDES, true).map((entry) => entry.slide)).toEqual(['c', 'b', 'a']);
  });

  it('keeps the original index with each card, so the words still match', () => {
    // Reversing the array and then using the array position as the index is
    // how the third card gets the first card's paragraph.
    expect(pageOrder(SLIDES, true)).toEqual([
      { slide: 'c', index: 2 },
      { slide: 'b', index: 1 },
      { slide: 'a', index: 0 },
    ]);
  });

  it('is its own inverse, so a drag and the arrow agree', () => {
    for (const rtl of [false, true]) {
      for (let index = 0; index < 3; index += 1) {
        expect(slideForPage(pageForSlide(index, 3, rtl), 3, rtl), `${rtl} ${index}`).toBe(index);
      }
    }
  });

  it('advances the card the arrow means, not the page next to it', () => {
    // Right to left, "next" moves the scroll position *backwards*. Reading the
    // page number as the card number is what made the arrow on card one jump
    // to card three.
    expect(pageForSlide(1, 3, true)).toBe(1);
    expect(pageForSlide(2, 3, true)).toBe(0);
    expect(slideForPage(0, 3, true)).toBe(2);
  });

  it('handles a single card without inventing a second', () => {
    expect(pageForSlide(0, 1, true)).toBe(0);
    expect(pageOrder(['only'], true)).toEqual([{ slide: 'only', index: 0 }]);
  });

  it('does not modify the list it is given', () => {
    const slides = ['a', 'b', 'c'];
    pageOrder(slides, true);
    expect(slides).toEqual(['a', 'b', 'c']);
  });
});
