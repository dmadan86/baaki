/**
 * The one-time code, as a row of boxed cells rather than one long field.
 *
 * Shared by the phone and the email verification screens. A single hidden
 * `TextInput` does the actual work — it holds the digits, raises the number pad
 * and receives the SMS/email autofill — and the boxes are only a drawing of its
 * value. Tapping anywhere on the row focuses it. Each empty cell shows a faint
 * `0` as a placeholder; the cell about to be typed carries a blinking caret
 * (still, with motion off). The row is pinned left-to-right so the digits keep
 * their order under an RTL layout, where a code is still read the same way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Text, useTheme } from '@waves/ui';

import { useMotion } from '@/lib/motion';

/** Both the phone and email codes are six digits. */
export const OTP_LEN = 6;

export function OtpInput({
  value,
  onChangeText,
  length = OTP_LEN,
  accessibilityLabel,
  autoFocus,
}: {
  value: string;
  onChangeText: (next: string) => void;
  length?: number;
  accessibilityLabel: string;
  autoFocus?: boolean;
}) {
  const theme = useTheme();
  const { animated } = useMotion();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  // The caret blinks on its own; with motion off it simply stays lit.
  const blink = useSharedValue(1);
  useEffect(() => {
    if (!animated) {
      blink.value = 1;
      return;
    }
    blink.value = withRepeat(withTiming(0, { duration: 550, easing: Easing.ease }), -1, true);
    return () => cancelAnimation(blink);
  }, [animated, blink]);
  const caretStyle = useAnimatedStyle(() => ({ opacity: blink.value }));

  const focus = useCallback(() => inputRef.current?.focus(), []);

  return (
    <Pressable
      onPress={focus}
      accessibilityRole="none"
      style={{ flexDirection: 'row', gap: theme.spacing.sm, direction: 'ltr' }}
    >
      {Array.from({ length }, (_, i) => {
        const digit = value[i];
        const active = focused && i === value.length && value.length < length;
        return (
          <View
            key={i}
            style={{
              flex: 1,
              aspectRatio: 0.82,
              borderRadius: theme.radius.md,
              backgroundColor: theme.color.surface,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
            }}
          >
            {active ? (
              <Animated.View
                style={[
                  { width: 2, height: 28, borderRadius: 1, backgroundColor: theme.color.brand },
                  caretStyle,
                ]}
              />
            ) : null}
            <Text
              style={{
                fontSize: 28,
                fontWeight: '700',
                color: digit ? theme.color.text : theme.color.textFaint,
              }}
            >
              {digit ?? '0'}
            </Text>
          </View>
        );
      })}

      {/* The real field, off-screen but focusable: it owns the value and the
          keyboard; the boxes above are its readout. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(next) => onChangeText(next.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        autoComplete="sms-otp"
        textContentType="oneTimeCode"
        maxLength={length}
        autoFocus={autoFocus}
        accessibilityLabel={accessibilityLabel}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
      />
    </Pressable>
  );
}
