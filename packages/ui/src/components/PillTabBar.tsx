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
 * Kept for source compatibility with callers that used the old raised centre
 * button. The WhatsApp-style bar has no floating action, so this is inert — a
 * primary action lives in a screen header now, not in the nav.
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
 * `centerAction` is accepted but ignored: this bar has no raised button.
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
  /** Ignored — kept so existing callers still type-check. */
  centerAction?: PillTabAction;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

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
      onPress={() => onSelect(item.key)}
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
            borderRadius: INDICATOR_HEIGHT / 2,
            alignItems: 'center',
            justifyContent: 'center',
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
}
