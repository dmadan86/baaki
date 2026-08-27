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
        // Mount every tab up front instead of building it the first time it is
        // focused. Lazy tabs (the default) construct the whole screen tree on
        // first tap — the few-hundred-ms lag before the destination paints, the
        // thing that reads as sluggish next to WhatsApp. WhatsApp keeps all of
        // its tabs mounted, so a tap is a pure visibility swap; this does the
        // same. The cost is a little more work at cold start, paid once behind
        // the splash, and `freezeOnBlur` keeps the pre-mounted tabs idle so they
        // do not burn the JS thread while off-screen.
        lazy: false,
        // Suspend an off-screen tab's rendering while it is blurred, so its
        // queries and realtime subscriptions stop competing for the JS thread
        // with the foreground tab's paint. Combined with `lazy: false` this is
        // the WhatsApp shape: mounted once, frozen while away, unfrozen on
        // return — which is instant, no rebuild.
        freezeOnBlur: true,
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="friends" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
