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
  framed = false,
  autoFocus = false,
}: {
  currency: CurrencyCode;
  value: bigint;
  onChange: (amount: bigint) => void;
  /**
   * Wrap the field in a well — a soft fill and a bottom rule that goes solid on
   * focus — so an editable amount reads as a field rather than a printed number.
   * Off by default, because the compact and display sizes are already obviously
   * inputs; the hero amount, which sits on the same coloured bar as a read-only
   * total looks, is the one that needs saying "you can type here".
   */
  framed?: boolean;
  /** Focus and open the keyboard on mount — used when a screen was opened to
   *  change the amount specifically (tapping the total on the expense screen). */
  autoFocus?: boolean;
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

  // The well's rule brightens when the field has the keyboard, the oldest "type
  // here" signal there is. Tracked in state so the border can answer the focus.
  const [focused, setFocused] = useState(false);

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

  /**
   * How much of its full size the number can afford at this length.
   *
   * A `TextInput` does not shrink its glyphs to fit — asked for more room than
   * it has, it scrolls, and what scrolls off a left-aligned field is the *front*
   * of the number. So ₹13,480.00 in the hero showed as "3,480.00": not a clipped
   * digit somebody would notice, a different, smaller, entirely plausible
   * amount. React Native has no cross-platform `adjustsFontSizeToFit` for an
   * input (it is iOS-only, and not on `TextInput` at all), so the size is chosen
   * here from what has been typed.
   *
   * The line height does not follow it down: the header keeps one height whatever
   * the number, so typing a digit never nudges the layout below it.
   */
  const typed = (text || '0').length;
  const fit =
    compact || typed <= 6 ? 1 : typed === 7 ? 0.86 : typed === 8 ? 0.76 : typed <= 10 ? 0.64 : 0.54;
  const digitSize = Math.round(metrics.digits * fit);
  // The symbol comes down with it but not as far — it is already the quieter of
  // the two, and shrinking it in step makes it vanish against the digits.
  const symbolSize = Math.max(14, Math.round(metrics.symbol * ((1 + fit) / 2)));

  const onType = (raw: string): void => {
    const cleaned = sanitiseMinorInput(raw, currency);
    setText(cleaned);
    const minor = toMinor(cleaned);
    emitted.current = { value: minor, currency };
    onChange(minor);
  };

  // The well: a translucent fill and a bottom rule, brighter on focus. On the
  // brand wash it is white-on-white; off it, the surface's own muted fill and
  // the brand as the active rule.
  const wellFill = onBrand ? 'rgba(255,255,255,0.14)' : theme.color.surfaceMuted;
  const ruleRest = onBrand ? 'rgba(255,255,255,0.55)' : theme.color.border;
  const ruleActive = onBrand ? theme.color.onBrand : theme.color.brand;

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
        ...(framed
          ? {
              backgroundColor: wellFill,
              borderRadius: theme.radius.md,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.xs,
              borderBottomWidth: 2,
              borderBottomColor: focused ? ruleActive : ruleRest,
            }
          : null),
      }}
    >
      <Text
        style={{
          fontSize: symbolSize,
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
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        maxFontSizeMultiplier={1.4}
        style={{
          minWidth: metrics.minWidth,
          padding: 0,
          fontSize: digitSize,
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
