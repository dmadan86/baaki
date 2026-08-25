/**
 * A slim progress bar across the top of the app while transfers run — the
 * browser's page-load / download bar, for receipt uploads (and any future
 * transfer that reports through {@link useTransferProgress}).
 *
 * It is behind the `upload_progress` feature flag, so it can be turned on or off
 * from the console without a ship. Off (or outside the rollout) it renders
 * nothing; the transfer store still ticks, it just goes unseen.
 *
 * Visual-only, no text, and `pointerEvents="none"` so it never intercepts a tap.
 * It fills toward the current fraction, nudges off zero so the first upload does
 * not look stuck, then runs to full and fades out when the batch finishes.
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@waves/ui';

import { useFlagEnabled } from '@/lib/flags';
import { useTransferProgress } from '@/lib/transferProgress';

const BAR_HEIGHT = 3;

export function TransferProgressBar(): React.JSX.Element | null {
  const enabled = useFlagEnabled('upload_progress');
  const { active, fraction } = useTransferProgress();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // Stable Animated values via useState (not useRef) so reading them in render
  // is not a ref access — the pattern the rest of the app's animations use.
  const progress = useState(() => new Animated.Value(0))[0];
  const opacity = useState(() => new Animated.Value(0))[0];
  // Whether the bar was in an active run, so its end can be animated (fill to
  // full, then fade) rather than snapping away the instant work finishes.
  const wasActive = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    if (active) {
      wasActive.current = true;
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.timing(progress, {
          // Never sit at a dead zero while the first file is in flight — a small
          // floor keeps the bar visibly moving before any step has completed.
          toValue: Math.max(fraction, 0.08),
          duration: 300,
          useNativeDriver: false,
        }),
      ]).start();
    } else if (wasActive.current) {
      wasActive.current = false;
      Animated.sequence([
        Animated.timing(progress, { toValue: 1, duration: 150, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) progress.setValue(0);
      });
    }
  }, [enabled, active, fraction, progress, opacity]);

  if (!enabled) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: insets.top,
        left: 0,
        right: 0,
        height: BAR_HEIGHT,
        zIndex: 1000,
      }}
    >
      <Animated.View
        style={{
          height: BAR_HEIGHT,
          opacity,
          backgroundColor: theme.color.brand,
          width: progress.interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', '100%'],
          }),
        }}
      />
    </View>
  );
}
