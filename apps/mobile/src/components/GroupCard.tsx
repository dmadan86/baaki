/**
 * A group as one flat list row, WhatsApp-style.
 *
 * This used to be a full-colour `TintCard` — the group's tint filling the whole
 * card. The list is now flat rows on a plain surface, separated by hairlines
 * rather than by colour: an avatar carries the group's identity (and its
 * colour), the name and member count read in the ordinary ink, and the balance
 * sits at the trailing edge. The owed/owe meaning is the word beneath the
 * amount and the amount's sign, not the row's background.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import type { CurrencyCode } from '@baaki/core';
import { Avatar, directionalIcon, MoneyText, Row, Text, tintForKey, useTheme } from '@baaki/ui';

import { PressableScale } from '@/lib/anim';

export function GroupCard({
  id,
  title,
  memberLabel,
  coverEmoji,
  balance,
  currency,
  locale,
  statusLabel,
  pendingLabel,
  onPress,
}: {
  id: string;
  title: string;
  /** "4 members", already pluralised for the locale. */
  memberLabel: string;
  coverEmoji?: string | null;
  balance: bigint;
  currency: CurrencyCode;
  locale: string;
  /** "you're owed" / "you owe" / "all settled" — the sign in words. */
  statusLabel: string;
  /** Badge text when a settlement is awaiting confirmation, else null. */
  pendingLabel: string | null;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${statusLabel}${pendingLabel ? `, ${pendingLabel}` : ''}`}
    >
      <Row
        style={{ gap: theme.spacing.md, alignItems: 'center', paddingVertical: theme.spacing.md }}
      >
        {/* The avatar keeps the group's colour and initial — WhatsApp rows are
            flat, but the face on the left still tells one row from the next. */}
        <Avatar name={title} emoji={coverEmoji ?? undefined} size={46} tint={tintForKey(id)} />

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="subheading" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {memberLabel}
          </Text>
        </View>

        <View style={{ alignItems: 'flex-end' }}>
          <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
            {/* A pending settlement gets a quiet dot rather than a badge. */}
            {pendingLabel ? (
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: theme.color.brand,
                }}
              />
            ) : null}
            <MoneyText
              amount={balance < 0n ? -balance : balance}
              currency={currency}
              locale={locale}
              tone="default"
              variant="subheading"
            />
          </Row>
          <Text variant="micro" tone="muted">
            {statusLabel}
          </Text>
        </View>

        <Ionicons
          name={directionalIcon('chevron-forward')}
          size={18}
          color={theme.color.textFaint}
        />
      </Row>
    </PressableScale>
  );
}
