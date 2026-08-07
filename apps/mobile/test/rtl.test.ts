/**
 * Right-to-left, and the one thing React Native will not do for you.
 *
 * RN mirrors more than it gets credit for. With `doLeftAndRightSwapInRTL` —
 * true by default — it swaps `left`/`right` in styles, reverses
 * `flexDirection: 'row'` and flips `textAlign`. The `marginLeft`s scattered
 * through this app are not RTL bugs, and rewriting them all to `marginStart`
 * would have been churn that changed nothing.
 *
 * An icon is content, not layout, so nothing flips it. `chevron-forward` keeps
 * pointing right in a screen that now runs the other way, which is how "next"
 * ends up pointing backwards. That is what these tests are about.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The design system reaches for react-native only to read `I18nManager.isRTL`
// as its starting value; the app overrides it at launch from the phone's
// language. Stubbing it keeps this a pure test.
vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

const { directionalIcon, isRtlLayout, setLayoutDirection } =
  await import('../../../packages/ui/src/direction');

describe('mirroring an icon', () => {
  beforeEach(() => setLayoutDirection(false));

  it('changes nothing at all left to right', () => {
    setLayoutDirection(false);
    expect(directionalIcon('chevron-forward')).toBe('chevron-forward');
    expect(directionalIcon('chevron-back')).toBe('chevron-back');
    expect(directionalIcon('arrow-forward')).toBe('arrow-forward');
  });

  it('turns every arrow around right to left', () => {
    setLayoutDirection(true);
    expect(directionalIcon('chevron-forward')).toBe('chevron-back');
    expect(directionalIcon('chevron-back')).toBe('chevron-forward');
    expect(directionalIcon('arrow-forward')).toBe('arrow-back');
    expect(directionalIcon('arrow-forward-circle')).toBe('arrow-back-circle');
    expect(directionalIcon('caret-forward')).toBe('caret-back');
  });

  it('mirrors the outline and circle variants too', () => {
    // Missing one of these is how a single chevron on a single screen keeps
    // pointing the wrong way and nobody notices for a release.
    setLayoutDirection(true);
    expect(directionalIcon('chevron-forward-outline')).toBe('chevron-back-outline');
    expect(directionalIcon('chevron-back-circle')).toBe('chevron-forward-circle');
    expect(directionalIcon('arrow-back-circle-outline')).toBe('arrow-forward-circle-outline');
  });

  it('leaves alone the icons that mean the same in both directions', () => {
    // A blanket "flip anything with a direction in its name" turns an up arrow
    // into nonsense, and a tick into a different tick.
    setLayoutDirection(true);
    for (const icon of [
      'arrow-up',
      'arrow-up-circle-outline',
      'arrow-down',
      'checkmark',
      'camera-outline',
      'close',
      'trash-outline',
    ]) {
      expect(directionalIcon(icon), icon).toBe(icon);
    }
  });

  it('is its own inverse', () => {
    setLayoutDirection(true);
    for (const icon of ['chevron-forward', 'arrow-back', 'caret-forward-outline']) {
      expect(directionalIcon(directionalIcon(icon)), icon).toBe(icon);
    }
  });

  it('reports the direction it was told', () => {
    setLayoutDirection(true);
    expect(isRtlLayout()).toBe(true);
    setLayoutDirection(false);
    expect(isRtlLayout()).toBe(false);
  });
});
