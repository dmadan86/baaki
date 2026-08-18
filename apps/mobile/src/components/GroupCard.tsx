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
import { Pressable, View } from 'react-native';

import type { CurrencyCode } from '@waves/core';
import {
  Avatar,
  Badge,
  directionalIcon,
  iconSize,
  MoneyText,
  Row,
  Text,
  tintForKey,
  useTheme,
} from '@waves/ui';

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
    // Flat opacity feedback, no scale. The list scrolls a lot and every row a
    // Reanimated AnimatedPressable made the scroll heavy; a plain Pressable
    // still says "I heard you" without the zoom.
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${statusLabel}${pendingLabel ? `, ${pendingLabel}` : ''}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
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

        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          {/* Semantic money colour carries owed/owe at a glance (the tokens rule);
              `mode="balance"` abs-es the number and speaks the sign for a11y. */}
          <MoneyText
            amount={balance}
            currency={currency}
            locale={locale}
            mode="balance"
            variant="subheading"
          />
          {/* A pending settlement is a real, actionable state — it earns a
              labelled badge, not a 7px dot that reads as an unread mark. */}
          {pendingLabel ? (
            <Badge label={pendingLabel} tone="brand" />
          ) : (
            <Text
              variant="micro"
              tone={balance === 0n ? 'muted' : balance > 0n ? 'positive' : 'negative'}
            >
              {statusLabel}
            </Text>
          )}
        </View>

        <Ionicons
          name={directionalIcon('chevron-forward')}
          size={iconSize.md}
          color={theme.color.textFaint}
        />
      </Row>
    </Pressable>
  );
}
