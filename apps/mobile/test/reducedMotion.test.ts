import { describe, expect, it } from 'vitest';

import { shouldApplyInitialReducedMotionPreference } from '../src/lib/reducedMotionState';

describe('shouldApplyInitialReducedMotionPreference', () => {
  it('uses the initial OS query while the provider is mounted and no event arrived', () => {
    expect(shouldApplyInitialReducedMotionPreference(true, false)).toBe(true);
  });

  it('ignores the initial query after a newer change event arrives first', () => {
    expect(shouldApplyInitialReducedMotionPreference(true, true)).toBe(false);
  });

  it('ignores the initial query after unmount', () => {
    expect(shouldApplyInitialReducedMotionPreference(false, false)).toBe(false);
  });
});
