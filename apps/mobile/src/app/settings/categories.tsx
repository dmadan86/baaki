/**
 * Manage your expense tags (extends TDR §8).
 *
 * One ordered list of everything the pickers show: the ten built-ins and the
 * tags you have made yourself. From here you can make a new tag, edit or delete
 * your own, hide a built-in you never use, and drag any of them up or down so
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
import { Pressable, View } from 'react-native';
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from 'react-native-draggable-flatlist';

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
import { useCategoryCatalog, useUpsertTag, type TagUpsertInput } from '@/data/hooks';
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

  // The list drives its own order while a drag is in flight, then commits and
  // lets the catalog read (the source of truth) flow back in. When the catalog
  // itself changes (a tag added, hidden, a reorder synced) we resnap to it —
  // done during render off a remembered reference, the sanctioned alternative to
  // a setState-in-effect sync.
  const [order, setOrder] = useState<CatalogEntry[]>(() => [...all]);
  const [catalogRef, setCatalogRef] = useState(all);
  if (catalogRef !== all) {
    setCatalogRef(all);
    setOrder([...all]);
  }

  // One drag settles at a time. A reorder that touches a built-in with no
  // override row yet mints a fresh row for it; letting a second drag start
  // before the first's rows have landed in the queue could mint a duplicate for
  // the same built-in and trip the (owner, builtin_id) unique index at sync.
  const [savingOrder, setSavingOrder] = useState(false);

  // The upsert payload for one entry, with a field or two overridden. A custom
  // tag carries its whole display so a re-save never blanks it; a built-in
  // carries only its place and hidden flag (its label is in the string table).
  const payloadFor = (
    entry: CatalogEntry,
    over: { sortOrder?: number; hidden?: boolean },
  ): TagUpsertInput =>
    entry.custom
      ? {
          tagId: entry.tagId ?? undefined,
          label: entry.label,
          icon: entry.icon,
          tint: entry.tint,
          sortOrder: over.sortOrder ?? entry.sortOrder,
          hidden: over.hidden ?? entry.hidden,
        }
      : {
          tagId: entry.tagId ?? undefined,
          builtinId: entry.builtinId,
          sortOrder: over.sortOrder ?? entry.sortOrder,
          hidden: over.hidden ?? entry.hidden,
        };

  const persist = (entry: CatalogEntry, over: { sortOrder?: number; hidden?: boolean }): void => {
    upsertTag.mutate(payloadFor(entry, over));
  };

  // Commit a dropped order. Each entry's new place is its index in the list, so
  // the stored `sort_order` (an integer) matches what the eye sees. Only the
  // rows whose place actually changed are written — after one full pass the
  // orders are already 0..n-1, so a later single drag touches just the span it
  // crossed. Each built-in is written at most once per drop, so no two writes
  // race for the same override row.
  const commitOrder = async (next: CatalogEntry[]): Promise<void> => {
    const changed = next
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => entry.sortOrder !== index);
    if (changed.length === 0) return;
    setSavingOrder(true);
    try {
      for (const { entry, index } of changed) {
        await upsertTag.mutateAsync(payloadFor(entry, { sortOrder: index }));
      }
    } finally {
      setSavingOrder(false);
    }
  };

  const renderItem = ({ item: entry, drag, isActive }: RenderItemParams<CatalogEntry>) => (
    <ScaleDecorator>
      <Card
        padded={false}
        style={{
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          marginBottom: theme.spacing.sm,
          // The lifted row reads as picked-up: a touch brighter, a touch raised.
          ...(isActive ? { borderColor: theme.color.brand, elevation: 4, opacity: 0.97 } : null),
        }}
      >
        <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          {/* The grip is the one thing that starts a drag: press and hold it,
              then move. Disabled while a previous reorder is still saving so two
              drops can't race to mint the same built-in's override row. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${entry.label} — ${t.tags.dragHandle}`}
            accessibilityState={{ disabled: savingOrder }}
            disabled={savingOrder || isActive}
            onLongPress={drag}
            delayLongPress={120}
            style={({ pressed }) => ({
              paddingVertical: theme.spacing.xs,
              paddingRight: theme.spacing.xs,
              opacity: savingOrder ? 0.4 : pressed ? 0.5 : 1,
            })}
          >
            <Ionicons name="reorder-three" size={iconSize.lg} color={theme.color.textMuted} />
          </Pressable>

          <CategoryBadge
            category={entry.key}
            meta={entry.custom ? { label: entry.label, icon: entry.icon, tint: entry.tint } : null}
            size={32}
          />

          <Text
            variant="body"
            numberOfLines={1}
            style={{ flex: 1, opacity: entry.hidden ? 0.5 : 1 }}
          >
            {entry.label}
          </Text>

          {/* A custom tag is edited (and deleted) in the sheet; a built-in is
              only ever hidden or shown. */}
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
      </Card>
    </ScaleDecorator>
  );

  return (
    <Screen>
      <DraggableFlatList
        data={order}
        keyExtractor={(entry) => entry.key}
        renderItem={renderItem}
        onDragEnd={({ data }) => {
          setOrder(data);
          void commitOrder(data);
        }}
        containerStyle={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
        }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View>
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

            {/* Hugs the header (small top margin) rather than sitting a full gap
                below it, so the intro reads as a subtitle of the title above. */}
            <Text
              variant="caption"
              tone="muted"
              align="center"
              style={{ marginTop: theme.spacing.sm, marginBottom: theme.spacing.lg }}
            >
              {t.tags.manageSubtitle}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <View style={{ paddingTop: theme.spacing.xxxl }}>
            <EmptyState title={t.tags.noCustomTags} />
          </View>
        }
        ListFooterComponent={
          order.length > 0 ? (
            <Text
              variant="micro"
              tone="muted"
              align="center"
              style={{ marginTop: theme.spacing.md }}
            >
              {t.tags.reorderHint}
            </Text>
          ) : null
        }
      />

      <TagEditorSheet open={creating} onClose={() => setCreating(false)} />
      <TagEditorSheet open={editing !== null} editing={editing} onClose={() => setEditing(null)} />
    </Screen>
  );
}
