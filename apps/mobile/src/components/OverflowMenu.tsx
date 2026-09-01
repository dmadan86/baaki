/**
 * The header's overflow menu — the three-dot dropdown, WhatsApp-style.
 *
 * A translucent scrim over the app catches the tap-away, and a small rounded
 * card grows out of the top-right corner — the ⋮ it opened from — with a short
 * list of destinations. Each row dismisses the menu and then routes, so the
 * menu is never left open behind the screen it opened.
 *
 * The open is the motion WhatsApp uses: the card scales up from ~0.9 anchored at
 * its top-right corner (`transformOrigin`) while it fades, so it reads as
 * unfolding from the button rather than a whole panel blinking on. The scrim
 * only fades. The card is held mounted through the close by a local latch, so
 * the same motion plays in reverse on dismiss instead of the card vanishing the
 * instant `visible` flips — `Modal`'s own `animationType` would unmount its
 * children too soon for an exit to be seen. Reduced motion keeps the fade and
 * drops the scale.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { iconSize, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useReducedMotion } from '@/lib/reducedMotion';

/** The corner-grow timings: a touch longer to open than to close, the usual
    asymmetry that makes an entrance feel arriving and a dismiss feel prompt. */
const OPEN_MS = 180;
const CLOSE_MS = 130;
/** How small the card starts — a grow from the corner, not a pop from nothing. */
const START_SCALE = 0.9;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface OverflowMenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  /** Where the row goes. Omit when the row runs an action instead (`onPress`). */
  route?: Href;
  /** An in-app action instead of a route — e.g. replaying the tour. Takes
      precedence over `route`; the menu still closes first. */
  onPress?: () => void;
  // Optional grouping key. A divider is drawn between two consecutive items
  // whose `section` differs; items with no `section` never draw one, so a menu
  // that omits it (the group header) stays a flat, undivided list.
  section?: string;
  // A destructive row (Delete) paints its icon and label in the negative colour,
  // the WhatsApp/Vipps convention that a delete reads red before it is tapped.
  tone?: 'default' | 'danger';
}

export function OverflowMenu({
  visible,
  onClose,
  items,
}: {
  visible: boolean;
  onClose: () => void;
  items: readonly OverflowMenuItem[];
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const reduceMotion = useReducedMotion();

  // The latch: stays mounted from the moment `visible` goes true until the close
  // motion has finished playing, so the card animates out rather than blinking
  // away. `progress` drives both the scrim's opacity and the card's scale+fade;
  // 1 is fully open, 0 fully closed.
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(visible ? 1 : 0);

  // Mount the moment we open — a state adjustment on a prop change, done in
  // render rather than an effect (the effect below only drives the animation, so
  // it never calls setState synchronously in its body).
  if (visible && !mounted) setMounted(true);

  useEffect(() => {
    if (visible) {
      // `progress` drives the scrim and card opacity, so it always fades at full
      // duration — a fade is the accessible way to appear, not the motion reduced
      // motion is there to spare. What reduced motion drops is the corner-grow
      // scale, gated below in `cardStyle`.
      progress.set(withTiming(1, { duration: OPEN_MS, easing: Easing.out(Easing.cubic) }));
    } else if (mounted) {
      // Play the close, then drop the modal — the runOnJS hop is what lets the
      // exit be seen before the tree unmounts.
      progress.set(
        withTiming(0, { duration: CLOSE_MS, easing: Easing.in(Easing.cubic) }, (finished) => {
          if (finished) runOnJS(setMounted)(false);
        }),
      );
    }
  }, [visible, mounted, progress]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ scale: reduceMotion ? 1 : START_SCALE + (1 - START_SCALE) * progress.get() }],
  }));

  const activate = (item: OverflowMenuItem): void => {
    onClose();
    if (item.onPress) item.onPress();
    else if (item.route) router.push(item.route);
  };

  if (!mounted) return null;

  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}>
      {/* The scrim: a full-screen catcher so a tap anywhere off the card closes
          the menu. Kept barely tinted — the point is to dismiss, not to dim. It
          carries a label so a screen reader announces "Close" rather than a bare
          unnamed button covering the whole screen. Its own fade rides `progress`
          rather than the Modal's, so scrim and card open and close together. */}
      <AnimatedPressable
        onPress={onClose}
        style={[{ flex: 1, backgroundColor: 'rgba(0,0,0,0.12)' }, scrimStyle]}
        accessibilityRole="button"
        accessibilityLabel={t.common.close}
      >
        <Animated.View
          // Marks the dropdown as the modal layer so a screen reader confines
          // itself to the menu while it is open, instead of reading the screen
          // behind the scrim.
          accessibilityViewIsModal
          // Dropped from the top-right, clear of the status bar and roughly
          // where the header's three-dot sits. The shadow and the radius live on
          // this outer layer; the inner one clips the rows so a pressed row's
          // highlight follows the rounded corner instead of poking a square
          // through it (`overflow: 'hidden'` would eat the shadow if they shared
          // a layer, so they do not).
          //
          // `transformOrigin` top-right pins the scale to the corner nearest the
          // ⋮, so the card unfolds from the button rather than growing about its
          // own middle.
          style={[
            {
              position: 'absolute',
              top: insets.top + 56,
              right: theme.spacing.xl,
              minWidth: 220,
              borderRadius: theme.radius.lg,
              transformOrigin: 'top right',
              ...theme.shadow.lifted,
            },
            cardStyle,
          ]}
        >
          <View
            style={{
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.color.border,
              backgroundColor: theme.color.surface,
              paddingVertical: theme.spacing.xs,
              overflow: 'hidden',
            }}
          >
            {items.map((item, index) => {
              // A divider sits at a section boundary only: both this row and the
              // one above it name a section, and the two differ. That rules out
              // a divider before the first row (no row above) and any menu that
              // leaves `section` unset (the group header), which stays flat.
              const previous = items[index - 1];
              const dividerAbove =
                previous !== undefined &&
                previous.section !== undefined &&
                item.section !== undefined &&
                previous.section !== item.section;
              return (
                <View key={item.label}>
                  {dividerAbove && (
                    <View
                      style={{
                        height: StyleSheet.hairlineWidth,
                        backgroundColor: theme.color.border,
                        marginVertical: theme.spacing.xs,
                      }}
                    />
                  )}
                  <Pressable
                    onPress={() => activate(item)}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                      // A 44pt floor rather than trusting the padding+text sum to
                      // clear it — a menu row is a primary tap target.
                      minHeight: 44,
                      paddingHorizontal: theme.spacing.lg,
                      paddingVertical: theme.spacing.md,
                      backgroundColor: pressed ? theme.color.surfaceMuted : 'transparent',
                    })}
                  >
                    <Ionicons
                      name={item.icon}
                      size={iconSize.lg}
                      color={item.tone === 'danger' ? theme.color.negative : theme.color.textMuted}
                    />
                    <Text variant="body" tone={item.tone === 'danger' ? 'negative' : undefined}>
                      {item.label}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </Animated.View>
      </AnimatedPressable>
    </Modal>
  );
}
