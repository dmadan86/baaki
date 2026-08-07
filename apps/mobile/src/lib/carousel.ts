/**
 * Where each card of a horizontal pager sits, in a layout that may run either
 * way.
 *
 * A paged `ScrollView` is the one place React Native's RTL mirroring stops
 * being free. The platform reverses the content itself, but what
 * `contentOffset.x` then *means* is not agreed on: iOS and Android differ from
 * each other, and react-native-web inherits whichever of three conventions the
 * browser uses for `scrollLeft` in an RTL box. Code that does
 * `scrollTo({ x: page * width })` is correct in exactly one of those worlds,
 * which is why the arrow on the onboarding tour could land on the wrong card
 * or on a half-scrolled gap between two.
 *
 * So the scroll container is pinned to LTR and the reversal is done here, in
 * arithmetic that is the same on every platform: page 0 is always the leftmost
 * strip of content, and in a right-to-left layout the first card is the one on
 * the right. Each card sets `direction: 'rtl'` on itself, so everything
 * *inside* it still mirrors the way it always did.
 */

/** Which page a card is on. Page 0 is always leftmost, whatever the direction. */
export function pageForSlide(slideIndex: number, count: number, rtl: boolean): number {
  if (!rtl) return slideIndex;
  return count - 1 - slideIndex;
}

/**
 * Which card is on a page. Its own inverse — reversing a list twice is the
 * list — which is what makes a drag and a tap on the arrow agree about which
 * card is showing.
 */
export function slideForPage(page: number, count: number, rtl: boolean): number {
  return pageForSlide(page, count, rtl);
}

/** The cards in the order they are laid out, first page first. */
export function pageOrder<T>(slides: readonly T[], rtl: boolean): { slide: T; index: number }[] {
  const withIndex = slides.map((slide, index) => ({ slide, index }));
  return rtl ? withIndex.reverse() : withIndex;
}
