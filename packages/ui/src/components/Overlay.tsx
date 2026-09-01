/**
 * The two overlay motions the whole app shares: a bottom Sheet and a centred
 * Popup.
 *
 * Every transient surface — a picker, a confirm dialog, a quick-add menu — used
 * to reach for React Native's `Modal` directly and pick `animationType="fade"`
 * or `"slide"` by hand, so a "sheet" sometimes cross-faded and a dialog blinked
 * on with no arrival at all. These two components are the one implementation of
 * that motion, WhatsApp's grammar: a Sheet springs up from the bottom edge under
 * a fading scrim, a Popup fades in while scaling up from just under full size.
 *
 * Built on RN's own `Animated`, not Reanimated: the design system carries no
 * animation dependency, and opacity + translate + scale on the native driver is
 * exactly what `Animated` is good at. Each surface is held mounted by a latch
 * through its close, so the exit plays instead of the content vanishing the
 * instant `visible` flips — `Modal`'s own `animationType` would unmount too soon
 * for that. Reduced motion keeps the fade and drops the travel and the scale.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';

/** The scrim behind every overlay — a near-black wash, enough to sit the surface
 *  off the screen without dimming it to a blackout. */
const SCRIM = 'rgba(10, 10, 26, 0.55)';
const OPEN_SPRING = { tension: 70, friction: 12 } as const;
const CLOSE_MS = 160;
/** How small a Popup starts — a grow into place, not a pop from nothing. */
const POPUP_START_SCALE = 0.92;

/**
 * The OS reduce-motion flag, read locally so the design system does not depend
 * on the app's motion context. Starts true so the very first frame never travels
 * before the real value lands.
 */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(true);
  useEffect(() => {
    let alive = true;
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduce(value);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * The shared machinery: a `progress` value driven 0→1 on open and back on close,
 * a `mounted` latch that outlives `visible` so the close animation is seen, and
 * the scrim that fades on the same value. Returns what both surfaces need to
 * render themselves.
 */
function useOverlay(visible: boolean, reduceMotion: boolean) {
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;

  // Mount the moment we open — a state adjustment on the visible prop, done in
  // render rather than in the effect (which then only drives the animation and
  // never calls setState synchronously in its body).
  if (visible && !mounted) setMounted(true);

  useEffect(() => {
    if (visible) {
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        ...(reduceMotion ? { tension: 200, friction: 26 } : OPEN_SPRING),
      }).start();
    } else if (mounted) {
      Animated.timing(progress, {
        toValue: 0,
        duration: reduceMotion ? 0 : CLOSE_MS,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, mounted, reduceMotion, progress]);

  return { mounted, progress };
}

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** The grab-handle bar at the top — the "you can pull this down" grammar. On
   *  by default; drop it for a sheet that is not dismissible by drag. */
  handle?: boolean;
  /** The card's own comfortable side padding. On by default; turn it off for a
   *  sheet whose content manages its own gutters (a full-bleed list or grid, or
   *  a form that already pads itself). */
  padded?: boolean;
  /** Extra style for the sheet card — a `maxHeight` for a tall sheet, say. */
  style?: ViewStyle;
  /** Screen-reader label for the tap-away scrim. */
  closeLabel?: string;
}

/**
 * A bottom sheet: the surface slides up from the bottom edge under a fading
 * scrim, and back down on dismiss. Tapping the scrim closes it; the sheet itself
 * swallows the tap so a press inside never dismisses. Rounded top corners, a
 * grab handle, and the safe-area inset folded into the bottom padding.
 */
export function Sheet({
  visible,
  onClose,
  children,
  handle = true,
  padded = true,
  style,
  closeLabel = 'Close',
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const { height: screenHeight } = useWindowDimensions();
  const { mounted, progress } = useOverlay(visible, reduceMotion);
  // The sheet's own height, measured on layout, so it travels exactly its own
  // distance rather than a guess. Until the first measure a screen-height
  // fallback keeps the first frame off-screen instead of flashing in place.
  const [height, setHeight] = useState(0);

  if (!mounted) return null;

  const translateY = reduceMotion
    ? 0
    : progress.interpolate({
        inputRange: [0, 1],
        outputRange: [height || screenHeight, 0],
      });

  return (
    <Modal transparent statusBarTranslucent visible={mounted} animationType="none" onRequestClose={onClose}>
      <Animated.View style={{ flex: 1, backgroundColor: SCRIM, opacity: progress }}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <Animated.View style={{ transform: [{ translateY }] }}>
            <Pressable
              onPress={() => {}}
              accessibilityViewIsModal
              onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
              style={[
                {
                  backgroundColor: theme.color.surface,
                  borderTopLeftRadius: theme.radius.xxl,
                  borderTopRightRadius: theme.radius.xxl,
                  paddingHorizontal: padded ? theme.spacing.lg : 0,
                  paddingTop: theme.spacing.md,
                  paddingBottom: theme.spacing.md + insets.bottom,
                  ...theme.shadow.lifted,
                },
                style,
              ]}
            >
              {handle ? (
                <View
                  style={{
                    alignSelf: 'center',
                    width: 40,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: theme.color.border,
                    marginBottom: theme.spacing.sm,
                  }}
                />
              ) : null}
              {children}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}

export interface PopupProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Whether a scrim tap dismisses. Off for a dialog that must be answered. */
  dismissable?: boolean;
  /** Extra style for the dialog card. */
  style?: ViewStyle;
  closeLabel?: string;
}

/**
 * A centred dialog: fades in while scaling up from just under full size, the
 * WhatsApp/Material dialog arrival, and reverses on close. The card sits in the
 * middle over a fading scrim with a comfortable gutter, so a long dialog scrolls
 * inside its own bounds rather than bleeding to the screen edges.
 */
export function Popup({
  visible,
  onClose,
  children,
  dismissable = true,
  style,
  closeLabel = 'Close',
}: PopupProps) {
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const { mounted, progress } = useOverlay(visible, reduceMotion);

  if (!mounted) return null;

  const scale = reduceMotion
    ? 1
    : progress.interpolate({ inputRange: [0, 1], outputRange: [POPUP_START_SCALE, 1] });

  return (
    <Modal transparent statusBarTranslucent visible={mounted} animationType="none" onRequestClose={onClose}>
      <Animated.View style={{ flex: 1, backgroundColor: SCRIM, opacity: progress }}>
        <Pressable
          onPress={dismissable ? onClose : undefined}
          accessibilityRole={dismissable ? 'button' : undefined}
          accessibilityLabel={dismissable ? closeLabel : undefined}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: theme.spacing.xl,
          }}
        >
          <Animated.View style={{ width: '100%', opacity: progress, transform: [{ scale }] }}>
            <Pressable
              onPress={() => {}}
              accessibilityViewIsModal
              style={[
                {
                  alignSelf: 'center',
                  maxWidth: 420,
                  width: '100%',
                  backgroundColor: theme.color.surface,
                  borderRadius: theme.radius.xxl,
                  padding: theme.spacing.xl,
                  ...theme.shadow.lifted,
                },
                style,
              ]}
            >
              {children}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}
