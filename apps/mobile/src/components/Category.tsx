/**
 * The category, as a thing you can see and change.
 *
 * `CategoryBadge` is the tinted circle that stands in for an expense in a list
 * — a fork for dinner, an auto for the ride — which is worth more than the two
 * initials of a description at a glance.
 *
 * `CategoryPicker` is the row of chips under the description on the
 * add-expense screen. It is pre-selected from what was typed
 * (`guessCategory`), and the moment somebody taps a chip themselves the guess
 * stops overriding them: a field that keeps changing under your finger is
 * worse than no field.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, View } from 'react-native';

import { CATEGORIES, categoryOf, type CategoryId } from '@baaki/core';
import { Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

export function CategoryBadge({
  category,
  size = 42,
}: {
  category: string | null | undefined;
  size?: number;
}) {
  const theme = useTheme();
  const resolved = categoryOf(category);
  const tint = theme.tint[resolved.tint];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tint.bg,
      }}
    >
      <Ionicons
        name={resolved.icon as keyof typeof Ionicons.glyphMap}
        size={Math.round(size * 0.5)}
        color={tint.ink}
      />
    </View>
  );
}

export function CategoryPicker({
  value,
  onChange,
}: {
  value: CategoryId | null;
  onChange: (value: CategoryId) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.xl }}
    >
      {CATEGORIES.map((category) => {
        const selected = category.id === value;
        const tint = theme.tint[category.tint];
        const label = t.categories[category.id];
        return (
          <Pressable
            key={category.id}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            onPress={() => onChange(category.id)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
              height: 36,
              paddingHorizontal: theme.spacing.md,
              borderRadius: theme.radius.pill,
              backgroundColor: selected ? tint.bg : theme.color.surface,
              borderWidth: 1,
              borderColor: selected ? tint.ink : 'transparent',
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Ionicons
              name={category.icon as keyof typeof Ionicons.glyphMap}
              size={15}
              color={selected ? tint.ink : theme.color.textMuted}
            />
            <Text variant="caption" style={{ color: selected ? tint.ink : theme.color.textMuted }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
