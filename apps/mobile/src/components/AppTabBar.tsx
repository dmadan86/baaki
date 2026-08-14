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

import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useSegments } from 'expo-router';

import { iconSize, PillTabBar, type PillTabItem } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';
import { resolveTabBar } from '@/lib/tabBar';

export function AppTabBar() {
  const { t } = useStrings();
  const { animated } = useMotion();
  // `useSegments` is typed as a union of fixed-length route tuples, so indexing
  // past the first element trips the tuple bounds check under the CI tsconfig.
  // We only ever read positions generically, so widen to a plain string array.
  const segments = useSegments() as readonly string[];

  const { hidden, activeKey } = resolveTabBar(segments);
  if (hidden) return null;

  const items: PillTabItem[] = [
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
      key: 'inbox',
      label: t.tabs.inbox,
      icon: (color) => <Ionicons name="file-tray-outline" size={iconSize.lg} color={color} />,
    },
  ];

  // The inbox is a stacked route, so it is pushed; the tabs are navigated to,
  // which switches the tab rather than stacking a second copy. Home is the
  // group's default route, reached at '/'.
  const go = (key: string): void => {
    switch (key) {
      case 'inbox':
        router.push('/inbox');
        break;
      case 'friends':
        router.navigate('/friends');
        break;
      case 'activity':
        router.navigate('/activity');
        break;
      default:
        router.navigate('/');
    }
  };

  return <PillTabBar items={items} activeKey={activeKey} onSelect={go} animated={animated} />;
}
