import { useEffect, useRef, type ReactNode } from 'react';
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

/** A destination's touch target. 44 is the floor both platforms ask for. */
const ITEM_HEIGHT = 44;

/** The capsule itself: one touch target plus the padding wrapped around it. */
const BAR_HEIGHT = ITEM_HEIGHT + spacing.sm * 2;

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
 * hovers over the content, with the active destination expanding into a filled
 * purple pill that also shows its label.
 *
 * `animated` gives each destination a dip under the finger and fades its label
 * in as it becomes active. It defaults off so the bar is still and deterministic
 * unless a caller opts in — the tabs layout passes the app's motion preference,
 * so a phone with reduce-motion set keeps the plain switch.
 */
export function PillTabBar({
  items,
  activeKey,
  onSelect,
  animated = false,
}: {
  items: readonly PillTabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  animated?: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

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
        justifyContent: 'space-between',
        backgroundColor: theme.color.surface,
        borderRadius: theme.radius.pill,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.sm,
        ...theme.shadow.lifted,
      }}
    >
      {items.map((item) => (
        <TabItem
          key={item.key}
          item={item}
          focused={item.key === activeKey}
          animated={animated}
          onSelect={onSelect}
        />
      ))}
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

  // Built on core Animated, both on the native driver: the press scale and the
  // label fade are transform and opacity, which the UI thread owns, so neither
  // waits on JavaScript. Kept out of the UI package's dependencies on purpose —
  // this is the one bit of motion the shared kit needs, and it does not need a
  // whole animation library to get it.
  const scale = useRef(new Animated.Value(1)).current;
  const labelOpacity = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    if (!focused) return;
    if (!animated) {
      labelOpacity.setValue(1);
      return;
    }
    labelOpacity.setValue(0);
    Animated.timing(labelOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [focused, animated, labelOpacity]);

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
          flexDirection: 'row',
          alignItems: 'center',
          gap: focused ? theme.spacing.sm : 0,
          paddingHorizontal: focused ? theme.spacing.lg : theme.spacing.md,
          height: ITEM_HEIGHT,
          borderRadius: theme.radius.pill,
          backgroundColor: focused ? theme.color.brand : 'transparent',
          transform: [{ scale }],
        }}
      >
        {item.icon(focused ? theme.color.onBrand : theme.color.textMuted, focused)}
        {focused ? (
          <Animated.View style={{ opacity: labelOpacity }}>
            <Text variant="caption" tone="onBrand">
              {item.label}
            </Text>
          </Animated.View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}
