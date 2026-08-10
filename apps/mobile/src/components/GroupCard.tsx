/**
 * A group as a bold, full-colour card.
 *
 * The reference the look is drawn from puts each item on its own saturated
 * panel with the amount as the thing your eye lands on first. Baaki already
 * gives every group a stable tint (`tintForKey`), so the colour is not
 * decoration invented per screen — it is the same colour the group's avatar
 * wears everywhere else, now filling the whole card.
 *
 * Money colour, on purpose, is NOT the mint/red pair here. On a saturated
 * surface green-on-mint disappears and red-on-pink muddies; the balance is
 * painted in the tint's own ink for contrast and the owed/owe meaning is
 * carried by the label beneath it and the sign. This is the same concession
 * the brand hero already makes with white money on purple — a surface that
 * owns its contrast reads the amount, not the colour (see MoneyText `tone`).
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import type { CurrencyCode } from '@baaki/core';
import {
  AvatarStack,
  Badge,
  directionalIcon,
  MoneyText,
  Row,
  Text,
  TintCard,
  tintForKey,
  useTheme,
} from '@baaki/ui';

import { PressableScale } from '@/lib/anim';

export function GroupCard({
  id,
  title,
  memberLabel,
  memberNames,
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
  memberNames: readonly string[];
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

  return (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      <TintCard
        tint={tint}
        style={{ borderRadius: theme.radius.xl, padding: theme.spacing.xl, gap: theme.spacing.lg }}
      >
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Row style={{ flex: 1, gap: theme.spacing.md }}>
            {coverEmoji ? (
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: theme.radius.pill,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.color.surface,
                }}
              >
                <Text variant="subheading">{coverEmoji}</Text>
              </View>
            ) : null}
            <View style={{ flex: 1 }}>
              <Text variant="heading" numberOfLines={1} style={{ color: ink }}>
                {title}
              </Text>
              <Text variant="caption" style={{ color: ink, opacity: 0.7 }}>
                {memberLabel}
              </Text>
            </View>
          </Row>
          {memberNames.length > 0 ? <AvatarStack names={memberNames} size={30} max={3} /> : null}
        </Row>

        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <MoneyText
              amount={balance < 0n ? -balance : balance}
              currency={currency}
              locale={locale}
              tone="default"
              style={{ color: ink, fontSize: 30, lineHeight: 36, fontWeight: '700' }}
            />
            <Text variant="caption" style={{ color: ink, opacity: 0.8 }}>
              {statusLabel}
            </Text>
            {pendingLabel ? (
              <View style={{ marginTop: theme.spacing.xs, alignSelf: 'flex-start' }}>
                <Badge label={pendingLabel} tone="brand" />
              </View>
            ) : null}
          </View>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.text,
            }}
          >
            <Ionicons name={directionalIcon('arrow-forward')} size={20} color={theme.color.bg} />
          </View>
        </Row>
      </TintCard>
    </PressableScale>
  );
}
