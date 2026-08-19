/**
 * The sheet and row primitives the expense forms share.
 *
 * Both the capture screen and the group add-expense screen present their
 * pickers (currency, destination) as a bottom sheet over the form, and list
 * their choices as a leading glyph + label + check. Pulling them here means the
 * two screens present, dismiss, and read the same rather than each carrying its
 * own copy that could drift apart.
 */

import { type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { iconSize, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

/**
 * A labelled tap-row: a leading icon, the field name over its value, a chevron.
 * The rows an expense's meta (group, date) share, so they read as one block
 * inside a single card rather than a stack of near-identical cards.
 */
export function FieldRow({
  icon,
  iconColor,
  label,
  value,
  valueMuted = false,
  onPress,
  accessibilityLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  label: string;
  value: string;
  valueMuted?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.md} color={iconColor ?? theme.color.textMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text variant="subheading" numberOfLines={1} tone={valueMuted ? 'muted' : undefined}>
          {value}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={iconSize.md} color={theme.color.textFaint} />
    </Pressable>
  );
}

/**
 * A bottom sheet over the form: a dimmed backdrop that closes on tap, a rounded
 * card that swallows its own taps, a grab handle and a title. The pickers on the
 * expense screens (currency, group) share it so they present and dismiss the
 * same way.
 */
export function SheetOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const insets = useSafeAreaInsets();

  // Drag the handle down to dismiss. translateY only ever goes positive (down);
  // past a short threshold or on a quick flick the sheet closes, otherwise it
  // springs back. The gesture lives on the header, not the whole card, so it
  // never fights the list's own vertical scroll.
  const translateY = useSharedValue(0);
  const dragToClose = Gesture.Pan()
    // Only engage once the finger has clearly moved vertically, so a plain tap
    // on the handle still falls through to the Pressable that closes the sheet.
    .activeOffsetY([-12, 12])
    .onUpdate((event) => {
      // Down follows the finger 1:1; an upward pull rubber-bands so the sheet
      // feels anchored rather than free.
      translateY.set(event.translationY > 0 ? event.translationY : event.translationY / 4);
    })
    .onEnd((event) => {
      if (translateY.get() > 120 || event.velocityY > 800) {
        // Carry the flick through: animate the rest of the way out, then close.
        translateY.set(withTiming(700, { duration: 180 }, () => runOnJS(onClose)()));
      } else {
        translateY.set(withSpring(0, { damping: 20, stiffness: 220 }));
      }
    });
  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.get() }],
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t.common.close}
      onPress={onClose}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(10, 10, 26, 0.55)',
        justifyContent: 'flex-end',
      }}
    >
      <Animated.View
        style={[
          {
            backgroundColor: theme.color.surface,
            borderTopLeftRadius: theme.radius.lg,
            borderTopRightRadius: theme.radius.lg,
            padding: theme.spacing.xl,
            // Clear the Android gesture/nav bar so the last list row is not
            // hidden behind it.
            paddingBottom: theme.spacing.xl + insets.bottom,
            gap: theme.spacing.md,
            maxHeight: '75%',
          },
          cardStyle,
        ]}
      >
        {/* Swallow taps on the card so they never reach the backdrop, which
            would close the sheet. */}
        <Pressable onPress={() => {}} style={{ gap: theme.spacing.md, flexShrink: 1 }}>
          {/* The header is the drag surface AND a tap-to-close target: the grab
              handle reads as draggable, so make it do something when pushed. */}
          <GestureDetector gesture={dragToClose}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.common.close}
              onPress={onClose}
              style={{ gap: theme.spacing.md }}
            >
              <View
                style={{
                  alignSelf: 'center',
                  width: 40,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: theme.color.border,
                }}
              />
              <Text variant="heading">{title}</Text>
            </Pressable>
          </GestureDetector>
          {/* flexShrink lets this scroll: without it the list keeps its full
              content height and the sheet's maxHeight clips the overflow instead
              of scrolling it, so a long group or currency list loses its bottom
              rows. */}
          <ScrollView
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={{ flexShrink: 1 }}
          >
            {children}
          </ScrollView>
        </Pressable>
      </Animated.View>
    </Pressable>
  );
}

/** One row in a picker sheet — a leading glyph, a label, a check when chosen. */
export function ChoiceRow({
  leading,
  label,
  selected,
  onPress,
}: {
  leading: ReactNode;
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {leading}
      <Text
        variant="body"
        numberOfLines={1}
        style={{ flex: 1, color: selected ? theme.color.brand : theme.color.text }}
      >
        {label}
      </Text>
      {selected ? <Ionicons name="checkmark" size={iconSize.md} color={theme.color.brand} /> : null}
    </Pressable>
  );
}
