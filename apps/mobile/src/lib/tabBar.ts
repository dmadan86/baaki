/**
 * The rules the root bottom bar follows, kept pure so they can be tested.
 *
 * The bar is rendered once over the whole navigation stack (see `AppTabBar`),
 * and two questions decide what it does on any given screen: should it show at
 * all, and which of the five destinations reads as current. Both are a function
 * of the route segments alone, so they live here away from the component.
 */

/**
 * Leaf or root route names the bar hides on: the full-screen camera and the
 * rise-from-bottom modals (which own their own footer actions), and the
 * signed-out screens, which are not part of the app proper.
 */
export const TAB_BAR_HIDDEN_ROUTES: ReadonlySet<string> = new Set([
  'welcome',
  'sign-in',
  'sign-up',
  'phone',
  'verify-email',
  'guest-welcome',
  'join',
  'language',
  'capture',
  'contact-picker',
  'scan',
  'new-group',
  'add-expense',
  'settle',
  'invite',
  'itemize',
  'voice',
  'paywall',
]);

export interface TabBarState {
  /** True when the bar should not render on this route at all. */
  readonly hidden: boolean;
  /**
   * The destination key that reads as current: one of the four tabs, or
   * 'inbox', or '' when nothing is current (inside a group, settings, etc.).
   */
  readonly activeKey: string;
}

export type TabBarRoute = '/' | '/friends' | '/activity' | '/inbox';

/**
 * The route a bottom-bar tap should navigate to, or null when the destination is
 * already current. The null is intentional: a repeated tap on the highlighted
 * tab should not schedule router work or rebuild the same scene.
 */
export function tabBarRouteForSelection(
  activeKey: string,
  selectedKey: string,
): TabBarRoute | null {
  if (selectedKey === activeKey) return null;

  switch (selectedKey) {
    case 'inbox':
      return '/inbox';
    case 'friends':
      return '/friends';
    case 'activity':
      return '/activity';
    default:
      return '/';
  }
}

/**
 * Resolve the bar's state from the current route segments.
 *
 * `signedOut` wins first: the bar belongs to the app proper, which needs a
 * session, so a person with no account never sees it — not on the auth screens,
 * and not on the one public page they can still reach signed-out (the privacy
 * policy, opened from the login legal line). Once they are in, that same privacy
 * page — now reached from Settings — keeps the bar like any other settings page.
 *
 * Then `hidden`: a modal or the camera or a signed-out screen shows no bar.
 * Otherwise the active destination is the tab inside the `(tabs)` group, or the
 * pushed inbox, or nothing when you are deeper in the app.
 */
export function resolveTabBar(segments: readonly string[], signedOut = false): TabBarState {
  if (signedOut) {
    return { hidden: true, activeKey: '' };
  }

  const root = segments[0] ?? '';
  const leaf = segments[segments.length - 1] ?? '';

  if (TAB_BAR_HIDDEN_ROUTES.has(root) || TAB_BAR_HIDDEN_ROUTES.has(leaf)) {
    return { hidden: true, activeKey: '' };
  }

  let activeKey = '';
  if (root === '(tabs)') activeKey = segments[1] ?? 'index';
  else if (root === 'inbox') activeKey = 'inbox';

  return { hidden: false, activeKey };
}
