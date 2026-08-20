/**
 * The animated splash — the bridge between the OS splash and the app.
 *
 * The launch has two splashes back to back, and the seam between them is meant
 * to be invisible. First the native one (a solid `SPLASH_BG` field with the
 * logo, configured in `app.json`'s `expo-splash-screen`) shows the instant the
 * process starts, while the JS is still loading. Then this component mounts,
 * hides the native splash, and paints an identical field on top — same colour,
 * same logo, same place — so nothing flickers at the handoff. From there it
 * plays: the logo settles in, holds a beat, and the whole field fades away to
 * reveal the app underneath.
 *
 * Native only. On web there is no native splash to hand off from, and a
 * full-screen overlay sitting over the app for a second would only get in the
 * way of the layout checks the web build exists for — so it renders nothing.
 *
 * Motion is the app's own preference, not just the OS setting: someone who
 * turned motion down inside Baaki gets a brief static hold and a fade, no
 * logo animation.
 *
 * To rebrand: set `GRADIENT`/`SPLASH_BG` to the brand wash and `WORDMARK` (or
 * swap the wordmark <Text> for a logo <Image>). Keep `SPLASH_BG` identical to
 * the `backgroundColor` in `app.json` — the native splash is a solid field, so
 * matching it to this gradient's middle stop keeps the native-to-JS handoff
 * from jumping. The native splash still shows `assets/images/splash-icon.png`.
 */
import { useCallback, useEffect, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { LinearGradient } from 'expo-linear-gradient';
import { Platform, StyleSheet, Text } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useMotion } from '@/lib/motion';

/** The mid stop of the field. Kept identical to `expo-splash-screen`'s
    `backgroundColor` in `app.json` so the native splash (a solid field) and the
    middle of this gradient are the same colour — the handoff shifts as little as
    possible. Change both together. Placeholder blue for now. */
const SPLASH_BG = '#2B4FE0';

/** The field is a diagonal wash, light top-left to deep bottom-right — the Digit
    concept. Placeholder blue; the app's own brand is purple, so this is meant to
    be reset to the brand once the splash art is settled. */
const GRADIENT = ['#4F8EF0', SPLASH_BG, '#2140D6'] as const;

/** The wordmark drawn on the field. Placeholder text until the brand mark
    lands. Lowercase to match the reference. */
const WORDMARK = 'waves';

export function AnimatedSplash() {
  const { animated } = useMotion();
  const [done, setDone] = useState(false);

  // The whole field, and the logo riding on it.
  const fieldOpacity = useSharedValue(1);
  const logoOpacity = useSharedValue(animated ? 0 : 1);
  const logoScale = useSharedValue(animated ? 0.82 : 1);

  const finish = useCallback(() => setDone(true), []);

  useEffect(() => {
    if (Platform.OS === 'web') return;

    // Hand off from the native splash to this one. This paints an identical
    // field, so hiding the native splash reveals no gap.
    SplashScreen.hideAsync().catch(() => {});

    if (!animated) {
      // Reduced motion: hold the field a moment, then fade it out. No logo move.
      fieldOpacity.value = withDelay(
        550,
        withTiming(0, { duration: 220 }, (finished) => {
          if (finished) runOnJS(finish)();
        }),
      );
      return;
    }

    logoOpacity.value = withTiming(1, { duration: 460, easing: Easing.out(Easing.cubic) });
    logoScale.value = withSequence(
      withTiming(1.06, { duration: 460, easing: Easing.out(Easing.cubic) }),
      withTiming(1, { duration: 160, easing: Easing.inOut(Easing.quad) }),
    );
    // Hold the settled logo, then lift the whole field to reveal the app.
    fieldOpacity.value = withDelay(
      920,
      withTiming(0, { duration: 360, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(finish)();
      }),
    );
    // Safety net: a cancelled animation never calls back, and the field would
    // stay up at zero opacity, eating every touch.
    const guard = setTimeout(finish, 2000);
    return () => clearTimeout(guard);
  }, [animated, finish, fieldOpacity, logoOpacity, logoScale]);

  const fieldStyle = useAnimatedStyle(() => ({ opacity: fieldOpacity.value }));
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  if (done || Platform.OS === 'web') return null;

  return (
    <Animated.View
      // Eats touches while it is up, so a tap never reaches the app underneath
      // mid-fade.
      pointerEvents="auto"
      style={[StyleSheet.absoluteFill, fieldStyle]}
    >
      {/* The diagonal wash fills the field; the wordmark rides on top. The
          solid SPLASH_BG in app.json matches the middle stop so the native
          splash flows into this one. */}
      <LinearGradient
        colors={GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
      >
        <Animated.View style={logoStyle}>
          <Text
            style={{
              fontSize: 56,
              fontWeight: '700',
              letterSpacing: -1,
              color: '#FFFFFF',
            }}
          >
            {WORDMARK}
          </Text>
        </Animated.View>
      </LinearGradient>
    </Animated.View>
  );
}
