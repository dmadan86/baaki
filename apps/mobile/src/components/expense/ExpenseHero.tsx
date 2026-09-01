/**
 * The header the expense *form* wears — the same panel the expense screen wears.
 *
 * Viewing a bill and editing it used to be two unrelated places: the view was a
 * brand wash carrying the category badge, the title and the amount; the form was
 * a white page with a centred word at the top and a 44pt number floating in the
 * middle of it, so the number moved, changed colour and changed size the moment
 * you tapped Edit. Here the form opens on the same wash, with the category badge
 * in the same corner and the amount on the same line — the only difference being
 * that on this side you can type into it.
 *
 * That also settles what the amount costs: it and its currency now share one
 * line inside the header instead of owning a third of the first screenful, and
 * the running total in the pinned action bar is no longer a second copy of a
 * number already shouting from the top.
 */

import { type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { currencySymbol, type CategoryMeta } from '@waves/core';
import { AmountField, directionalIcon, Gradient, iconSize, Row, Text, useTheme } from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { useStrings } from '@/i18n';

export function ExpenseHero({
  title,
  category,
  categoryMeta,
  description,
  currency,
  amount,
  onAmountChange,
  onPressCurrency,
  right,
  leading = 'back',
}: {
  /** The one line above the amount: what this form is, and where it lands. */
  title: string;
  category: string | null;
  categoryMeta?: CategoryMeta | null;
  /** What has been typed so far — the badge sharpens its guess from it. */
  description?: string | null;
  currency: string;
  amount: bigint;
  onAmountChange: (value: bigint) => void;
  onPressCurrency: () => void;
  /** A trailing action; a 44pt spacer keeps the row balanced when omitted. */
  right?: ReactNode;
  /** A modal (capture) dismisses with an X; a pushed page goes back. */
  leading?: 'close' | 'back';
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();

  return (
    <Gradient
      radius={0}
      colors={theme.gradient.brand}
      style={{
        paddingTop: insets.top + theme.spacing.md,
        paddingHorizontal: theme.spacing.xl,
        paddingBottom: theme.spacing.lg,
        borderBottomLeftRadius: theme.radius.xxl,
        borderBottomRightRadius: theme.radius.xxl,
      }}
    >
      <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={leading === 'back' ? t.common.back : t.common.close}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Ionicons
            name={leading === 'back' ? directionalIcon('chevron-back') : 'close'}
            size={iconSize.xxl}
            color={theme.color.onBrand}
          />
        </Pressable>

        {/* The same badge, in the same place, as on the expense screen — it moves
            as the note is typed, so the guess is visible before saving rather
            than a surprise on the bill afterwards. */}
        <CategoryBadge
          category={category}
          meta={categoryMeta}
          description={description}
          size={40}
        />

        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text variant="micro" tone="onBrand" numberOfLines={1} style={{ opacity: 0.85 }}>
            {title}
          </Text>
          {/* Amount and currency on one line: the number leads, the code it is
              counted in sits at the end of it as the pill that opens the picker. */}
          <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <AmountField
              currency={currency}
              value={amount}
              onChange={onAmountChange}
              size="hero"
              tone="onBrand"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t.captures.currencyLabel}: ${currency}`}
              onPress={onPressCurrency}
              hitSlop={10}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.xs,
                // A real tap target, not a label: the pill is the only way to
                // change the currency, and `hitSlop` alone left it under 44pt.
                minHeight: 36,
                paddingVertical: theme.spacing.xs,
                paddingHorizontal: theme.spacing.md,
                borderRadius: theme.radius.pill,
                // A translucent white chip rather than a surface colour: the wash
                // runs three stops, and a solid pill would only match one of them.
                backgroundColor: 'rgba(255,255,255,0.18)',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.8 }}>
                {currencySymbol(currency)}
              </Text>
              <Text variant="caption" tone="onBrand" style={{ fontWeight: '700' }}>
                {currency}
              </Text>
              <Ionicons name="chevron-down" size={iconSize.sm} color={theme.color.onBrand} />
            </Pressable>
          </Row>
        </View>

        {right ?? <View style={{ width: 44 }} />}
      </Row>
    </Gradient>
  );
}
