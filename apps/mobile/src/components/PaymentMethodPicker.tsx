/**
 * How a spend was paid — a horizontal row of chips (cash, UPI, card, …).
 *
 * The id is what persists to the free-text `payment_method` column, so any of
 * these is safe to store; the icon and label are UI. Debit wears the filled
 * card so it reads apart from credit's outline at chip size. `upi` is offered
 * only where the rail exists (see `deviceSupportsUpi`); everywhere else the row
 * is the region rails a person would recognise. One row that scrolls sideways
 * rather than wrapping, so the block keeps a fixed height however many rails a
 * region offers.
 *
 * Shared so the capture screen, add-expense, and add-person all speak the same
 * language for the same field.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView } from 'react-native';

import { type PaymentMethod } from '@waves/core';
import { iconSize, Text, useTheme } from '@waves/ui';

import { deviceSupportsUpi, useStrings } from '@/i18n';

const PAYMENT_METHODS: readonly {
  id: PaymentMethod;
  icon: keyof typeof Ionicons.glyphMap;
  /** True for a rail that only some regions have — filtered by device support. */
  regional?: boolean;
}[] = [
  { id: 'cash', icon: 'cash-outline' },
  { id: 'upi', icon: 'phone-portrait-outline', regional: true },
  { id: 'credit', icon: 'card-outline' },
  { id: 'debit', icon: 'card' },
  { id: 'forex', icon: 'swap-horizontal-outline' },
];

export function PaymentMethodPicker({
  value,
  onChange,
}: {
  value: PaymentMethod | null;
  onChange: (value: PaymentMethod) => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();

  const label = (id: PaymentMethod): string => {
    switch (id) {
      case 'cash':
        return t.captures.payCash;
      case 'upi':
        return t.captures.payUpi;
      case 'credit':
        return t.captures.payCredit;
      case 'debit':
        return t.captures.payDebit;
      case 'forex':
        return t.captures.payForex;
    }
  };

  const upiSupported = deviceSupportsUpi();
  const methods = PAYMENT_METHODS.filter((method) => !method.regional || upiSupported);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.xl }}
    >
      {methods.map((method) => {
        const active = value === method.id;
        return (
          <Pressable
            key={method.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={label(method.id)}
            onPress={() => onChange(method.id)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: active ? theme.color.brand : theme.color.border,
              backgroundColor: active ? theme.color.brandSoft : theme.color.surface,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Ionicons
              name={method.icon}
              size={iconSize.md}
              color={active ? theme.color.brand : theme.color.textMuted}
            />
            <Text variant="body" style={{ color: active ? theme.color.brand : theme.color.text }}>
              {label(method.id)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
