/**
 * The three cards a first-time user meets, before the welcome.
 *
 * A tour is a tax on somebody who wants to split a bill, so it is paid exactly
 * once and it is always skippable from the first frame. What it buys is the
 * three things about Baaki that are not guessable from a ledger screen: that
 * nothing is behind a sign-up, that the people you split with do not need the
 * app, and that settling hands the amount to UPI rather than leaving you to
 * type it. Somebody who never reads this loses nothing they cannot find later.
 *
 * Full-bleed tint per card rather than one background: the colour changing
 * under your thumb is the progress indicator that needs no explanation, and the
 * dots are there for anyone who wants to count.
 */

import { useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { directionalIcon, iconSize, isRtlLayout, Text, type TintName, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { pageForSlide, pageOrder, slideForPage } from '@/lib/carousel';
import { useMotion } from '@/lib/motion';

interface Slide {
  readonly tint: TintName;
  readonly emoji: string;
}

/**
 * Emoji rather than illustration. Not for want of an artist: art has to ship as
 * a binary asset in every build, and this screen is the one that renders before
 * the app has proved anything about itself. The group covers are emoji for the
 * same reason, so the tour looks like the product rather than like a brochure
 * bolted to the front of it.
 */
const SLIDES: readonly Slide[] = [
  { tint: 'lilac', emoji: '🧾' },
  { tint: 'mint', emoji: '🔗' },
  { tint: 'peach', emoji: '⚡' },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { animated } = useMotion();
  const { t } = useStrings();
  const { width, height } = useWindowDimensions();
  const scroller = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const rtl = isRtlLayout();
  const placed = useRef(false);

  const goTo = (next: number) => {
    if (next >= SLIDES.length) {
      onDone();
      return;
    }
    setIndex(next);
    scroller.current?.scrollTo({ x: pageForSlide(next, SLIDES.length, rtl) * width, animated });
  };

  // The page under the thumb decides the index, so a drag and a tap on the
  // arrow cannot disagree about which card is showing.
  //
  // Driven by scroll position rather than by the momentum-end event: a slow
  // drag that is released without a flick never produces momentum, and the
  // dots would sit under the wrong card until the next tap.
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(event.nativeEvent.contentOffset.x / width);
    const slide = slideForPage(page, SLIDES.length, rtl);
    if (slide !== index) setIndex(slide);
  };

  // Right to left the first card is the rightmost one, so the pager does not
  // start where it is scrolled to. Done on content size rather than on layout:
  // at layout time the three cards have not been measured and scrolling to the
  // last of them is a no-op.
  const onContentSizeChange = () => {
    if (placed.current || !rtl) return;
    placed.current = true;
    scroller.current?.scrollTo({ x: pageForSlide(0, SLIDES.length, rtl) * width, animated: false });
  };

  return (
    <ScrollView
      ref={scroller}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      onScroll={onScroll}
      onContentSizeChange={onContentSizeChange}
      scrollEventThrottle={16}
      // Pinned left-to-right on purpose: see `@/lib/carousel`. The reversal is
      // arithmetic there rather than three platforms' disagreeing opinions
      // about what `contentOffset.x` means in a mirrored scroll view.
      style={{ flex: 1, direction: 'ltr' }}
    >
      {pageOrder(SLIDES, rtl).map(({ slide, index: slideIndex }) => {
        // The words live in the string table; this file only knows the look.
        const copy = t.onboarding[slideIndex] ?? t.onboarding[0]!;
        const { bg, ink, inkMuted } = theme.tint[slide.tint];
        const last = slideIndex === SLIDES.length - 1;

        return (
          <View
            key={slide.tint}
            style={{
              width,
              // Stated rather than stretched: a horizontal ScrollView sizes
              // itself to its content, so a card left to find its own height
              // is only as tall as its paragraph and the colour stops in the
              // middle of the screen.
              height,
              // The card mirrors even though the pager holding it does not, so
              // the wordmark, the dots and the arrow all sit where an Arabic
              // reader expects them.
              direction: rtl ? 'rtl' : 'ltr',
              backgroundColor: bg,
              paddingTop: insets.top + theme.spacing.md,
              paddingBottom: insets.bottom + theme.spacing.xxl,
              paddingHorizontal: theme.spacing.xxxl,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 20, fontWeight: '700', color: ink }}>பாக்கி</Text>
              <Pressable
                onPress={onDone}
                accessibilityRole="button"
                accessibilityLabel={t.skip}
                hitSlop={12}
              >
                <Text variant="caption" style={{ color: inkMuted }}>
                  {t.skip}
                </Text>
              </Pressable>
            </View>

            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {/* Decorative: the sentence below says the same thing, and a
                  screen reader announcing "receipt" adds nothing. */}
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{ fontSize: 120 }}
              >
                {slide.emoji}
              </Text>
            </View>

            <View style={{ gap: theme.spacing.md }}>
              <Text style={{ fontSize: 36, fontWeight: '700', color: ink }}>{copy.title}</Text>
              <Text variant="body" style={{ color: inkMuted }}>
                {copy.body}
              </Text>
            </View>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: theme.spacing.xxl,
              }}
            >
              <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                {SLIDES.map((dot, dotIndex) => (
                  <View
                    key={dot.tint}
                    style={{
                      height: 8,
                      width: dotIndex === index ? 24 : 8,
                      borderRadius: theme.radius.pill,
                      backgroundColor: ink,
                      opacity: dotIndex === index ? 1 : 0.3,
                    }}
                  />
                ))}
              </View>

              <Pressable
                onPress={() => goTo(slideIndex + 1)}
                accessibilityRole="button"
                accessibilityLabel={last ? t.getStarted : t.next}
                style={({ pressed }) => ({
                  height: 56,
                  width: 56,
                  borderRadius: theme.radius.pill,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.color.surface,
                  opacity: pressed ? 0.85 : 1,
                  ...theme.shadow.soft,
                })}
              >
                <Ionicons
                  // A tick means the same in both directions; an arrow does
                  // not, and this one kept pointing right in a mirrored screen
                  // — "next" pointing backwards, on the very first screen.
                  name={last ? 'checkmark' : directionalIcon('arrow-forward')}
                  size={iconSize.xxl}
                  color={theme.color.text}
                />
              </Pressable>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
