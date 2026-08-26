/**
 * The app's motion, in one place.
 *
 * Motion is a response, not a scene: entrances are short, the count keeps to
 * well under a second, and a press answers under the finger. The animations
 * always play — there is no preference gating them off.
 *
 * The pure maths lives at the bottom, exported, because a count that lands on
 * the wrong number or a stagger that never stops is a bug you want to catch in
 * a test rather than by watching the screen.
 */

import { type ReactNode } from 'react';
import { Pressable, type PressableProps, type ViewStyle } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';

import { useReducedMotion } from './reducedMotion';
import { staggerDelay } from './motionMath';

export { easeOutCubic, lerpBig, MAX_SAFE_MINOR, staggerDelay } from './motionMath';

/** How long a screen transition runs. Short enough to feel like a response,
    not a scene — used by the navigator's `animationDuration`. */
export const TRANSITION_MS = 260;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** The spring a press answers with: quick, barely overshooting, back to rest. */
const PRESS_SPRING = { damping: 18, stiffness: 280, mass: 0.5 } as const;

/**
 * A list item that arrives rather than appears.
 *
 * Each card fades up a beat after the one above it (`staggerDelay`), which is
 * what makes a list read as one thing settling into place instead of a block
 * that blinks on. The delay is capped, so a long list finishes rather than
 * dribbling in for a second and a half.
 *
 * The entrance plays once, when the row mounts — a data refetch that keeps the
 * same keys does not remount, so the list does not re-stagger every pull.
 */
export function Stagger({ index = 0, children }: { index?: number; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <Animated.View
      entering={reduceMotion ? undefined : FadeInDown.duration(340).delay(staggerDelay(index))}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A pressable that dips under the finger.
 *
 * Replaces the flat opacity blink with a spring scale, which is the difference
 * between a card that registers a tap and one that feels like a button.
 */
export function PressableScale({
  children,
  style,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style'> & { children: ReactNode; style?: ViewStyle }) {
  const reduceMotion = useReducedMotion();
  // `.get()`/`.set()` rather than `.value`: the same shared value, through the
  // method API Reanimated 4 added — a call, not an assignment to a property the
  // React compiler treats as immutable and refuses inside a handler.
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  return (
    <AnimatedPressable
      style={[animatedStyle, style]}
      onPressIn={(event) => {
        if (!reduceMotion) scale.set(withSpring(0.96, PRESS_SPRING));
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (!reduceMotion) scale.set(withSpring(1, PRESS_SPRING));
        onPressOut?.(event);
      }}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}

/**
 * The detail screen a card opens onto, arriving as if it grew from the tap.
 *
 * Reanimated 4 dropped the shared-element transition tag, so this is not a
 * literal morph of the card into the screen — it is the screen's own content
 * springing up from just under full size while it fades in, which reads as an
 * opening rather than a slide. Paired with `PressableScale` on the card that
 * launched it, the tap and the arrival belong to each other.
 */
export function DetailEnter({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const reduceMotion = useReducedMotion();
  return (
    <Animated.View
      style={[{ flex: 1 }, style]}
      entering={reduceMotion ? undefined : detailEntering}
    >
      {children}
    </Animated.View>
  );
}

/**
 * The open, as a declarative entrance rather than a mount effect: content starts
 * a shade under full size and transparent, then springs up and fades in. Written
 * this way — a worklet Reanimated runs on the UI thread — so nothing here mutates
 * a value from an effect, which the screen never needed and the linter rightly
 * refuses.
 */
const detailEntering: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.97 }] },
    animations: {
      opacity: withTiming(1, { duration: 220 }),
      transform: [{ scale: withSpring(1, { damping: 20, stiffness: 200 }) }],
    },
  };
};
