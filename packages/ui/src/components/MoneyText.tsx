import { StyleSheet, Text as RNText, type TextStyle } from 'react-native';

import {
  balanceDirection,
  BalanceDirection,
  copyFor,
  formatParts,
  moneyAccessibilityLabel,
  type CurrencyCode,
  type Money,
} from '@baaki/core';

import { useTheme } from '../theme';
import { Text, toneColor, type TextProps, type TextTone, type TextVariant } from './Text';

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
  /**
   * Override the colour the mode would choose. Only for surfaces that own
   * their own contrast, such as white money on the brand panel — never to
   * paint a balance a colour that disagrees with its sign.
   */
  tone?: TextTone;
  /**
   * Render the paise fainter than the rupees. On by default: the minor units
   * are the least important digits on the screen and reading them at full
   * weight is what makes a large balance hard to take in at a glance.
   *
   * Faded, not recoloured — the fraction stays whatever colour the amount is,
   * so this works on the brand panel, on green and on red without a table of
   * exceptions.
   */
  fadeFraction?: boolean;
}

/**
 * Enough to read the paise as secondary, not so little they look disabled.
 * Written as an alpha suffix on the tone's own colour, so a faded fraction is
 * the same hue as the amount it belongs to on every surface.
 */
const FRACTION_ALPHA = '8C';

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
  tone,
  fadeFraction = true,
  ...rest
}: MoneyTextProps) {
  const theme = useTheme();
  const money: Money = { minor: amount, currency };
  const resolvedDirection = direction ?? balanceDirection(amount);
  const strings = copyFor(locale).money;

  const shown = mode === 'balance' ? { ...money, minor: abs(amount) } : money;
  const options = {
    locale,
    compactFraction,
    signDisplay: (showSign && mode !== 'balance' ? 'always' : 'auto') as 'always' | 'auto',
  };
  const parts = formatParts(shown, options);

  const resolvedTone =
    tone ??
    (mode === 'balance'
      ? resolvedDirection === BalanceDirection.OwedToYou
        ? 'positive'
        : resolvedDirection === BalanceDirection.YouOwe
          ? 'negative'
          : 'muted'
      : 'default');

  // The caller may have overridden the colour outright (white money on the
  // brand panel); fade that, not the tone's.
  const flattened = StyleSheet.flatten(rest.style) as TextStyle | undefined;
  const base =
    typeof flattened?.color === 'string' ? flattened.color : toneColor(theme, resolvedTone);
  const fadedColor = base.length === 7 && base.startsWith('#') ? `${base}${FRACTION_ALPHA}` : base;

  return (
    <Text
      variant={variant}
      tone={resolvedTone}
      tabular
      accessibilityLabel={
        mode === 'balance'
          ? moneyAccessibilityLabel(money, resolvedDirection, strings, {
              locale,
              compactFraction,
            })
          : parts.text
      }
      {...rest}
    >
      {fadeFraction && parts.fraction ? (
        <>
          {parts.lead}
          {/* A bare RNText so it inherits the caller's size and weight — a
              nested `<Text>` of ours would reset them to its variant's, and a
              40pt balance would print its paise at 15pt. Colour, not opacity:
              a nested span's opacity is unreliable on Android. */}
          <RNText style={{ color: fadedColor }}>{parts.fraction}</RNText>
          {parts.trail}
        </>
      ) : (
        parts.text
      )}
    </Text>
  );
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
