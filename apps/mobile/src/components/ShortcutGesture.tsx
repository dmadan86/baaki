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

import { useEffect, useRef } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { useShortcut } from '@/lib/shortcut';
import { initialQuickAction, onQuickAction, QUICK_ACTION_ID } from '@/lib/quickActions';

export function ShortcutGesture({ children }: { children: React.ReactNode }) {
  const { run, action, doubleTap, loading } = useShortcut();
  const armed = doubleTap && action !== 'off';

  // The cold-launch icon shortcut, consumed exactly once and only after the
  // stored action has loaded (so `run` reads the right action, not the default).
  // `initialQuickAction()` stays set for the process, so without this guard
  // changing the action in Settings — which used to re-run this effect — would
  // fire it again.
  const consumedInitial = useRef(false);
  useEffect(() => {
    if (loading || consumedInitial.current) return;
    if (initialQuickAction() === QUICK_ACTION_ID) {
      consumedInitial.current = true;
      run();
    }
  }, [loading, run]);

  // Taps on the icon shortcut while the app is already open — registered once
  // (run is stable), independent of the cold-launch guard above.
  useEffect(
    () =>
      onQuickAction((id) => {
        if (id === QUICK_ACTION_ID) run();
      }),
    [run],
  );

  const tap = Gesture.Tap()
    .enabled(armed)
    .minPointers(2)
    .numberOfTaps(2)
    // Callbacks on the JS thread so `run()` can navigate directly.
    .runOnJS(true)
    .onEnd(() => run());

  return <GestureDetector gesture={tap}>{children}</GestureDetector>;
}
