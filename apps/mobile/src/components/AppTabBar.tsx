/**
 * The one bottom bar, shown on every screen — not just the tab screens.
 *
 * The five destinations live in the `(tabs)` group, but most of the app is
 * pushed on top of it (a group, a settings page, the inbox), and a bar that
 * only lived inside the tabs navigator vanished the moment you went anywhere.
 * This renders once at the root, over the whole navigation stack, so the bar
 * stays put wherever you are — WhatsApp keeps its bar the same way.
 *
 * It hides itself on the routes where a bar would be wrong: the full-screen
 * camera and the rise-from-bottom modals (which own their own footer actions),
 * and the signed-out screens, which are not part of the app proper.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useSegments } from 'expo-router';

import { PillTabBar, type PillTabItem } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';

/**
 * Leaf routes that present as a modal sheet or a full-screen capture, plus the
 * signed-out screens. The bar is suppressed on these — a modal brings its own
 * bottom actions, and the camera and sign-in fill the screen on purpose.
 */
const HIDE_ON = new Set([
  'sign-in',
  'join',
  'capture',
  'new-group',
  'add-expense',
  'settle',
  'invite',
  'itemize',
]);

export function AppTabBar() {
  const { t } = useStrings();
  const { animated } = useMotion();
  const segments = useSegments();

  const root = segments[0] ?? '';
  const leaf = segments[segments.length - 1] ?? '';
  if (HIDE_ON.has(root) || HIDE_ON.has(leaf)) return null;

  // Which destination reads as current. Inside the tabs group it is the tab
  // itself; the inbox is a pushed route but still one of the five, so it lights
  // its own icon. Everywhere else nothing is "current" — no pill, like WhatsApp
  // inside a chat.
  let activeKey = '';
  if (root === '(tabs)') activeKey = segments[1] ?? 'index';
  else if (root === 'inbox') activeKey = 'inbox';

  const items: PillTabItem[] = [
    {
      key: 'index',
      label: t.home,
      icon: (color) => <Ionicons name="home" size={20} color={color} />,
    },
    {
      key: 'friends',
      label: t.friends,
      icon: (color) => <Ionicons name="people" size={20} color={color} />,
    },
    {
      key: 'activity',
      label: t.activity,
      icon: (color) => <Ionicons name="pulse" size={20} color={color} />,
    },
    {
      key: 'inbox',
      label: t.tabs.inbox,
      icon: (color) => <Ionicons name="file-tray-outline" size={20} color={color} />,
    },
    {
      key: 'profile',
      label: t.profile,
      icon: (color) => <Ionicons name="person" size={20} color={color} />,
    },
  ];

  // The inbox is a stacked route, so it is pushed; the four tabs are navigated
  // to, which switches the tab rather than stacking a second copy. Home is the
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
      case 'profile':
        router.navigate('/profile');
        break;
      default:
        router.navigate('/');
    }
  };

  return <PillTabBar items={items} activeKey={activeKey} onSelect={go} animated={animated} />;
}
