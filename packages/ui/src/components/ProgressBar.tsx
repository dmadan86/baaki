import { useEffect, useRef, useState } from 'react';
import { Animated, View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

export interface ProgressBarProps {
  /**
   * `0..1` for a determinate bar. Leave it out (or pass `null`) for an
   * indeterminate one — a segment that slides back and forth for work whose
   * length is not known ahead of time, like reading and parsing a file.
   */
  progress?: number | null;
  /**
   * Whether the bar moves. Off (reduce motion) leaves a static fill: a
   * determinate bar rests at its value, an indeterminate one shows a faint full
   * track so "working" still reads without motion. The screen threads its own
   * motion preference in here; this primitive holds no opinion about where the
   * answer comes from — the same contract as {@link Skeleton}.
   */
  animated?: boolean;
  /** Track thickness in pixels. */
  height?: number;
  style?: ViewStyle;
}

/** How much of the track the sliding segment fills while indeterminate. */
const INDETERMINATE_FRACTION = 0.4;

/**
 * A slim progress track.
 *
 * Determinate when handed a `progress`, indeterminate otherwise. The moving
 * part is a transform on the native driver, so it keeps sliding even while the
 * JS thread is busy — which is the whole reason this bar is on screen: it is the
 * one thing telling a person that a frozen-looking import is in fact working.
 */
export function ProgressBar({
  progress = null,
  animated = true,
  height = 6,
  style,
}: ProgressBarProps) {
  const theme = useTheme();
  const indeterminate = progress == null;
  const [trackWidth, setTrackWidth] = useState(0);
  const slide = useRef(new Animated.Value(0)).current;
  const fill = useRef(new Animated.Value(0)).current;
  const clamped = Math.max(0, Math.min(1, progress ?? 0));

  // Determinate: ease the fill toward the reported fraction.
  useEffect(() => {
    if (indeterminate) return;
    if (!animated) {
      fill.setValue(clamped);
      return;
    }
    const run = Animated.timing(fill, {
      toValue: clamped,
      duration: 240,
      useNativeDriver: false,
    });
    run.start();
    return () => run.stop();
  }, [indeterminate, clamped, animated, fill]);

  // Indeterminate: loop a segment across the measured track.
  useEffect(() => {
    if (!indeterminate || !animated || trackWidth === 0) return;
    slide.setValue(0);
    const loop = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 1100,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [indeterminate, animated, trackWidth, slide]);

  const segmentWidth = Math.max(1, trackWidth * INDETERMINATE_FRACTION);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={
        indeterminate ? undefined : { min: 0, max: 100, now: Math.round(clamped * 100) }
      }
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      style={[
        {
          height,
          borderRadius: height / 2,
          backgroundColor: theme.color.skeleton,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {indeterminate ? (
        animated && trackWidth > 0 ? (
          <Animated.View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              width: segmentWidth,
              borderRadius: height / 2,
              backgroundColor: theme.color.brand,
              transform: [
                {
                  translateX: slide.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-segmentWidth, trackWidth],
                  }),
                },
              ],
            }}
          />
        ) : (
          <View
            style={{
              flex: 1,
              borderRadius: height / 2,
              backgroundColor: theme.color.brand,
              opacity: 0.5,
            }}
          />
        )
      ) : (
        <Animated.View
          style={{
            height: '100%',
            borderRadius: height / 2,
            backgroundColor: theme.color.brand,
            width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          }}
        />
      )}
    </View>
  );
}
