import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';

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
      key: 'profile',
      label: t.profile,
      icon: (color) => <Ionicons name="person" size={20} color={color} />,
    },
  ];

  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={({ state, navigation }) => (
        <PillTabBar
          items={items}
          activeKey={state.routes[state.index]?.name ?? 'index'}
          onSelect={(key) => navigation.navigate(key)}
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
