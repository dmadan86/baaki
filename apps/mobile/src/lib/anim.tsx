/**
 * The app's motion, in one place and behind one switch.
 *
 * Every primitive here reads `useMotion()` and does nothing when it says off —
 * so a phone with reduce-motion set, or somebody who turned animation off in
 * settings, gets the same still screens they asked for and none of this runs.
 * Motion is a response, not a scene (see `lib/motion`): entrances are short,
 * the count keeps to well under a second, and a press answers under the finger.
 *
 * The pure maths lives at the bottom, exported, because a count that lands on
 * the wrong number or a stagger that never stops is a bug you want to catch in
 * a test rather than by watching the screen.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, type PressableProps, type ViewStyle } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';

import { MoneyText, type MoneyTextProps } from '@waves/ui';

import { useMotion } from './motion';
import { easeOutCubic, lerpBig, MAX_SAFE_MINOR, staggerDelay } from './motionMath';

export { easeOutCubic, lerpBig, MAX_SAFE_MINOR, staggerDelay } from './motionMath';

/** Whether motion should play at all. The one gate every primitive here reads. */
export function useMotionEnabled(): boolean {
  return useMotion().animated;
}

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
  const enabled = useMotionEnabled();
  if (!enabled) return <>{children}</>;
  return (
    <Animated.View entering={FadeInDown.duration(340).delay(staggerDelay(index))}>
      {children}
    </Animated.View>
  );
}

/**
 * A pressable that dips under the finger.
 *
 * Replaces the flat opacity blink with a spring scale, which is the difference
 * between a card that registers a tap and one that feels like a button. With
 * motion off it falls back to the same opacity feedback the rest of the app
 * uses, so nothing loses its "I heard you" — only the movement goes.
 */
export function PressableScale({
  children,
  style,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style'> & { children: ReactNode; style?: ViewStyle }) {
  const enabled = useMotionEnabled();
  // `.get()`/`.set()` rather than `.value`: the same shared value, through the
  // method API Reanimated 4 added — a call, not an assignment to a property the
  // React compiler treats as immutable and refuses inside a handler.
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  if (!enabled) {
    return (
      <Pressable
        style={({ pressed }) => [style, { opacity: pressed ? 0.9 : 1 }]}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        {...rest}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <AnimatedPressable
      style={[animatedStyle, style]}
      onPressIn={(event) => {
        scale.set(withSpring(0.96, PRESS_SPRING));
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scale.set(withSpring(1, PRESS_SPRING));
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
  const enabled = useMotionEnabled();
  return (
    <Animated.View style={[{ flex: 1 }, style]} entering={enabled ? detailEntering : undefined}>
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

/**
 * A money value that rolls up to its figure instead of printing at once.
 *
 * Wraps `MoneyText` and animates the amount from where it was to where it is,
 * so a balance counts up on first load and slides to the new number when it
 * changes. Everything else — the currency, the faded paise, the spoken label —
 * is `MoneyText`'s, unchanged; this only feeds it a moving `amount`. Motion off
 * means it renders the final figure and never moves.
 */
export function CountUpMoney(props: MoneyTextProps): ReactNode {
  const enabled = useMotionEnabled();
  const shown = useCountUp(props.amount, enabled);
  return <MoneyText {...props} amount={shown} />;
}

/** Roughly the length of a screen transition — long enough to read, short enough to trust. */
const COUNT_MS = 650;

/**
 * Tween a bigint towards `target`, easing out, on the JS thread.
 *
 * Off, or a figure too large to hold in a Number without losing paise, snaps
 * straight to the target — a wrong number is worse than a still one. Otherwise
 * it animates from whatever is on screen now, so a mid-flight change redirects
 * smoothly rather than jumping back to zero.
 */
export function useCountUp(target: bigint, enabled: boolean): bigint {
  // The start figure is decided here rather than in the effect: motion off, or a
  // number too large to tween as a Number, begins on the target and never moves.
  const [value, setValue] = useState<bigint>(() =>
    enabled && !tooLargeToTween(target) ? 0n : target,
  );
  const frame = useRef<number | null>(null);

  useEffect(() => {
    // Snapping is a state change too, so it goes through a frame rather than
    // running synchronously in the effect body — the same reason the tween does.
    if (!enabled || tooLargeToTween(target)) {
      frame.current = requestAnimationFrame(() => setValue(target));
      return () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
      };
    }

    const started = Date.now();
    // The figure on screen when this frame first fires is where the tween starts,
    // read through the updater so a mid-flight target change redirects from the
    // current number rather than jumping back to zero — and without a ref written
    // during render to carry it.
    let from: bigint | null = null;
    const step = (): void => {
      const progress = Math.min(1, (Date.now() - started) / COUNT_MS);
      setValue((current) => {
        if (from === null) from = current;
        return lerpBig(from, target, easeOutCubic(progress));
      });
      if (progress < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target, enabled]);

  return value;
}

/** A magnitude past the Number safe-integer ceiling would lose paise mid-tween. */
function tooLargeToTween(target: bigint): boolean {
  return (target < 0n ? -target : target) > MAX_SAFE_MINOR;
}
