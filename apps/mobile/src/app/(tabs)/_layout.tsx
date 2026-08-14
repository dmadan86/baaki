import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Tabs } from 'expo-router';

import { PillTabBar, type PillTabItem } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';

export default function TabsLayout() {
  const { t } = useStrings();
  const { animated } = useMotion();

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
      // The notifications inbox is a stacked route, not a tab screen, so it is
      // reached with a push rather than a tab navigate (handled in onSelect).
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

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Tabs hard-cut without this. Scenes shift-and-fade as you move between
        // them, which reads as the tabs sitting side by side rather than
        // stacking. Honours the app's own motion switch: somebody who turned
        // motion off gets the instant swap, not a jump they did not ask for.
        animation: animated ? 'shift' : 'none',
      }}
      tabBar={({ state, navigation }) => (
        <PillTabBar
          items={items}
          activeKey={state.routes[state.index]?.name ?? 'index'}
          onSelect={(key) => (key === 'inbox' ? router.push('/inbox') : navigation.navigate(key))}
          animated={animated}
        />
      )}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="friends" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
