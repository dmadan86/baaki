/**
 * Make or edit one of your own expense tags (extends TDR §8).
 *
 * A tag is a name, an icon and a colour — the same three things a built-in
 * category is, so a custom tag reads as first-class beside them. This is the
 * bottom sheet that captures those three, previewed live as the badge it will
 * become, in the same sheet grammar the group icon picker uses.
 *
 * Controlled: the caller owns `open` and passes the tag to edit (or null to
 * create). Saving queues an upsert through the personal catalog; deleting soft-
 * removes it, and past expenses keep the snapshot they were tagged with.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Alert, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TINTS, type CatalogEntry, type TintName } from '@waves/core';
import { Button, iconSize, Row, Text, useTheme } from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { DEFAULT_TAG_ICON, TAG_ICON_GROUPS } from '@/components/tagIcons';
import { useDeleteTag, useUpsertTag } from '@/data/hooks';
import { useStrings } from '@/i18n';

export function TagEditorSheet({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  /** The custom tag to edit, or null to create a fresh one. */
  editing?: CatalogEntry | null;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          onPress={onClose}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: '#00000080',
          }}
        />

        <View
          style={{
            maxHeight: '88%',
            backgroundColor: theme.color.surface,
            borderTopLeftRadius: theme.radius.xxl,
            borderTopRightRadius: theme.radius.xxl,
            paddingTop: theme.spacing.sm,
            paddingBottom: insets.bottom + theme.spacing.md,
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.color.border,
              marginBottom: theme.spacing.md,
            }}
          />

          {/* Mount the form fresh each time the sheet opens (keyed on the tag),
              so its fields initialise from the tag being edited without a
              setState-in-effect to seed them. */}
          {open ? (
            <TagEditorForm
              key={editing?.tagId ?? 'new'}
              editing={editing ?? null}
              onClose={onClose}
            />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/** The editable body — its own component so a remount (via `key`) reseeds the
 *  fields from props, no effect required. */
function TagEditorForm({
  editing,
  onClose,
}: {
  editing: CatalogEntry | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const upsertTag = useUpsertTag();
  const deleteTag = useDeleteTag();

  const [name, setName] = useState(editing?.label ?? '');
  const [icon, setIcon] = useState<string>(editing?.icon ?? DEFAULT_TAG_ICON);
  const [tint, setTint] = useState<TintName>((editing?.tint as TintName) ?? 'mint');

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && !upsertTag.isPending;

  const save = (): void => {
    if (!canSave) return;
    upsertTag.mutate(
      {
        tagId: editing?.tagId ?? undefined,
        label: trimmed,
        icon,
        tint,
        // Editing keeps the row's place; a new tag lands at the end (the hook
        // computes its order).
        sortOrder: editing?.sortOrder,
        hidden: editing?.hidden ?? false,
      },
      { onSuccess: onClose },
    );
  };

  const remove = (): void => {
    if (!editing?.tagId) return;
    Alert.alert(t.tags.editTag, t.tags.deleteConfirm, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => deleteTag.mutate(editing.tagId!, { onSuccess: onClose }),
      },
    ]);
  };

  return (
    <>
      <Row
        style={{
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: theme.spacing.xl,
        }}
      >
        <Text variant="heading">{editing ? t.tags.editTag : t.tags.newTag}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.common.close}
          onPress={onClose}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Ionicons name="close" size={iconSize.lg} color={theme.color.textMuted} />
        </Pressable>
      </Row>

      {/* The tag as it will look, updating as the fields change. */}
      <View style={{ alignItems: 'center', paddingVertical: theme.spacing.lg }}>
        <CategoryBadge category="preview" meta={{ label: trimmed, icon, tint }} size={84} />
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t.tags.namePlaceholder}
          placeholderTextColor={theme.color.textFaint}
          accessibilityLabel={t.common.name}
          maxLength={40}
          style={{
            fontSize: 17,
            fontWeight: '600',
            color: theme.color.text,
            backgroundColor: theme.color.surfaceMuted,
            borderRadius: theme.radius.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
          }}
        />

        {/* Colour — the six design-system tints as swatches. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.tags.colourLabel}
          </Text>
          <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
            {TINTS.map((name_) => {
              const swatch = theme.tint[name_];
              const selected = tint === name_;
              return (
                <Pressable
                  key={name_}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={name_}
                  onPress={() => setTint(name_)}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: swatch.bg,
                    borderWidth: selected ? 3 : 0,
                    borderColor: swatch.ink,
                  }}
                >
                  {selected ? (
                    <Ionicons name="checkmark" size={iconSize.md} color={swatch.ink} />
                  ) : null}
                </Pressable>
              );
            })}
          </Row>
        </View>

        {/* Icon — the curated glyph set, in bands (food, travel, home…) so the
            wide list reads rather than blurs into one grid. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.tags.iconLabel}
          </Text>
          {TAG_ICON_GROUPS.map((group, index) => (
            <View key={index} style={{ gap: theme.spacing.sm }}>
              {index > 0 ? (
                <View style={{ height: 1, backgroundColor: theme.color.border }} />
              ) : null}
              <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                {group.map((glyph) => {
                  const selected = icon === glyph;
                  return (
                    <Pressable
                      key={glyph}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={glyph}
                      onPress={() => setIcon(glyph)}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: theme.radius.md,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: selected ? 2 : 1,
                        borderColor: selected ? theme.color.brand : theme.color.border,
                        backgroundColor: selected
                          ? theme.color.brandSoft
                          : theme.color.surfaceMuted,
                      }}
                    >
                      <Ionicons
                        name={glyph}
                        size={iconSize.md}
                        color={selected ? theme.color.brand : theme.color.textMuted}
                      />
                    </Pressable>
                  );
                })}
              </Row>
            </View>
          ))}
        </View>

        <Button label={t.tags.saveTag} size="lg" fullWidth disabled={!canSave} onPress={save} />
        {editing?.tagId ? (
          <Button
            label={t.common.delete}
            variant="ghostDanger"
            onPress={remove}
            disabled={deleteTag.isPending}
          />
        ) : null}
      </ScrollView>
    </>
  );
}
