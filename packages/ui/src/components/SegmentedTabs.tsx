import { Pressable, View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface SegmentedTab<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * Tabs that divide one screen, not the app.
 *
 * `PillTabBar` moves you between destinations and floats above everything to
 * say so. This is the other kind: the page you are on has three faces and this
 * chooses which one. It reads as part of the page — a rule underneath, a mark
 * under the live one — because a second floating pill on the same screen would
 * be two things claiming to be the navigation.
 *
 * Small caps and letterspacing are the one place the app raises its voice like
 * this. It works here because the row is a label for what follows rather than
 * something to read, and because this screen has a single number on it.
 */
export function SegmentedTabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: readonly SegmentedTab<T>[];
}) {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: theme.color.border,
      }}
    >
      {tabs.map((tab) => {
        const live = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            onPress={() => onChange(tab.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: live }}
            accessibilityLabel={tab.label}
            style={({ pressed }) => ({
              flex: 1,
              alignItems: 'center',
              paddingVertical: theme.spacing.md,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text
              variant="caption"
              tone={live ? 'brand' : 'faint'}
              style={{ letterSpacing: 0.8, fontWeight: live ? '700' : '600' }}
            >
              {tab.label.toUpperCase()}
            </Text>
            {/* Drawn whether or not it is live, so the label does not shift by
                two points as you move between tabs. */}
            <View
              style={{
                position: 'absolute',
                left: theme.spacing.lg,
                right: theme.spacing.lg,
                bottom: -1,
                height: 2,
                borderRadius: 1,
                backgroundColor: live ? theme.color.brand : 'transparent',
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
