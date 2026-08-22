/**
 * Arms the quick shortcut's two triggers around the app it wraps:
 *
 *  - a two-finger double-tap anywhere (the iOS "Magic Tap" gesture) — two
 *    fingers, so it never fires on an ordinary tap on a button or a list row;
 *  - the app-icon shortcut — both a cold launch from it and a tap on it while
 *    the app is already open.
 *
 * Both call the same `run()` from the shortcut store, which performs whatever
 * action the user chose. The gesture is only armed when the setting is on and an
 * action is chosen, so the wrapper is inert by default and costs nothing.
 */

import { useEffect } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { useShortcut } from '@/lib/shortcut';
import { initialQuickAction, onQuickAction, QUICK_ACTION_ID } from '@/lib/quickActions';

export function ShortcutGesture({ children }: { children: React.ReactNode }) {
  const { run, action, doubleTap } = useShortcut();
  const armed = doubleTap && action !== 'off';

  // The app-icon shortcut: a cold launch from it, and taps on it while running.
  // Independent of the gesture toggle — choosing an action is opting into the
  // icon menu, and turning the double-tap off should not silence the icon.
  useEffect(() => {
    if (action === 'off') return;
    if (initialQuickAction() === QUICK_ACTION_ID) run();
    return onQuickAction((id) => {
      if (id === QUICK_ACTION_ID) run();
    });
  }, [action, run]);

  const tap = Gesture.Tap()
    .enabled(armed)
    .minPointers(2)
    .numberOfTaps(2)
    // Callbacks on the JS thread so `run()` can navigate directly.
    .runOnJS(true)
    .onEnd(() => run());

  return <GestureDetector gesture={tap}>{children}</GestureDetector>;
}
