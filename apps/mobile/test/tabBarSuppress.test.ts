import { afterEach, describe, expect, it } from 'vitest';

import {
  resetTabBarSuppression,
  suppressTabBar,
  tabBarSuppressedSnapshot,
} from '@/lib/tabBarSuppress';

describe('tabBar suppression claims', () => {
  afterEach(() => {
    resetTabBarSuppression();
  });

  it('keeps the bar suppressed until every claimant releases', () => {
    const releaseSelection = suppressTabBar();
    const releaseSheet = suppressTabBar();

    expect(tabBarSuppressedSnapshot()).toBe(true);
    releaseSelection();
    expect(tabBarSuppressedSnapshot()).toBe(true);
    releaseSheet();
    expect(tabBarSuppressedSnapshot()).toBe(false);
  });

  it('makes release idempotent, so cleanup can run twice safely', () => {
    const release = suppressTabBar();

    release();
    release();

    expect(tabBarSuppressedSnapshot()).toBe(false);
  });

  it('forgets every outstanding claim', () => {
    suppressTabBar();
    suppressTabBar();

    resetTabBarSuppression();

    expect(tabBarSuppressedSnapshot()).toBe(false);
  });
});
