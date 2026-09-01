import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface SegmentedTab<T extends string> {
  readonly value: T;
  readonly label: string;
  /**
   * A mark beside the word, drawn in whatever colour the tab is wearing — the
   * same shape `ChipRow` uses, so one convention covers both. Optional: a tab
   * row where only some tabs had a glyph would read as an accident, so pass one
   * for every tab or for none.
   */
  readonly icon?: (color: string) => ReactNode;
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
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.sm,
              paddingVertical: theme.spacing.md,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            {tab.icon?.(live ? theme.color.brand : theme.color.textFaint)}
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
