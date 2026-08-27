import { memo, useRef, type ReactNode } from 'react';
import { Animated, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import { spacing } from '../tokens';
import { Text } from './Text';

export interface PillTabItem {
  key: string;
  label: string;
  /** Receives the resolved colour so icons match the active/inactive state. */
  icon: (color: string, focused: boolean) => ReactNode;
}

/**
 * A raised round button in the middle of the bar — a primary quick action that
 * sits above the destinations rather than beside them, the way many apps lift
 * their "+" or record button. Optional: without it the bar is a flat row.
 */
export interface PillTabAction {
  icon: (color: string) => ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
}

/** The bar's own content height, above the system inset. WhatsApp sits ~56–64. */
const BAR_HEIGHT = 60;

/** The rounded active indicator behind the selected icon (Material 3). */
const INDICATOR_WIDTH = 56;
const INDICATOR_HEIGHT = 30;

/**
 * How much room a scrolling tab screen has to leave at its foot.
 *
 * The bar is anchored flush to the bottom edge and is opaque, so a list has to
 * end above it rather than scroll behind it. Derived from the bar height plus
 * the system inset — both move with the phone, which is the half a hardcoded
 * number gets wrong — with a small breath so the last row is not jammed to the
 * bar's top edge.
 */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + BAR_HEIGHT + spacing.lg;
}

/**
 * How much room a scrolling screen that is NOT under the tab bar has to leave at
 * its foot — a pushed detail screen, a settings page, a modal.
 *
 * The app draws edge-to-edge, so the system navigation bar (gesture pill or the
 * three buttons) sits *over* the bottom of the content. A fixed `paddingBottom`
 * that ignores it leaves the last row hidden behind the bar — you scroll to the
 * end and the end is under the system UI. This is the system inset plus a
 * caller-chosen breath, so the last row always clears it on every phone. Pass a
 * larger `base` on a screen with a floating action or a pinned footer.
 */
export function useScreenClearance(base: number = spacing.xxxl): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + base;
}

/**
 * The bottom navigation, WhatsApp / Material 3 style: a flat opaque bar pinned
 * to the bottom edge, a hairline along its top, and each destination drawn as
 * an icon over its label. The selected destination wears a rounded "active
 * indicator" pill behind its icon in the brand's soft tint, and its icon and
 * label take the brand colour — the rest sit muted.
 *
 * `animated` gives the pressed target a small dip under the finger. It defaults
 * off so the bar is still unless a caller opts in — the tabs layout passes the
 * app's motion preference, so reduce-motion keeps the plain switch.
 *
 * `centerAction`, when given, is a raised round button dropped into the middle
 * of the row: the destinations split evenly around it.
 */
export function PillTabBar({
  items,
  activeKey,
  onSelect,
  animated = false,
  centerAction,
}: {
  items: readonly PillTabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  animated?: boolean;
  centerAction?: PillTabAction;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // With a centre action the destinations split into two halves around it; the
  // extra one, when the count is odd, sits on the left.
  const middle = centerAction ? Math.ceil(items.length / 2) : items.length;
  const left = items.slice(0, middle);
  const right = items.slice(middle);

  const renderItem = (item: PillTabItem): ReactNode => (
    <TabItem
      key={item.key}
      item={item}
      focused={item.key === activeKey}
      animated={animated}
      onSelect={onSelect}
    />
  );

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        // The inset is padding, not margin, so the bar's fill runs all the way
        // to the screen edge behind the system navigation buttons rather than
        // leaving a strip of content showing beneath it.
        paddingBottom: insets.bottom,
        height: BAR_HEIGHT + insets.bottom,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.color.surface,
        borderTopWidth: 1,
        borderTopColor: theme.color.border,
      }}
    >
      {left.map(renderItem)}
      {centerAction ? <CenterButton action={centerAction} /> : null}
      {right.map(renderItem)}
    </View>
  );
}

/** The raised round action in the middle of the bar. */
const CenterButton = memo(function CenterButton({ action }: { action: PillTabAction }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action.accessibilityLabel}
        onPress={action.onPress}
        hitSlop={8}
        style={({ pressed }) => ({
          width: 58,
          height: 58,
          borderRadius: 29,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.color.buttonPrimary,
          // Lifted so it reads as sitting above the bar, not in the row.
          transform: [{ translateY: -16 }],
          opacity: pressed ? 0.9 : 1,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        })}
      >
        {action.icon(theme.color.onBrand)}
      </Pressable>
    </View>
  );
});

const TabItem = memo(function TabItem({
  item,
  focused,
  animated,
  onSelect,
}: {
  item: PillTabItem;
  focused: boolean;
  animated: boolean;
  onSelect: (key: string) => void;
}) {
  const theme = useTheme();

  // Core Animated on the native driver: the press scale is a transform the UI
  // thread owns, so it never waits on JavaScript. Kept out of the UI package's
  // dependencies on purpose — the one bit of motion the shared kit needs.
  const scale = useRef(new Animated.Value(1)).current;

  const press = (to: number): void => {
    if (!animated) return;
    Animated.spring(scale, {
      toValue: to,
      damping: 18,
      stiffness: 280,
      mass: 0.5,
      useNativeDriver: true,
    }).start();
  };

  const ink = focused ? theme.color.brand : theme.color.textMuted;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={item.label}
      onPress={() => {
        if (!focused) onSelect(item.key);
      }}
      onPressIn={() => press(0.9)}
      onPressOut={() => press(1)}
      style={{ flex: 1 }}
    >
      <Animated.View
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          transform: [{ scale }],
        }}
      >
        <View
          style={{
            width: INDICATOR_WIDTH,
            height: INDICATOR_HEIGHT,
            // A fixed stadium radius, larger than the box, so the ends stay
            // fully round however the box is measured — half-the-height reads as
            // square for the frame before layout settles the exact height.
            borderRadius: 999,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            backgroundColor: focused ? theme.color.brandSoft : 'transparent',
          }}
        >
          {item.icon(ink, focused)}
        </View>
        <Text
          variant="micro"
          tone={focused ? 'brand' : 'muted'}
          style={{ fontWeight: focused ? '700' : '600' }}
        >
          {item.label}
        </Text>
      </Animated.View>
    </Pressable>
  );
});
