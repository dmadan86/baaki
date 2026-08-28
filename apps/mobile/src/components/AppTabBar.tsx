/**
 * The one bottom bar, shown on every screen — not just the tab screens.
 *
 * The destinations live in the `(tabs)` group, but most of the app is pushed on
 * top of it (a group, a settings page, the inbox), and a bar that only lived
 * inside the tabs navigator vanished the moment you went anywhere. This renders
 * once at the root, over the whole navigation stack, so the bar stays put
 * wherever you are — WhatsApp keeps its bar the same way.
 *
 * It hides itself on the routes where a bar would be wrong (see `resolveTabBar`):
 * the full-screen camera and the rise-from-bottom modals, and the signed-out
 * screens. The account is reached from the header avatar rather than a tab, so
 * it is not one of the bar's destinations.
 */

import { useCallback, useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useGlobalSearchParams, useSegments } from 'expo-router';

import { iconSize, PillTabBar, type PillTabAction, type PillTabItem } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { resolveTabBar, tabBarRouteForSelection } from '@/lib/tabBar';

/** Renders the persistent bottom navigation bar and routes tab selections without stacking duplicates. */
export function AppTabBar() {
  const { t } = useStrings();
  const { session } = useAuth();
  // `useSegments` is typed as a union of fixed-length route tuples, so indexing
  // past the first element trips the tuple bounds check under the CI tsconfig.
  // We only ever read positions generically, so widen to a plain string array.
  const segments = useSegments() as readonly string[];
  // When the bar is showing over a group's own screens, the mic should speak
  // *into that group*, not the unassigned inbox. `useSegments` gives the route
  // shape (`group/[id]/…`); the id's value comes from the focused route's
  // params. Any non-group screen leaves this null and the mic opens plain.
  const params = useGlobalSearchParams<{ id?: string }>();
  const groupId = segments[0] === 'group' && typeof params.id === 'string' ? params.id : null;

  // No session means no bar anywhere — the privacy page opened from the login
  // legal line is the one place it used to leak onto a signed-out screen.
  const { hidden, activeKey } = resolveTabBar(segments, !session);

  const items = useMemo<PillTabItem[]>(
    () => [
      {
        key: 'index',
        label: t.home,
        icon: (color) => <Ionicons name="home" size={iconSize.lg} color={color} />,
      },
      {
        key: 'friends',
        label: t.friends,
        icon: (color) => <Ionicons name="people" size={iconSize.lg} color={color} />,
      },
      {
        key: 'activity',
        label: t.activity,
        icon: (color) => <Ionicons name="pulse" size={iconSize.lg} color={color} />,
      },
      {
        key: 'me',
        label: t.personal.tab,
        icon: (color) => <Ionicons name="wallet-outline" size={iconSize.lg} color={color} />,
      },
    ],
    [t.activity, t.friends, t.home, t.personal.tab],
  );

  // All bar destinations are tabs now. `navigate` switches to the existing tab
  // route instead of stacking a second copy; tapping the active tab is a no-op
  // so repeated taps do not schedule redundant router work.
  const go = useCallback(
    (key: string): void => {
      const route = tabBarRouteForSelection(activeKey, key);
      if (route) router.navigate(route);
    },
    [activeKey],
  );

  // The raised mic: speak an expense from anywhere the bar is showing. The
  // button is a black circle, so the mic wears the on-brand (white) colour the
  // bar hands it.
  const voice = useMemo<PillTabAction>(
    () => ({
      accessibilityLabel: t.voice.speakExpense,
      onPress: () =>
        router.push(groupId ? { pathname: '/voice', params: { group: groupId } } : '/voice'),
      icon: (color: string) => <Ionicons name="mic" size={iconSize.lg} color={color} />,
    }),
    [groupId, t.voice.speakExpense],
  );

  if (hidden) return null;

  return (
    <PillTabBar items={items} activeKey={activeKey} onSelect={go} animated centerAction={voice} />
  );
}
