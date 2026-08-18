import { useState } from 'react';
import { Pressable, View } from 'react-native';

import {
  currencySymbol,
  divideRoundHalfAwayFromZero,
  minorUnitExponent,
  minorUnitScale,
  type CurrencyCode,
} from '@waves/core';

import { useTheme } from '../theme';
import { Text } from './Text';

type Operator = '+' | '-' | '×' | '÷';

const KEYS: readonly (string | Operator)[] = [
  '1',
  '2',
  '3',
  '÷',
  '4',
  '5',
  '6',
  '×',
  '7',
  '8',
  '9',
  '-',
  '.',
  '0',
  '⌫',
  '+',
];

/**
 * The calculator built into the amount field — the 955-vote fix from the
 * competitive analysis (TDR §9). Splitting a bill means arithmetic, so the
 * arithmetic lives where the number is typed instead of in another app.
 *
 * All maths runs in integer minor units; the operand of × and ÷ is treated as a
 * plain multiplier, and ÷ rounds half away from zero exactly like the split
 * engine does.
 */
export function AmountKeypad({
  currency,
  value,
  onChange,
}: {
  currency: CurrencyCode;
  value: bigint;
  onChange: (amount: bigint) => void;
}) {
  const theme = useTheme();
  const exponent = minorUnitExponent(currency);
  const scale = minorUnitScale(currency);

  const [entry, setEntry] = useState<string>('');
  const [accumulator, setAccumulator] = useState<bigint | null>(null);
  const [operator, setOperator] = useState<Operator | null>(null);

  const entryToMinor = (text: string): bigint => {
    if (text === '' || text === '.') return 0n;
    const [whole = '0', fraction = ''] = text.split('.');
    const padded = fraction.slice(0, exponent).padEnd(exponent, '0');
    return BigInt(whole || '0') * scale + BigInt(padded === '' ? '0' : padded);
  };

  const apply = (left: bigint, right: bigint, op: Operator): bigint => {
    switch (op) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '×':
        // right is a multiplier expressed in minor units — divide it back out.
        return divideRoundHalfAwayFromZero(left * right, scale);
      case '÷':
        return right === 0n ? left : divideRoundHalfAwayFromZero(left * scale, right);
    }
  };

  const commit = (next: bigint): void => {
    onChange(next < 0n ? 0n : next);
  };

  const press = (key: string): void => {
    if (key === '⌫') {
      if (entry.length > 0) {
        const trimmed = entry.slice(0, -1);
        setEntry(trimmed);
        // Recompute the pending result from the trimmed entry so the emitted
        // amount matches the display. When the entry empties out, the display
        // falls back to the accumulator, so emit that.
        commit(
          accumulator !== null && operator
            ? trimmed === ''
              ? accumulator
              : apply(accumulator, entryToMinor(trimmed), operator)
            : entryToMinor(trimmed),
        );
      } else {
        setEntry('');
        setAccumulator(null);
        setOperator(null);
        commit(0n);
      }
      return;
    }

    if (key === '+' || key === '-' || key === '×' || key === '÷') {
      const current = entry === '' ? value : entryToMinor(entry);
      const raw =
        accumulator !== null && operator ? apply(accumulator, current, operator) : current;
      // Clamp the internal accumulator too, so the running total never diverges
      // from the clamped value the parent (and the display) actually sees.
      const base = raw < 0n ? 0n : raw;
      setAccumulator(base);
      setOperator(key as Operator);
      setEntry('');
      commit(base);
      return;
    }

    if (key === '.' && (entry.includes('.') || exponent === 0)) return;

    const nextEntry = entry === '' && key === '.' ? '0.' : entry + key;
    const [, fraction = ''] = nextEntry.split('.');
    if (fraction.length > exponent) return;

    setEntry(nextEntry);
    const typed = entryToMinor(nextEntry);
    commit(accumulator !== null && operator ? apply(accumulator, typed, operator) : typed);
  };

  const display = (() => {
    const minor = accumulator !== null && operator && entry === '' ? accumulator : value;
    const negative = minor < 0n;
    const abs = negative ? -minor : minor;
    const whole = (abs / scale).toString();
    const fraction = exponent > 0 ? `.${(abs % scale).toString().padStart(exponent, '0')}` : '';
    return `${negative ? '-' : ''}${whole}${fraction}`;
  })();

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Text variant="title" tone="muted">
          {currencySymbol(currency)}
        </Text>
        <Text
          variant="display"
          tabular
          accessibilityLabel={`Amount ${display} ${currency}`}
          style={{ fontSize: 44, lineHeight: 50 }}
        >
          {display}
        </Text>
        {operator ? (
          <Text variant="title" tone="brand" accessibilityLabel={`pending ${operator}`}>
            {operator}
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {KEYS.map((key) => {
          const isOperator = key === '+' || key === '-' || key === '×' || key === '÷';
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={key === '⌫' ? 'delete' : key}
              onPress={() => press(key)}
              style={({ pressed }) => ({
                width: '25%',
                height: 62,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <View
                style={{
                  width: 56,
                  height: 46,
                  borderRadius: theme.radius.md,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isOperator ? theme.color.brandSoft : 'transparent',
                }}
              >
                <Text variant="title" tone={isOperator ? 'brand' : 'default'}>
                  {key}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
