import { describe, expect, it } from 'vitest';

import { resolveTabBar, tabBarRouteForSelection } from '../src/lib/tabBar';

describe('tabBarRouteForSelection', () => {
  it('does not navigate when the selected tab is already active', () => {
    expect(tabBarRouteForSelection('index', 'index')).toBeNull();
    expect(tabBarRouteForSelection('friends', 'friends')).toBeNull();
    expect(tabBarRouteForSelection('activity', 'activity')).toBeNull();
  });

  it('maps inactive tab selections to their routes', () => {
    expect(tabBarRouteForSelection('friends', 'index')).toBe('/');
    expect(tabBarRouteForSelection('index', 'friends')).toBe('/friends');
    expect(tabBarRouteForSelection('index', 'activity')).toBe('/activity');
    expect(tabBarRouteForSelection('index', 'me')).toBe('/me');
  });
});

describe('resolveTabBar', () => {
  it('lights the current tab inside the tabs group', () => {
    expect(resolveTabBar(['(tabs)', 'index'])).toEqual({ hidden: false, activeKey: 'index' });
    expect(resolveTabBar(['(tabs)', 'friends'])).toEqual({ hidden: false, activeKey: 'friends' });
    expect(resolveTabBar(['(tabs)', 'activity'])).toEqual({ hidden: false, activeKey: 'activity' });
    expect(resolveTabBar(['(tabs)', 'me'])).toEqual({ hidden: false, activeKey: 'me' });
  });

  it('defaults to home when the tabs group has no leaf yet', () => {
    expect(resolveTabBar(['(tabs)'])).toEqual({ hidden: false, activeKey: 'index' });
  });

  it('shows the bar with nothing current deeper in the app', () => {
    expect(resolveTabBar(['group', '[id]'])).toEqual({ hidden: false, activeKey: '' });
    expect(resolveTabBar(['settings', 'notifications'])).toEqual({ hidden: false, activeKey: '' });
    expect(resolveTabBar(['captures'])).toEqual({ hidden: false, activeKey: '' });
  });

  it('does not light the removed account tab even when on it', () => {
    // The profile screen still exists and is reached from the header avatar,
    // but it is no longer a bar destination, so nothing lights.
    const state = resolveTabBar(['(tabs)', 'profile']);
    expect(state.hidden).toBe(false);
    expect(['index', 'friends', 'activity', 'me']).not.toContain(state.activeKey);
  });

  it('hides on the full-screen camera and the signed-out screens', () => {
    expect(resolveTabBar(['capture']).hidden).toBe(true);
    expect(resolveTabBar(['welcome']).hidden).toBe(true);
    expect(resolveTabBar(['sign-in']).hidden).toBe(true);
    expect(resolveTabBar(['sign-up']).hidden).toBe(true);
    expect(resolveTabBar(['phone']).hidden).toBe(true);
    expect(resolveTabBar(['verify-email']).hidden).toBe(true);
    expect(resolveTabBar(['guest-welcome']).hidden).toBe(true);
    expect(resolveTabBar(['join']).hidden).toBe(true);
    expect(resolveTabBar(['language']).hidden).toBe(true);
    expect(resolveTabBar(['new-group']).hidden).toBe(true);
    expect(resolveTabBar(['paywall']).hidden).toBe(true);
  });

  it('hides on the rise-from-bottom modals nested under a group', () => {
    expect(resolveTabBar(['group', '[id]', 'add-expense']).hidden).toBe(true);
    expect(resolveTabBar(['group', '[id]', 'settle']).hidden).toBe(true);
    expect(resolveTabBar(['group', '[id]', 'invite']).hidden).toBe(true);
    expect(resolveTabBar(['group', '[id]', 'itemize']).hidden).toBe(true);
  });

  it('keeps the bar on non-modal group sub-screens', () => {
    expect(resolveTabBar(['group', '[id]', 'members']).hidden).toBe(false);
    expect(resolveTabBar(['group', '[id]', 'settings']).hidden).toBe(false);
  });

  it('treats an empty segment list as the resting home state', () => {
    expect(resolveTabBar([])).toEqual({ hidden: false, activeKey: '' });
  });
});
