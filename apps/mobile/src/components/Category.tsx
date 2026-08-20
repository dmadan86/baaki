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

import { CATEGORIES, categoryOf, type CategoryId } from '@waves/core';
import { iconSize, Text, useTheme } from '@waves/ui';

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
        const label = t.categories[category.id];
        return (
          <Pressable
            key={category.id}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            onPress={() => onChange(category.id)}
            // Same chip shape and brand tint as the "Paid with" row on the same
            // screen, so the two selectors read as one language rather than the
            // louder per-category fill this used to wear.
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
              // A 44pt floor keeps the chip a comfortable tap target — the body
              // text plus `sm` padding alone left it ~37pt, under the iOS 44 /
              // Android 48 minimum.
              minHeight: 44,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: selected ? theme.color.brand : theme.color.border,
              backgroundColor: selected ? theme.color.brandSoft : theme.color.surface,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Ionicons
              name={category.icon as keyof typeof Ionicons.glyphMap}
              size={iconSize.md}
              color={selected ? theme.color.brand : theme.color.textMuted}
            />
            <Text variant="body" style={{ color: selected ? theme.color.brand : theme.color.text }}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
