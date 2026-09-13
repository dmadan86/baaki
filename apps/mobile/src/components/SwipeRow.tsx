/**
 * One gesture, not one screen.
 *
 * A Review row has two answers a person gives over and over: *file it where
 * this shop always goes*, and *this was never an expense*. Opening each one,
 * choosing a group and saving is right for an unusual spend and far too heavy
 * for the fourth coffee this week. So the row slides.
 *
 * HOW IT BEHAVES. Drag toward the leading edge and the "file it" panel is
 * revealed; drag the other way and "not an expense" is. Let go short of the
 * panel and it springs back; let go past it and the row rests open, so the
 * panel can simply be tapped. Carry the drag past a good part of the row's
 * width — or flick it — and the action fires without a second touch. That is
 * the whole point: the practised case is one gesture, and the unpractised one
 * is a button that appeared where the thumb already was.
 *
 * RTL. `translateX` is the one thing React Native will not mirror for you (see
 * `@waves/ui`'s `direction.ts`), so the drag is tracked in *logical* units —
 * positive always means "toward the leading edge" — and only multiplied back
 * into screen space at the transform. The panels themselves sit on `left` and
 * `right`, which RN does swap, so in Arabic the file action is on the right and
 * is reached by dragging left, exactly as the rest of the screen mirrors.
 *
 * ACCESSIBILITY. The panels are deliberately **not** in the accessibility tree.
 * A control nested inside an accessible row can be unreachable to a screen
 * reader, and a gesture is no good to somebody who does not make one — so both
 * actions ride on the row itself as `accessibilityActions`, and both are also
 * plain rows in the ⋯ sheet. Nothing here is the only way to anything.
 */

import { useCallback, useState, type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { isRtlLayout, Text, useTheme } from '@waves/ui';

/** How wide a revealed panel is, and therefore how far "open" is. */
const PANEL = 104;
/** Past this share of the row's width, letting go fires the action outright. */
const COMMIT_FRACTION = 0.42;
/** A flick this fast fires the action wherever it happens to be. */
const FLICK = 900;

export interface SwipeAction {
  /** What the panel says. Also the label the row exposes to a screen reader. */
  readonly label: string;
  readonly icon: keyof typeof Ionicons.glyphMap;
  /** `brand` for filing it somewhere, `muted` for taking it off the list. */
  readonly tone: 'brand' | 'muted';
  readonly onAction: () => void;
}

function Panel({
  action,
  side,
  open,
  onPress,
}: {
  action: SwipeAction;
  side: 'leading' | 'trailing';
  open: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const background = action.tone === 'brand' ? theme.color.brand : theme.color.textMuted;
  return (
    <Pressable
      // Out of the a11y tree on purpose — the row carries both actions as
      // custom actions, and the ⋯ sheet carries them as ordinary rows.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // Only tappable once it is actually showing; a panel hidden under the row
      // must not swallow a tap meant for the row.
      pointerEvents={open ? 'auto' : 'none'}
      onPress={onPress}
      style={({ pressed }) => ({
        position: 'absolute',
        top: 0,
        bottom: 0,
        ...(side === 'leading' ? { left: 0 } : { right: 0 }),
        width: PANEL,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        paddingHorizontal: theme.spacing.sm,
        borderRadius: theme.radius.lg,
        backgroundColor: background,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Ionicons name={action.icon} size={20} color={theme.color.onBrand} />
      <Text variant="micro" align="center" numberOfLines={2} style={{ color: theme.color.onBrand }}>
        {action.label}
      </Text>
    </Pressable>
  );
}

/**
 * NOTE ON RECYCLING. This component holds a half-finished gesture, and FlashList
 * hands one component instance to a succession of different drafts. So the
 * caller gives it a `key` of the draft's own id: React then makes a fresh one
 * per draft rather than reusing a row that is still sitting open. Resetting the
 * slide in an effect instead would be a `setState` inside an effect body — the
 * cascading-render pattern React now lints against — for no gain over a key.
 */
export function SwipeRow({
  leading,
  trailing,
  children,
}: {
  leading: SwipeAction | null;
  trailing: SwipeAction | null;
  children: ReactNode;
}): React.JSX.Element {
  const rtl = isRtlLayout();
  const sign = rtl ? -1 : 1;

  // Logical offset: positive is always "toward the leading edge", whichever way
  // the screen runs. `start` is where the finger picked the row up from, so a
  // drag that begins on an already-open row continues rather than jumps.
  const offset = useSharedValue(0);
  const start = useSharedValue(0);
  const width = useSharedValue(0);
  const [open, setOpen] = useState<'leading' | 'trailing' | null>(null);

  const close = useCallback((): void => {
    offset.set(withSpring(0, { damping: 22, stiffness: 240 }));
    setOpen(null);
  }, [offset]);

  const fire = useCallback((action: SwipeAction): void => {
    setOpen(null);
    action.onAction();
  }, []);

  const pan = Gesture.Pan()
    // Engage only on a clear horizontal move, and give up on a vertical one, so
    // the list's own scroll always wins a scroll.
    .activeOffsetX([-16, 16])
    .failOffsetY([-12, 12])
    .onBegin(() => {
      start.set(offset.get());
    })
    .onUpdate((event) => {
      const next = start.get() + event.translationX * sign;
      // A side with no action at all barely moves, which reads as "there is
      // nothing that way" rather than as a row that failed to respond.
      const allowed = next > 0 ? leading !== null : trailing !== null;
      if (!allowed) {
        offset.set(next / 6);
        return;
      }
      // Never further than the row is wide — past that the row has left.
      const limit = width.get();
      offset.set(Math.abs(next) > limit ? Math.sign(next) * limit : next);
    })
    .onEnd((event) => {
      const here = offset.get();
      const velocity = event.velocityX * sign;
      const commitAt = Math.max(width.get() * COMMIT_FRACTION, PANEL * 1.35);

      if (leading && (here >= commitAt || (here > PANEL * 0.55 && velocity > FLICK))) {
        offset.set(withTiming(width.get(), { duration: 160 }, () => runOnJS(fire)(leading)));
        return;
      }
      if (trailing && (here <= -commitAt || (here < -PANEL * 0.55 && velocity < -FLICK))) {
        offset.set(withTiming(-width.get(), { duration: 160 }, () => runOnJS(fire)(trailing)));
        return;
      }
      if (leading && here > PANEL * 0.5) {
        offset.set(withSpring(PANEL, { damping: 22, stiffness: 240 }));
        runOnJS(setOpen)('leading');
        return;
      }
      if (trailing && here < -PANEL * 0.5) {
        offset.set(withSpring(-PANEL, { damping: 22, stiffness: 240 }));
        runOnJS(setOpen)('trailing');
        return;
      }
      offset.set(withSpring(0, { damping: 22, stiffness: 240 }));
      runOnJS(setOpen)(null);
    });

  const sliding = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.get() * sign }],
  }));

  return (
    <View
      onLayout={(event) => width.set(event.nativeEvent.layout.width)}
      style={{ position: 'relative', justifyContent: 'center' }}
    >
      {leading ? (
        <Panel
          action={leading}
          side="leading"
          open={open === 'leading'}
          onPress={() => fire(leading)}
        />
      ) : null}
      {trailing ? (
        <Panel
          action={trailing}
          side="trailing"
          open={open === 'trailing'}
          onPress={() => fire(trailing)}
        />
      ) : null}

      <GestureDetector gesture={pan}>
        <Animated.View style={sliding}>
          {children}
          {/* While a panel is showing, a tap on the row closes it rather than
              opening the draft — the same forgiveness a half-open drawer has
              everywhere else. */}
          {open ? (
            <Pressable
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              onPress={close}
              style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
            />
          ) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
