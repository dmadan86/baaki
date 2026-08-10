/**
 * Picking the little icon a group wears.
 *
 * The old control was nine emoji crammed under the name field with no way to
 * reach a tenth — fine until the group is a badminton league or a wedding, and
 * then it is a wall. This is the same idea with room to breathe: one button that
 * opens a wide, curated set, grouped so the eye can find the row it wants.
 *
 * Deliberately not the whole emoji keyboard. A shared-expense group wants a
 * cover somebody recognises at a glance in a list, not 🫠 — so the set is the
 * trips, homes, meals, journeys and pastimes a group is actually named after.
 * Whatever is picked is stored as a single character, same as before.
 */

import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { Button, Card, Row, Screen, Text, useTheme } from '@baaki/ui';

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
}: {
  value: string | null;
  onChange: (emoji: string) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        label={t.group.chooseIcon}
        size="sm"
        variant="secondary"
        onPress={() => setOpen(true)}
      />

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <Screen edges={['top', 'bottom']}>
          <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
            <Text variant="heading">{t.group.chooseIcon}</Text>
          </View>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.xxxl,
              gap: theme.spacing.lg,
            }}
            showsVerticalScrollIndicator={false}
          >
            {EMOJI_GROUPS.map((emojis, index) => (
              <Card key={index} style={{ gap: theme.spacing.sm }}>
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
                          width: 48,
                          height: 48,
                          borderRadius: theme.radius.pill,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: selected
                            ? theme.color.brandSoft
                            : theme.color.surfaceMuted,
                        }}
                      >
                        <Text style={{ fontSize: 24 }}>{emoji}</Text>
                      </Pressable>
                    );
                  })}
                </Row>
              </Card>
            ))}
          </ScrollView>

          <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.lg }}>
            <Button
              label={t.common.close}
              variant="ghost"
              fullWidth
              onPress={() => setOpen(false)}
            />
          </View>
        </Screen>
      </Modal>
    </>
  );
}
