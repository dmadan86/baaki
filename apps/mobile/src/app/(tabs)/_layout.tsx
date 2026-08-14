import { Tabs } from 'expo-router';

import { useMotion } from '@/lib/motion';

/**
 * The four tab screens. The bottom bar itself is rendered once at the root
 * (`AppTabBar`) so it stays on every screen, not just these — so this navigator
 * hides its own bar and only owns the scene switching between the tabs.
 */
export default function TabsLayout() {
  const { animated } = useMotion();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // The root bar draws the navigation; this one would be a second copy.
        tabBarStyle: { display: 'none' },
        // Tabs hard-cut without this. Scenes shift-and-fade as you move between
        // them, honouring the app's motion switch.
        animation: animated ? 'shift' : 'none',
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="friends" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
