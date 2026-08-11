/**
 * A group as a compact, full-colour row.
 *
 * The tint is the same colour the group's avatar wears everywhere else
 * (`tintForKey`), now filling the whole card — so a list of groups reads as a
 * stack of stable, recognisable colours rather than a wall of white.
 *
 * It used to be a tall two-row panel: a 30pt balance, an avatar cluster, and
 * generous padding meant three or four groups filled the screen and a longer
 * list was all scrolling. This is the same information on one row — name and
 * member count on the left, the balance and its owed/owe word on the right —
 * so twice as many groups fit before anybody has to scroll.
 *
 * Money colour, on purpose, is NOT the mint/red pair here. On a saturated
 * surface green-on-mint disappears and red-on-pink muddies; the balance is
 * painted in the tint's own ink for contrast and the owed/owe meaning is
 * carried by the label beneath it and the sign (see MoneyText `tone`).
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import type { CurrencyCode } from '@baaki/core';
import { directionalIcon, MoneyText, Row, Text, TintCard, tintForKey, useTheme } from '@baaki/ui';

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
  const tint = tintForKey(id);
  const ink = theme.tint[tint].ink;
  const inkMuted = theme.tint[tint].inkMuted;
  const initial = title.trim().charAt(0).toUpperCase() || '•';

  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${statusLabel}${pendingLabel ? `, ${pendingLabel}` : ''}`}
    >
      <TintCard tint={tint} style={{ borderRadius: theme.radius.lg, padding: theme.spacing.lg }}>
        <Row style={{ gap: theme.spacing.md }}>
          {/* A white chip carries the emoji (or the name's first letter) at
              full contrast, whatever the card's tint. */}
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: theme.radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.surface,
            }}
          >
            {coverEmoji ? (
              <Text variant="subheading">{coverEmoji}</Text>
            ) : (
              <Text variant="subheading" style={{ color: ink }}>
                {initial}
              </Text>
            )}
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="subheading" numberOfLines={1} style={{ color: ink }}>
              {title}
            </Text>
            <Text variant="caption" numberOfLines={1} style={{ color: inkMuted }}>
              {memberLabel}
            </Text>
          </View>

          <View style={{ alignItems: 'flex-end' }}>
            <Row style={{ gap: theme.spacing.xs }}>
              {/* A pending settlement gets a quiet dot rather than a full-width
                  badge — the row has no room for a sentence. */}
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
                variant="heading"
                style={{ color: ink }}
              />
            </Row>
            <Text variant="micro" style={{ color: inkMuted }}>
              {statusLabel}
            </Text>
          </View>

          <Ionicons
            name={directionalIcon('chevron-forward')}
            size={18}
            color={ink}
            style={{ opacity: 0.5 }}
          />
        </Row>
      </TintCard>
    </PressableScale>
  );
}
