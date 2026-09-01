import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';

import {
  currencySymbol,
  formatMinorInput,
  minorUnitExponent,
  parseMinorInput,
  sanitiseMinorInput,
  type CurrencyCode,
} from '@waves/core';

import { useTheme } from '../theme';
import { Text } from './Text';

/**
 * The keypad an amount in this currency is typed on.
 *
 * A currency with no minor unit has nothing to put after a point, and offering
 * the point anyway invites a figure that is then silently stripped. Exported
 * because the expense form's per-payer fields are the same kind of input
 * without being this component, and they were showing a decimal pad for yen.
 */
export function amountKeyboard(currency: CurrencyCode): 'number-pad' | 'decimal-pad' {
  return minorUnitExponent(currency) === 0 ? 'number-pad' : 'decimal-pad';
}

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
  tone = 'default',
}: {
  currency: CurrencyCode;
  value: bigint;
  onChange: (amount: bigint) => void;
  /**
   * 'display' is the hero amount — big and centred, for the expense entry
   * screen. 'compact' is the right-aligned inline value that sits at the end of
   * a settings row (a trip budget beside its label), sized to read as a field
   * value rather than the point of the screen. 'hero' is the middle rung: the
   * amount inside a coloured header bar, prominent but no longer the reason the
   * header is tall — it sits on one line beside the currency it is counted in.
   */
  size?: 'display' | 'compact' | 'hero';
  /**
   * 'onBrand' paints the field for a saturated wash — white digits, translucent
   * white for the symbol and the untyped placeholder. The theme has no token for
   * "white at 70%" because nothing else needs one.
   */
  tone?: 'default' | 'onBrand';
}) {
  const theme = useTheme();
  const compact = size === 'compact';
  const hero = size === 'hero';
  const onBrand = tone === 'onBrand';
  // One table rather than three ternaries per style: the sizes only ever move
  // together, and a wrong pairing (44pt digits over a 24pt line) is the kind of
  // thing that reads as a clipped number on Android.
  const metrics = hero
    ? { symbol: 20, digits: 30, line: 38, minWidth: 24 }
    : compact
      ? { symbol: 18, digits: 18, line: 24, minWidth: 40 }
      : { symbol: 30, digits: 44, line: 50, minWidth: 28 };
  const digitInk = onBrand ? theme.color.onBrand : theme.color.text;
  const symbolInk = onBrand ? 'rgba(255,255,255,0.72)' : theme.color.textMuted;
  const placeholderInk = onBrand ? 'rgba(255,255,255,0.5)' : theme.color.textFaint;

  // The text↔minor rules live in @waves/core, because the per-payer amount
  // fields on the expense form parse the same keystrokes and two copies of
  // "how many decimal places does this currency have" is how ₹10.5 becomes 105
  // paise on one screen and 1050 on another.
  const toMinor = (text: string): bigint => parseMinorInput(text, currency);
  const format = (minor: bigint): string => formatMinorInput(minor, currency);

  const [text, setText] = useState<string>(() => format(value));
  // The last amount this field emitted, and the currency it was typed in. An
  // input that differs from it came from somewhere else (scan, draft restore,
  // edit, the currency picker) and must overwrite the text; one that matches is
  // our own echo and must be ignored, or it would reformat mid-keystroke ("1."
  // would snap back to "1.00").
  //
  // The currency belongs in that comparison because it decides where the point
  // goes: switching ₹100.00 to yen leaves the minor amount at 10000 but changes
  // what it reads as, and watching the value alone left "100.00" on screen over
  // a field now holding ¥10,000 — with the spoken label, which recomputes,
  // saying the other thing.
  const emitted = useRef<{ value: bigint; currency: CurrencyCode }>({ value, currency });

  useEffect(() => {
    if (value !== emitted.current.value || currency !== emitted.current.currency) {
      emitted.current = { value, currency };
      // Called rather than `format`, which is rebuilt every render and would
      // put the effect's own identity in its dependency list.
      setText(formatMinorInput(value, currency));
    }
  }, [value, currency]);

  const onType = (raw: string): void => {
    const cleaned = sanitiseMinorInput(raw, currency);
    setText(cleaned);
    const minor = toMinor(cleaned);
    emitted.current = { value: minor, currency };
    onChange(minor);
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: compact ? 'flex-end' : hero ? 'flex-start' : 'center',
        gap: theme.spacing.xs,
        // The hero shares its line with the currency pill, so a long amount has
        // to give ground rather than push the pill off the header; the standalone
        // sizes have the row to themselves and must not be squeezed by a sibling.
        flexShrink: hero ? 1 : 0,
        minWidth: 0,
      }}
    >
      <Text
        style={{
          fontSize: metrics.symbol,
          lineHeight: metrics.line,
          fontWeight: '700',
          color: symbolInk,
        }}
      >
        {currencySymbol(currency)}
      </Text>
      <TextInput
        value={text}
        onChangeText={onType}
        keyboardType={amountKeyboard(currency)}
        placeholder="0"
        placeholderTextColor={placeholderInk}
        selectionColor={onBrand ? theme.color.onBrand : theme.color.brand}
        accessibilityLabel={`Amount ${format(value) || '0'} ${currency}`}
        maxFontSizeMultiplier={1.4}
        style={{
          minWidth: metrics.minWidth,
          padding: 0,
          fontSize: metrics.digits,
          lineHeight: metrics.line,
          fontWeight: '700',
          color: digitInk,
          fontVariant: ['tabular-nums'],
          textAlign: compact ? 'right' : 'left',
          flexShrink: hero ? 1 : 0,
        }}
      />
    </View>
  );
}
