/**
 * The category, as a thing you can see and change.
 *
 * `CategoryBadge` is the tinted circle that stands in for an expense in a list
 * — a fork for dinner, an auto for the ride — which is worth more than the two
 * initials of a description at a glance. It renders a built-in from its id, or a
 * custom tag from the {label, icon, tint} snapshot carried on the expense
 * (`meta`), so a groupmate without the author's catalog still sees it.
 *
 * `CategoryPicker` is the row of chips under the description on the add-expense
 * and capture screens. It now draws the person's whole catalog — built-ins plus
 * their own tags, in their chosen order — and ends with a "＋ New tag" chip. It
 * is pre-selected from what was typed (`guessCategory`), and the moment somebody
 * taps a chip themselves the guess stops overriding them.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, View } from 'react-native';

import { guessIcon, normaliseTint, resolveCategory, type CategoryMeta } from '@waves/core';
import { iconSize, Text, useTheme } from '@waves/ui';

import { useCategoryCatalog } from '@/data/hooks';
import { useStrings } from '@/i18n';

export function CategoryBadge({
  category,
  meta,
  description,
  size = 42,
}: {
  category: string | null | undefined;
  /** The custom tag's denormalised display, when the value is a custom tag. */
  meta?: CategoryMeta | null;
  /** The expense's own words. When given, the badge draws the specific icon for
   *  what was typed (a coffee cup for a chai) and falls back to the category
   *  icon when nothing matches. Omit on aggregate badges (per-category rows in
   *  insights/budgets), where only the category itself is meaningful. Never
   *  overrides a custom tag's chosen icon. */
  description?: string | null;
  size?: number;
}) {
  const theme = useTheme();
  const resolved = resolveCategory(category, meta ?? null);
  const tint = theme.tint[resolved.tint];
  // A custom tag keeps the icon its author picked; only built-ins get the
  // description-specific refinement over their single category icon.
  const icon = resolved.custom ? resolved.icon : (guessIcon(description) ?? resolved.icon);
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
        name={icon as keyof typeof Ionicons.glyphMap}
        size={Math.round(size * 0.5)}
        color={tint.ink}
      />
    </View>
  );
}

export function CategoryPicker({
  value,
  onChange,
  onCreate,
}: {
  value: string | null;
  /** The chosen category's key and, for a custom tag, its display snapshot to
   *  carry onto the expense (null for a built-in). */
  onChange: (key: string, meta: CategoryMeta | null) => void;
  /** Opens the create-tag sheet; the "＋ New tag" chip shows only when set. */
  onCreate?: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const { visible } = useCategoryCatalog((id) => t.categories[id as keyof typeof t.categories]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.xl }}
    >
      {visible.map((entry) => {
        const selected = entry.key === value;
        const meta: CategoryMeta | null = entry.custom
          ? { label: entry.label, icon: entry.icon, tint: normaliseTint(entry.tint) }
          : null;
        return (
          <Pressable
            key={entry.key}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={entry.label}
            onPress={() => onChange(entry.key, meta)}
            // One chip shape for built-ins and custom tags, so the person's own
            // tags read as first-class rather than an afterthought.
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
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
              name={entry.icon as keyof typeof Ionicons.glyphMap}
              size={iconSize.md}
              color={selected ? theme.color.brand : theme.color.textMuted}
            />
            <Text variant="body" style={{ color: selected ? theme.color.brand : theme.color.text }}>
              {entry.label}
            </Text>
          </Pressable>
        );
      })}

      {onCreate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.tags.newTag}
          onPress={onCreate}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
            minHeight: 44,
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.color.border,
            borderStyle: 'dashed',
            backgroundColor: theme.color.surface,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Ionicons name="add" size={iconSize.md} color={theme.color.brand} />
          <Text variant="body" style={{ color: theme.color.brand }}>
            {t.tags.newTag}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
