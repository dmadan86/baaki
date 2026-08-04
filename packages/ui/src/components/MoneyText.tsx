import {
  balanceDirection,
  copyFor,
  format,
  moneyAccessibilityLabel,
  type BalanceDirection,
  type CurrencyCode,
  type Money,
} from '@baaki/core';

import { Text, type TextProps, type TextVariant } from './Text';

export interface MoneyTextProps extends Omit<TextProps, 'children' | 'tone'> {
  amount: bigint;
  currency: CurrencyCode;
  locale?: string;
  variant?: TextVariant;
  /**
   * 'balance' colours by sign (owed-to-you green, you-owe red) and prefixes a
   * spoken label. 'plain' renders a neutral amount — use it for expense totals,
   * which belong to nobody in particular.
   */
  mode?: 'balance' | 'plain';
  /** Force the direction instead of deriving it from the sign. */
  direction?: BalanceDirection;
  compactFraction?: boolean;
  showSign?: boolean;
}

/**
 * Money is never rendered as a bare number: it carries its own colour semantics
 * and a screen-reader label ("You are owed ₹420") — TDR §11.
 */
export function MoneyText({
  amount,
  currency,
  locale = 'en-IN',
  variant = 'subheading',
  mode = 'plain',
  direction,
  compactFraction = true,
  showSign = false,
  ...rest
}: MoneyTextProps) {
  const money: Money = { minor: amount, currency };
  const resolvedDirection = direction ?? balanceDirection(amount);
  const strings = copyFor(locale).money;

  const rendered = format(mode === 'balance' ? { ...money, minor: abs(amount) } : money, {
    locale,
    compactFraction,
    signDisplay: showSign ? 'always' : 'auto',
  });

  const tone =
    mode === 'balance'
      ? resolvedDirection === 'owed_to_you'
        ? 'positive'
        : resolvedDirection === 'you_owe'
          ? 'negative'
          : 'muted'
      : 'default';

  return (
    <Text
      variant={variant}
      tone={tone}
      tabular
      accessibilityLabel={
        mode === 'balance'
          ? moneyAccessibilityLabel(money, resolvedDirection, strings, {
              locale,
              compactFraction,
            })
          : rendered
      }
      {...rest}
    >
      {rendered}
    </Text>
  );
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
