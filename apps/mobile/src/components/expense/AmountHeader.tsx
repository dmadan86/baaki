/**
 * The amount-forward hero the expense forms share.
 *
 * The number is the point of these screens, so it leads — big and centred, with
 * the currency it is counted in a tap below it (the Splitwise/PayPal amount-
 * first pattern). No card around it; the whitespace is the frame. The pill shows
 * the current currency and opens the screen's own currency picker on tap.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { currencySymbol } from '@waves/core';
import { AmountField, iconSize, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

export function AmountHeader({
  currency,
  amount,
  onAmountChange,
  onPressCurrency,
}: {
  currency: string;
  amount: bigint;
  onAmountChange: (value: bigint) => void;
  onPressCurrency: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
      <AmountField currency={currency} value={amount} onChange={onAmountChange} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t.captures.currencyLabel}: ${currency}`}
        onPress={onPressCurrency}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.xs,
          paddingVertical: theme.spacing.xs,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.color.surfaceMuted,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text variant="caption" tone="muted">
          {currencySymbol(currency)}
        </Text>
        <Text variant="caption" style={{ fontWeight: '700', color: theme.color.text }}>
          {currency}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.sm} color={theme.color.textMuted} />
      </Pressable>
    </View>
  );
}
