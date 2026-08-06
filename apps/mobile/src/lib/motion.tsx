/**
 * Whether screens move.
 *
 * Transitions are not decoration: sliding a screen in from the right is what
 * tells you a push happened and where "back" is, and a modal rising from the
 * bottom is what says this is a thing you are on top of rather than somewhere
 * you have gone. Removing them entirely costs that, so the default is on.
 *
 * But they are also the first thing to hurt. Motion sickness and vestibular
 * disorders are real, the phone already has a switch for it, and an app that
 * ignores that switch is an app somebody has to stop using. So the OS setting
 * is the default rather than a suggestion, and this preference exists to
 * override it in either direction — including turning motion off on a phone
 * that never asked, which is also how you make an old device feel quick.
 *
 * TDR §11 treats accessibility settings as inputs, not hints.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AccessibilityInfo } from 'react-native';

const KEY = 'baaki.animations_enabled';

interface MotionValue {
  /** Whether screen transitions should play. */
  animated: boolean;
  /** True while the stored preference is still being read. */
  loading: boolean;
  /** What the phone's own accessibility setting says, for explaining the default. */
  systemReducesMotion: boolean;
  /** Null puts it back under the system setting's control. */
  setAnimated: (value: boolean | null) => Promise<void>;
  /** Whether the person has overridden the system setting. */
  overridden: boolean;
}

const MotionContext = createContext<MotionValue | null>(null);

export function MotionProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<boolean | null>(null);
  const [systemReducesMotion, setSystemReducesMotion] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void (async () => {
      const [saved, reduce] = await Promise.all([
        AsyncStorage.getItem(KEY).catch(() => null),
        AccessibilityInfo.isReduceMotionEnabled().catch(() => false),
      ]);
      if (!active) return;
      setStored(saved === null ? null : saved === 'true');
      setSystemReducesMotion(reduce);
      setLoading(false);
    })();

    // The switch can be flipped while the app is open, and somebody who reaches
    // for it mid-session is exactly the person who needs it to take effect now.
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setSystemReducesMotion,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const setAnimated = useCallback(async (value: boolean | null) => {
    setStored(value);
    if (value === null) await AsyncStorage.removeItem(KEY).catch(() => undefined);
    else await AsyncStorage.setItem(KEY, String(value)).catch(() => undefined);
  }, []);

  const value = useMemo<MotionValue>(
    () => ({
      animated: stored ?? !systemReducesMotion,
      loading,
      systemReducesMotion,
      setAnimated,
      overridden: stored !== null,
    }),
    [stored, systemReducesMotion, loading, setAnimated],
  );

  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionValue {
  const value = useContext(MotionContext);
  if (!value) throw new Error('useMotion must be used inside MotionProvider');
  return value;
}

/** How long a transition runs. Short enough to feel like a response, not a scene. */
export const TRANSITION_MS = 260;
