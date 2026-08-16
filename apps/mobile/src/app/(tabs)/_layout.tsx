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
        // Tabs hard-cut without this. A plain cross-fade rather than 'shift':
        // shift slides each scene sideways as well as fading it, and that
        // horizontal translate is the heaviest work in the tab path — on a busy
        // tab (the dashboard) it drops frames and the switch reads as sluggish.
        // Fade keeps a soft transition for the motion switch at a fraction of
        // the cost; 'none' when motion is off.
        animation: animated ? 'fade' : 'none',
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="friends" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
