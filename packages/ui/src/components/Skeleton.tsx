import { useEffect, useRef } from 'react';
import { Animated, type DimensionValue, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

export interface SkeletonProps {
  /** Any RN dimension — a number of pixels or a percentage string. Defaults to filling its row. */
  width?: DimensionValue;
  height?: number;
  /** Defaults to the small corner radius; pass a large number for circles (avatars). */
  radius?: number;
  /**
   * Whether the placeholder breathes. Off means a flat block, which is what a
   * person who turned motion down asked for. The app threads its motion
   * preference in here; this primitive does not read it, so it stays a dumb
   * design-system piece with no opinion about where the answer comes from.
   */
  animated?: boolean;
  style?: ViewStyle;
}

/**
 * One placeholder bar.
 *
 * A pulse in opacity, not a shimmer that sweeps across — a sweep has a
 * direction, and this app is laid out both ways (see `direction.ts`). Fading in
 * place says "still coming" without ever having to know which way the language
 * runs.
 *
 * Hidden from screen readers: a shape standing in for text is not text, and a
 * reader that announces four grey rectangles has told the person nothing. The
 * screen that shows these owns the spoken "loading" instead.
 */
export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  animated = true,
  style,
}: SkeletonProps) {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!animated) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width,
          height,
          borderRadius: radius ?? theme.radius.sm,
          backgroundColor: theme.color.skeleton,
          opacity: animated ? pulse : 0.7,
        },
        style,
      ]}
    />
  );
}
