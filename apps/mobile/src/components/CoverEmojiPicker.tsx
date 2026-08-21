/**
 * Picking the little icon a group wears.
 *
 * The old control was nine emoji crammed under the name field with no way to
 * reach a tenth — fine until the group is a badminton league or a wedding, and
 * then it is a wall. This is the same idea with room to breathe: a curated set,
 * grouped so the eye can find the row it wants, shown in a bottom sheet with the
 * current pick previewed large at the top.
 *
 * Deliberately not the whole emoji keyboard. A shared-expense group wants a
 * cover somebody recognises at a glance in a list, not 🫠 — so the set is the
 * trips, homes, meals, journeys and pastimes a group is actually named after.
 * Whatever is picked is stored as a single character, same as before.
 *
 * Two ways to open it. Left to itself it renders its own trigger (a compact
 * swatch or a button) and owns the open state. Passed `open`/`onOpenChange` it
 * is controlled and renders no trigger — so a caller can open it from somewhere
 * else entirely, like tapping the group's avatar.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, iconSize, Row, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

const EMOJI_GROUPS: readonly (readonly string[])[] = [
  ['🏖️', '🏝️', '⛰️', '🏔️', '🏕️', '🏜️', '🗺️', '✈️', '🚗', '🚕', '🚌', '🚆', '⛵', '🛵'],
  ['🏠', '🏡', '🏢', '🏨', '🏬', '🛏️', '🛋️', '🔑', '🧹', '💡', '🧾', '💰'],
  ['🍽️', '🍕', '🍔', '🍜', '🍣', '🍻', '☕', '🍩', '🎂', '🥡', '🛒'],
  ['🎉', '🎁', '🎈', '💜', '❤️', '🎵', '🎬', '🎮', '⚽', '🏀', '🏏', '🏸', '🧗', '🏊'],
  ['🎓', '💼', '📚', '👥', '🐶', '🐱', '🌱', '🌸', '⭐', '🌈'],
];

export function CoverEmojiPicker({
  value,
  onChange,
  compact = false,
  open,
  onOpenChange,
}: {
  value: string | null;
  onChange: (emoji: string) => void;
  /** A small emoji-swatch pill instead of a full button, for tight layouts. */
  compact?: boolean;
  /** Controlled open state. When set, no trigger is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const insets = useSafeAreaInsets();
  const [internalOpen, setInternalOpen] = useState(false);

  const controlled = open !== undefined;
  const isOpen = controlled ? open : internalOpen;
  const setOpen = (next: boolean): void => {
    if (controlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };

  return (
    <>
      {controlled ? null : compact ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.group.chooseIcon}
          onPress={() => setOpen(true)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            alignSelf: 'flex-start',
            gap: 6,
            height: 32,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.color.surfaceMuted,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ fontSize: 16 }}>{value ?? '🙂'}</Text>
          <Text variant="caption" tone="muted">
            {t.group.chooseIcon}
          </Text>
        </Pressable>
      ) : (
        <Button
          label={t.group.chooseIcon}
          size="sm"
          variant="secondary"
          onPress={() => setOpen(true)}
        />
      )}

      <Modal
        visible={isOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        {/* A bottom sheet, not a full page: a dim backdrop you can tap to
            dismiss, over a rounded card anchored to the bottom. */}
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          {/* Dim scrim; tap to dismiss. Kept out of the accessibility tree —
              the header's close button is the labelled way out, so a
              full-screen dismissal target would only add screen-reader noise.
              No theme scrim token exists; this matches the app's modal dim. */}
          <Pressable
            onPress={() => setOpen(false)}
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
              maxHeight: '82%',
              backgroundColor: theme.color.surface,
              borderTopLeftRadius: theme.radius.xxl,
              borderTopRightRadius: theme.radius.xxl,
              paddingTop: theme.spacing.sm,
              paddingBottom: insets.bottom + theme.spacing.md,
            }}
          >
            {/* Grab handle */}
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

            <Row
              style={{
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingHorizontal: theme.spacing.xl,
              }}
            >
              <Text variant="heading">{t.group.chooseIcon}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.common.close}
                onPress={() => setOpen(false)}
                hitSlop={8}
                style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
              >
                <Ionicons name="close" size={iconSize.lg} color={theme.color.textMuted} />
              </Pressable>
            </Row>

            {/* The current pick, previewed large on a tinted circle. */}
            <View style={{ alignItems: 'center', paddingVertical: theme.spacing.lg }}>
              <View
                style={{
                  width: 84,
                  height: 84,
                  borderRadius: 28,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.color.brandSoft,
                }}
              >
                <Text style={{ fontSize: 44 }}>{value ?? '👥'}</Text>
              </View>
            </View>

            <ScrollView
              contentContainerStyle={{
                paddingHorizontal: theme.spacing.xl,
                paddingBottom: theme.spacing.xl,
                gap: theme.spacing.lg,
              }}
              showsVerticalScrollIndicator={false}
            >
              {EMOJI_GROUPS.map((emojis, index) => (
                <View key={index} style={{ gap: theme.spacing.sm }}>
                  {index > 0 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                  <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
                    {emojis.map((emoji) => {
                      const selected = value === emoji;
                      return (
                        <Pressable
                          key={emoji}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          accessibilityLabel={emoji}
                          onPress={() => {
                            onChange(emoji);
                            setOpen(false);
                          }}
                          style={{
                            width: 52,
                            height: 52,
                            borderRadius: theme.radius.lg,
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderWidth: selected ? 2 : 1,
                            borderColor: selected ? theme.color.brand : theme.color.border,
                            backgroundColor: selected
                              ? theme.color.brandSoft
                              : theme.color.surfaceMuted,
                          }}
                        >
                          <Text style={{ fontSize: 26 }}>{emoji}</Text>
                        </Pressable>
                      );
                    })}
                  </Row>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
