import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';

const ReducedMotionContext = createContext(false);

/**
 * App-wide reduced-motion preference from the OS accessibility setting.
 *
 * It is deliberately local to the app tree rather than read ad hoc in every
 * component: animations need a synchronous boolean during render to choose
 * whether to mount loops/entrances at all.
 */
export function ReducedMotionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const value = useMemo(() => reduceMotion, [reduceMotion]);
  return <ReducedMotionContext.Provider value={value}>{children}</ReducedMotionContext.Provider>;
}

/** Returns true when the user asked the OS to reduce non-essential motion. */
export function useReducedMotion(): boolean {
  return useContext(ReducedMotionContext);
}
