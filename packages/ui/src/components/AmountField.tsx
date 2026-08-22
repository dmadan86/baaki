import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import { currencySymbol, minorUnitExponent, minorUnitScale, type CurrencyCode } from '@waves/core';

import { useTheme } from '../theme';
import { Text } from './Text';

/**
 * The amount input as a single native number field — the phone's own
 * decimal keypad, nothing invented on top of it. No arithmetic: a number is
 * typed, not calculated. All maths still runs in integer minor units, so the
 * value handed up never disagrees with the ledger.
 */
export function AmountField({
  currency,
  value,
  onChange,
  size = 'display',
}: {
  currency: CurrencyCode;
  value: bigint;
  onChange: (amount: bigint) => void;
  /**
   * 'display' is the hero amount — big and centred, for the expense entry
   * screen. 'compact' is the right-aligned inline value that sits at the end of
   * a settings row (a trip budget beside its label), sized to read as a field
   * value rather than the point of the screen.
   */
  size?: 'display' | 'compact';
}) {
  const theme = useTheme();
  const compact = size === 'compact';
  const exponent = minorUnitExponent(currency);
  const scale = minorUnitScale(currency);

  const toMinor = (text: string): bigint => {
    if (text === '' || text === '.') return 0n;
    const [whole = '0', fraction = ''] = text.split('.');
    const padded = fraction.slice(0, exponent).padEnd(exponent, '0');
    return BigInt(whole || '0') * scale + BigInt(padded === '' ? '0' : padded);
  };

  const format = (minor: bigint): string => {
    if (minor === 0n) return '';
    const abs = minor < 0n ? -minor : minor;
    const whole = (abs / scale).toString();
    if (exponent === 0) return whole;
    return `${whole}.${(abs % scale).toString().padStart(exponent, '0')}`;
  };

  const [text, setText] = useState<string>(() => format(value));
  // The last minor amount this field emitted. A `value` that differs from it
  // came from somewhere else (scan, draft restore, edit) and must overwrite
  // the text; a `value` that matches it is our own echo and must be ignored,
  // or it would reformat mid-keystroke ("1." would snap back to "1.00").
  const emitted = useRef<bigint>(value);

  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setText(format(value));
    }
  }, [value]);

  const onType = (raw: string): void => {
    // Keep digits and, unless the currency has no minor unit, a single dot.
    let cleaned = raw.replace(/[^0-9.]/g, '');
    if (exponent === 0) {
      cleaned = cleaned.replace(/\./g, '');
    } else {
      const firstDot = cleaned.indexOf('.');
      if (firstDot !== -1) {
        cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
      }
    }
    // Drop a leading zero once real digits follow, but keep the "0" of "0.50".
    cleaned = cleaned.replace(/^0+(?=\d)/, '');
    const [, fraction = ''] = cleaned.split('.');
    if (fraction.length > exponent) {
      cleaned = cleaned.slice(0, cleaned.length - (fraction.length - exponent));
    }

    setText(cleaned);
    const minor = toMinor(cleaned);
    emitted.current = minor;
    onChange(minor);
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: compact ? 'flex-end' : 'center',
        gap: theme.spacing.xs,
        flexShrink: 0,
      }}
    >
      <Text
        style={{
          fontSize: compact ? 18 : 30,
          lineHeight: compact ? 24 : 44,
          fontWeight: '700',
          color: theme.color.textMuted,
        }}
      >
        {currencySymbol(currency)}
      </Text>
      <TextInput
        value={text}
        onChangeText={onType}
        keyboardType={exponent === 0 ? 'number-pad' : 'decimal-pad'}
        placeholder="0"
        placeholderTextColor={theme.color.textFaint}
        selectionColor={theme.color.brand}
        accessibilityLabel={`Amount ${format(value) || '0'} ${currency}`}
        maxFontSizeMultiplier={1.4}
        style={{
          minWidth: compact ? 40 : 28,
          padding: 0,
          fontSize: compact ? 18 : 44,
          lineHeight: compact ? 24 : 50,
          fontWeight: '700',
          color: theme.color.text,
          fontVariant: ['tabular-nums'],
          textAlign: compact ? 'right' : 'left',
        }}
      />
    </View>
  );
}
