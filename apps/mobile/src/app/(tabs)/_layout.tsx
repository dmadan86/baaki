import { Tabs } from 'expo-router';

/**
 * The four tab screens. The bottom bar itself is rendered once at the root
 * (`AppTabBar`) so it stays on every screen, not just these — so this navigator
 * hides its own bar and only owns the scene switching between the tabs.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // The root bar draws the navigation; this one would be a second copy.
        tabBarStyle: { display: 'none' },
        // No scene animation: a tab switch cuts straight to the destination.
        // The animated variants (shift, fade) translate/cross-fade the whole
        // scene, and on a busy tab that dropped frames and read as slow — an
        // instant switch is the fastest a tab can feel.
        animation: 'none',
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="friends" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
