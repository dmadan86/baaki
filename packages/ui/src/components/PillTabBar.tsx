import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface PillTabItem {
  key: string;
  label: string;
  /** Receives the resolved colour so icons match the active/inactive state. */
  icon: (color: string, focused: boolean) => ReactNode;
}

/**
 * The floating pill navigation from the reference boards: a white capsule that
 * hovers over the content, with the active destination expanding into a filled
 * purple pill that also shows its label.
 */
export function PillTabBar({
  items,
  activeKey,
  onSelect,
}: {
  items: readonly PillTabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        position: 'absolute',
        left: theme.spacing.xl,
        right: theme.spacing.xl,
        bottom: Math.max(insets.bottom, theme.spacing.lg),
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
      {items.map((item) => {
        const focused = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={item.label}
            onPress={() => onSelect(item.key)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: focused ? theme.spacing.sm : 0,
              paddingHorizontal: focused ? theme.spacing.lg : theme.spacing.md,
              height: 44,
              borderRadius: theme.radius.pill,
              backgroundColor: focused ? theme.color.brand : 'transparent',
            }}
          >
            {item.icon(focused ? theme.color.onBrand : theme.color.textMuted, focused)}
            {focused ? (
              <Text variant="caption" tone="onBrand">
                {item.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
