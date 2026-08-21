/**
 * The tour's paint: a dimmed scrim with a bright hole around the current step's
 * target, and a card that explains it.
 *
 * The scrim is four dim rectangles around the (padded) target rather than a real
 * cut-out, so the target stays lit with no SVG mask; a step with no measured
 * target dims the whole screen instead. Every gap the app could be touched
 * through is covered: the four rects catch the dim area, and a transparent
 * catcher sits over the hole so tapping the highlighted thing advances the tour
 * instead of firing the real control beneath it.
 *
 * The card is measured, then placed below the target when it fits and above it
 * otherwise, clamped inside the safe area so it never slides under the status
 * bar or off an edge; with no target it is centred. A small tail points back at
 * the target.
 *
 * Motion-gated: the scrim fades in once and then holds steady across steps —
 * only the card lifts in on each step, so the dim does not blink at every Next.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { BackHandler, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Button, iconSize, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';
import { TOUR_STEPS, useTour } from '@/lib/tour';

/** The reference's tour accent — a violet, held apart from the app's green so
    the tour reads as a layer over the app, not part of it. */
const TOUR_ACCENT = '#7A5AF8';
/** Breathing room between the lit target and the dim around it. */
const HOLE_PAD = 8;
const CARD_MARGIN = 20;
const CARD_MAX = 380;
/** Gap between the card and the target it points at. */
const CARD_GAP = 14;
/** Keep the card this far off the safe-area edges. */
const EDGE = 8;
const SCRIM = '#000000B3';

export function TourOverlay() {
  const theme = useTheme();
  const { t } = useStrings();
  const { animated } = useMotion();
  const insets = useSafeAreaInsets();
  const { active, step, total, rectFor, next, prev, finish } = useTour();
  const { width: screenW, height: screenH } = useWindowDimensions();

  // The card's measured height, so it can be placed (and clamped) exactly.
  const [cardH, setCardH] = useState(0);

  // The scrim fades in once and holds; the card lifts in on each step. Two
  // separate values so a step change does not re-fade the dim.
  const appear = useSharedValue(0);
  const cardEnter = useSharedValue(0);

  useEffect(() => {
    if (!active) return;
    if (!animated) {
      appear.value = 1;
      return;
    }
    appear.value = withTiming(1, { duration: 220 });
    // Reset when the tour ends so a replay fades in again.
    return () => {
      appear.value = 0;
    };
  }, [active, animated, appear]);

  useEffect(() => {
    if (!active) return;
    if (!animated) {
      cardEnter.value = 1;
      return;
    }
    cardEnter.value = 0;
    cardEnter.value = withTiming(1, { duration: 220 });
  }, [active, step, animated, cardEnter]);

  // Hardware back ends the tour rather than driving the Stack behind the scrim.
  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      finish();
      return true;
    });
    return () => sub.remove();
  }, [active, finish]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: appear.value }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardEnter.value,
    transform: [{ translateY: (1 - cardEnter.value) * 12 }],
  }));

  if (!active) return null;

  const current = TOUR_STEPS[step];
  const rect = rectFor(current.anchor);
  const isLast = step >= total - 1;

  // A padded box around the target, clamped to the screen.
  const hole = rect
    ? {
        x: Math.max(0, rect.x - HOLE_PAD),
        y: Math.max(0, rect.y - HOLE_PAD),
        width: rect.width + HOLE_PAD * 2,
        height: rect.height + HOLE_PAD * 2,
      }
    : null;

  const cardWidth = Math.min(CARD_MAX, screenW - CARD_MARGIN * 2);

  // Where the card goes: below the target when it fits, above when it does not,
  // centred with no target — always inside the safe area.
  const minTop = insets.top + EDGE;
  const maxTop = Math.max(minTop, screenH - insets.bottom - EDGE - cardH);
  let cardTop: number;
  let placedBelow = true;
  if (!hole) {
    cardTop = Math.min(maxTop, Math.max(minTop, (screenH - cardH) / 2));
  } else {
    const belowTop = hole.y + hole.height + CARD_GAP;
    const aboveTop = hole.y - CARD_GAP - cardH;
    if (cardH > 0 && belowTop > maxTop && aboveTop >= minTop) {
      cardTop = aboveTop;
      placedBelow = false;
    } else {
      cardTop = Math.min(maxTop, Math.max(minTop, belowTop));
      placedBelow = true;
    }
  }

  const targetCenterX = hole ? hole.x + hole.width / 2 : screenW / 2;
  const tailLeft = Math.max(24, Math.min(cardWidth - 24, targetCenterX - CARD_MARGIN));
  // The tail only reads as a pointer when the card actually sits against the
  // target — hide it if the card had to be clamped away from it.
  const tailFits = hole
    ? placedBelow
      ? Math.abs(cardTop - (hole.y + hole.height + CARD_GAP)) < 1
      : Math.abs(cardTop - (hole.y - CARD_GAP - cardH)) < 1
    : false;

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      {/* The scrim. Four rects around the hole keep the target lit and swallow
          every tap on the dim area, so nothing behind the tour is reachable. */}
      {hole ? (
        <>
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                height: hole.y,
                backgroundColor: SCRIM,
              },
              scrimStyle,
            ]}
          />
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: 0,
                right: 0,
                top: hole.y + hole.height,
                bottom: 0,
                backgroundColor: SCRIM,
              },
              scrimStyle,
            ]}
          />
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: 0,
                top: hole.y,
                width: hole.x,
                height: hole.height,
                backgroundColor: SCRIM,
              },
              scrimStyle,
            ]}
          />
          <Animated.View
            style={[
              {
                position: 'absolute',
                left: hole.x + hole.width,
                right: 0,
                top: hole.y,
                height: hole.height,
                backgroundColor: SCRIM,
              },
              scrimStyle,
            ]}
          />
          {/* The ring around the lit target. */}
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                left: hole.x,
                top: hole.y,
                width: hole.width,
                height: hole.height,
                borderRadius: theme.radius.lg,
                borderWidth: 2,
                borderColor: '#FFFFFF',
              },
              scrimStyle,
            ]}
          />
          {/* The catcher over the hole: a tap on the highlighted thing advances
              the tour instead of firing the real control beneath it. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isLast ? t.tour.done : t.tour.next}
            onPress={isLast ? finish : next}
            style={{
              position: 'absolute',
              left: hole.x,
              top: hole.y,
              width: hole.width,
              height: hole.height,
            }}
          />
        </>
      ) : (
        <Animated.View
          style={[
            { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: SCRIM },
            scrimStyle,
          ]}
        />
      )}

      {/* The card. */}
      <Animated.View
        onLayout={(e) => setCardH(e.nativeEvent.layout.height)}
        style={[
          { position: 'absolute', left: CARD_MARGIN, width: cardWidth, top: cardTop },
          cardStyle,
        ]}
      >
        {/* The tail, pointing back at the target — only when the card sits
            against it. */}
        {tailFits ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: tailLeft - 8,
              width: 16,
              height: 16,
              backgroundColor: theme.color.surface,
              transform: [{ rotate: '45deg' }],
              ...(placedBelow ? { top: -6 } : { bottom: -6 }),
            }}
          />
        ) : null}

        <View
          style={{
            backgroundColor: theme.color.surface,
            borderRadius: theme.radius.lg,
            padding: theme.spacing.xl,
            gap: theme.spacing.md,
            ...theme.shadow.lifted,
          }}
        >
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <View
              style={{
                alignSelf: 'flex-start',
                backgroundColor: TOUR_ACCENT,
                borderRadius: theme.radius.pill,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.xs,
              }}
            >
              <Text variant="micro" style={{ color: '#FFFFFF', fontWeight: '800' }}>
                {t.tour.badge}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.common.close}
              hitSlop={10}
              onPress={finish}
              style={({ pressed }) => ({
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: theme.color.surfaceMuted,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Ionicons name="close" size={iconSize.md} color={theme.color.text} />
            </Pressable>
          </View>

          <Text variant="heading">{current.title(t)}</Text>
          <Text variant="body" tone="muted">
            {current.body(t)}
          </Text>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: theme.spacing.sm,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              {step > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.common.back}
                  hitSlop={8}
                  onPress={prev}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Text variant="caption" tone="brand" style={{ fontWeight: '700' }}>
                    {t.common.back}
                  </Text>
                </Pressable>
              ) : null}
              <Text variant="caption" tone="muted">
                {step + 1} / {total}
              </Text>
            </View>
            <Button label={isLast ? t.tour.done : t.tour.next} onPress={isLast ? finish : next} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}
