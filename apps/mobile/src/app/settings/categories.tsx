/**
 * Manage your expense tags (extends TDR §8).
 *
 * One ordered list of everything the pickers show: the ten built-ins and the
 * tags you have made yourself. From here you can make a new tag, edit or delete
 * your own, hide a built-in you never use, and move any of them up or down so
 * the ones you reach for sit first.
 *
 * The order and the hidden state live on the same per-user `category_tags` rows
 * the tags themselves do — a built-in you touch here quietly gains an override
 * row carrying just its place and whether it is hidden; its label stays in the
 * app's own string table.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import type { CatalogEntry } from '@waves/core';
import {
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  Toggle,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { TagEditorSheet } from '@/components/TagEditorSheet';
import { useCategoryCatalog, useUpsertTag } from '@/data/hooks';
import { useStrings } from '@/i18n';

export default function CategoriesSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const upsertTag = useUpsertTag();

  const { all } = useCategoryCatalog((id) => t.categories[id as keyof typeof t.categories]);

  // The editor sheet: an entry to edit, or the "new tag" flag.
  const [editing, setEditing] = useState<CatalogEntry | null>(null);
  const [creating, setCreating] = useState(false);

  // The upsert payload for one entry, with a field or two overridden. A custom
  // tag carries its whole display so a re-save never blanks it; a built-in
  // carries only its place and hidden flag (its label is in the string table).
  const persist = (entry: CatalogEntry, over: { sortOrder?: number; hidden?: boolean }): void => {
    if (entry.custom) {
      upsertTag.mutate({
        tagId: entry.tagId ?? undefined,
        label: entry.label,
        icon: entry.icon,
        tint: entry.tint,
        sortOrder: over.sortOrder ?? entry.sortOrder,
        hidden: over.hidden ?? entry.hidden,
      });
    } else {
      upsertTag.mutate({
        tagId: entry.tagId ?? undefined,
        builtinId: entry.builtinId,
        sortOrder: over.sortOrder ?? entry.sortOrder,
        hidden: over.hidden ?? entry.hidden,
      });
    }
  };

  // Move an entry up or down by swapping its order with its neighbour. Both
  // rows are persisted with the other's sort_order; a built-in with no override
  // yet gains one here.
  const move = (index: number, direction: -1 | 1): void => {
    const other = index + direction;
    if (other < 0 || other >= all.length) return;
    const a = all[index]!;
    const b = all[other]!;
    persist(a, { sortOrder: b.sortOrder });
    persist(b, { sortOrder: a.sortOrder });
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md, alignItems: 'center' }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.tags.manageTitle}</Text>
          </View>
          <IconButton label={t.tags.newTag} onPress={() => setCreating(true)}>
            <Ionicons name="add" size={iconSize.xxl} color={theme.color.brand} />
          </IconButton>
        </Row>

        <Text variant="caption" tone="muted" align="center">
          {t.tags.manageSubtitle}
        </Text>

        {all.length === 0 ? (
          <View style={{ paddingTop: theme.spacing.xxxl }}>
            <EmptyState title={t.tags.noCustomTags} />
          </View>
        ) : (
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {all.map((entry, index) => (
              <View key={entry.key}>
                {index > 0 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
                <Row
                  style={{
                    alignItems: 'center',
                    paddingVertical: theme.spacing.md,
                    gap: theme.spacing.sm,
                  }}
                >
                  {/* Reorder controls. `move` is a no-op at the ends, and the
                      arrow dims there, so the list cannot push a row off an edge. */}
                  <View style={{ gap: 2 }}>
                    <IconButton label={`${entry.label} ▲`} onPress={() => move(index, -1)}>
                      <Ionicons
                        name="chevron-up"
                        size={iconSize.md}
                        color={index === 0 ? theme.color.textFaint : theme.color.textMuted}
                      />
                    </IconButton>
                    <IconButton label={`${entry.label} ▼`} onPress={() => move(index, 1)}>
                      <Ionicons
                        name="chevron-down"
                        size={iconSize.md}
                        color={
                          index === all.length - 1 ? theme.color.textFaint : theme.color.textMuted
                        }
                      />
                    </IconButton>
                  </View>

                  <CategoryBadge
                    category={entry.key}
                    meta={
                      entry.custom
                        ? { label: entry.label, icon: entry.icon, tint: entry.tint }
                        : null
                    }
                    size={40}
                  />

                  <Text
                    variant="body"
                    numberOfLines={1}
                    style={{ flex: 1, opacity: entry.hidden ? 0.5 : 1 }}
                  >
                    {entry.label}
                  </Text>

                  {/* A custom tag is edited (and deleted) in the sheet; a
                      built-in is only ever hidden or shown. */}
                  {entry.custom ? (
                    <IconButton label={t.common.edit} onPress={() => setEditing(entry)}>
                      <Ionicons name="pencil" size={iconSize.md} color={theme.color.textMuted} />
                    </IconButton>
                  ) : (
                    <Toggle
                      value={!entry.hidden}
                      onValueChange={(shown) => persist(entry, { hidden: !shown })}
                      accessibilityLabel={entry.hidden ? t.tags.show : t.tags.hide}
                    />
                  )}
                </Row>
              </View>
            ))}
          </Card>
        )}

        <Text variant="micro" tone="muted" align="center">
          {t.tags.reorderHint}
        </Text>
      </ScrollView>

      <TagEditorSheet open={creating} onClose={() => setCreating(false)} />
      <TagEditorSheet open={editing !== null} editing={editing} onClose={() => setEditing(null)} />
    </Screen>
  );
}
