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
        // the splash, and `freezeOnBlur` keeps the pre-mounted tabs from
        // re-rendering while off-screen.
        lazy: false,
        // Suspend an off-screen tab's re-rendering while it is blurred
        // (react-freeze), so a background tab does not re-render and repaint
        // while the foreground tab is the one being used. This freezes rendering
        // only — a tab's effects, timers and subscriptions keep running. Combined
        // with `lazy: false` this is the WhatsApp shape: mounted once, its
        // rendering frozen while away, resumed on return — which is instant, no
        // rebuild.
        freezeOnBlur: true,
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="friends" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="me" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
