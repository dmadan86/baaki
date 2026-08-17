/**
 * The provider buttons on the way in.
 *
 * These were icon-only tiles — two 96×60 squares under a hairline that said
 * "or sign in with". That reads as a decoration until you have already decided
 * to look for it, and it hides the one fact that makes somebody tap: *which*
 * account they would be using. Every app that does this well (Duolingo, eBay,
 * Canva, Speak, Recime, MyFitnessPal, Finimize) draws the same thing instead —
 * a full-width row, the provider's own mark on the left, its own words on it.
 *
 * The marks are the real ones. Apple's is white on black (inverted in dark, as
 * Apple's own guidance says), Google's is the four-colour G on white behind a
 * hairline — a purple-tinted G or a monochrome one is off-brand for both, and
 * on a screen whose whole job is trust, an approximated logo is the wrong place
 * to save a dependency.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Text, useTheme } from '@baaki/ui';

export type SocialProvider = 'apple' | 'google';

/**
 * Google's G, drawn from its four brand colours at the official proportions.
 * Left as fixed hex rather than theme colours on purpose: a brand mark that
 * changed with the app's palette would no longer be the brand mark.
 */
function GoogleMark({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <Path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <Path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <Path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </Svg>
  );
}

/**
 * One provider row: the mark pinned left, the label centred in the whole width.
 *
 * Centring the label in the button rather than beside the mark is what keeps a
 * stack of these looking like a stack — "Continue with Apple" and "Continue
 * with Google" are different lengths, and a row-centred pair puts their marks
 * at two different x positions, which reads as two buttons that do not belong
 * to each other. The mark is absolutely positioned so the label can own the
 * centre without either one moving the other.
 */
export function SocialButton({
  provider,
  label,
  onPress,
  disabled = false,
}: {
  provider: SocialProvider;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const apple = provider === 'apple';
  // Apple's mark inverts with the surface; Google's button is always the light
  // one, which is the only variant Google's guidelines allow beside the
  // four-colour G.
  const background = apple ? theme.color.text : '#FFFFFF';
  const ink = apple ? theme.color.bg : '#1F1F1F';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56,
        borderRadius: theme.radius.pill,
        alignSelf: 'stretch',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        borderWidth: apple ? 0 : 1,
        borderColor: '#DADCE0',
        opacity: disabled ? 0.45 : pressed ? 0.9 : 1,
      })}
    >
      <View style={{ position: 'absolute', start: theme.spacing.xl }}>
        {apple ? <Ionicons name="logo-apple" size={22} color={ink} /> : <GoogleMark />}
      </View>
      <Text variant="subheading" style={{ color: ink }}>
        {label}
      </Text>
    </Pressable>
  );
}
