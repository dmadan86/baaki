import { useRef, type ReactNode } from 'react';
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
 * The centred, raised primary action — the circle that sits proud of the
 * capsule in the reference board. It is not a destination, so it is a button
 * rather than a tab: tapping it starts something rather than moving you.
 */
export interface PillTabAction {
  icon: (color: string) => ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
}

/** One destination: an icon over its label. 48 clears both comfortably. */
const ITEM_HEIGHT = 48;

/** The capsule itself: the item column plus the padding wrapped around it. */
const BAR_HEIGHT = ITEM_HEIGHT + spacing.sm * 2;

/** The raised action circle. */
const ACTION_SIZE = 58;

/** How far the action lifts above the capsule's top edge. */
const ACTION_LIFT = 16;

/** How far the capsule floats above whatever sits below it. */
const FLOAT = spacing.lg;

/**
 * How much room a scrolling tab screen has to leave at its foot.
 *
 * The bar is positioned absolutely, so it covers the end of a list rather than
 * pushing it up: without this the last row is parked underneath it and cannot
 * be read or tapped. Derived rather than guessed at, because the two things it
 * depends on both move — the capsule's height with the type scale, and the
 * inset with the phone, which is the half a hardcoded number gets wrong.
 *
 * The trailing gap is `xxxl` rather than the list's own rhythm so the foot of
 * the list reads as an ending rather than as a row that got cut off.
 */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + FLOAT + BAR_HEIGHT + spacing.xxxl;
}

/**
 * The floating pill navigation from the reference boards: a white capsule that
 * hovers over the content, its destinations drawn as an icon over a label. When
 * a `centerAction` is given, the items split around a raised circle in the
 * middle — the primary workflow action, sitting proud of the bar so it reads as
 * "do", not "go".
 *
 * `animated` gives each target a dip under the finger. It defaults off so the
 * bar is still and deterministic unless a caller opts in — the tabs layout
 * passes the app's motion preference, so a phone with reduce-motion set keeps
 * the plain switch.
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

  // Even halves around the action; with an odd count the extra item sits left.
  const split = centerAction ? Math.floor(items.length / 2) : items.length;
  const left = items.slice(0, split);
  const right = items.slice(split);

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
        left: theme.spacing.xl,
        right: theme.spacing.xl,
        // The inset clears the system bar; the float is the gap the design
        // wants underneath the capsule. They add — taking the larger of the two
        // spends the inset on the gap, and on Android, where edge-to-edge is
        // the default and this view is drawn behind a 48dp navigation bar, that
        // leaves the pill sitting flush on the buttons with its shadow clipped.
        bottom: insets.bottom + FLOAT,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.color.surface,
        borderRadius: theme.radius.pill,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        ...theme.shadow.lifted,
      }}
    >
      <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-around' }}>
        {left.map(renderItem)}
      </View>

      {centerAction ? <CenterAction action={centerAction} animated={animated} /> : null}

      {centerAction ? (
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-around' }}>
          {right.map(renderItem)}
        </View>
      ) : null}
    </View>
  );
}

function TabItem({
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

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={item.label}
      onPress={() => onSelect(item.key)}
      onPressIn={() => press(0.9)}
      onPressOut={() => press(1)}
    >
      <Animated.View
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          height: ITEM_HEIGHT,
          minWidth: 56,
          transform: [{ scale }],
        }}
      >
        {item.icon(focused ? theme.color.brand : theme.color.textMuted, focused)}
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
}

function CenterAction({ action, animated }: { action: PillTabAction; animated: boolean }) {
  const theme = useTheme();
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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.accessibilityLabel}
      onPress={action.onPress}
      onPressIn={() => press(0.92)}
      onPressOut={() => press(1)}
      // The lift is on the Pressable, not just the visual, so the touch target
      // travels up with the circle rather than staying down in the capsule.
      style={{ marginHorizontal: theme.spacing.sm, transform: [{ translateY: -ACTION_LIFT }] }}
    >
      <Animated.View
        style={{
          width: ACTION_SIZE,
          height: ACTION_SIZE,
          borderRadius: ACTION_SIZE / 2,
          backgroundColor: theme.color.brand,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ scale }],
          ...theme.shadow.soft,
        }}
      >
        {action.icon(theme.color.onBrand)}
      </Animated.View>
    </Pressable>
  );
}
