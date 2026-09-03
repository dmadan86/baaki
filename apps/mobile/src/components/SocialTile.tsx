/**
 * The other ways in — Google, Apple, phone and email — as marks: one full-width
 * provider button, and a row of icon tiles.
 *
 * This has been both things. It started as icon-only tiles under "or sign in
 * with", then became full-width labelled rows because *two* tiles read as a
 * decoration nobody had asked for. What made the rows wrong in turn was the
 * count: with "Email me a code" and "Continue with phone" beside them the sheet
 * carried six same-weight buttons and no hierarchy. So: tiles, but more of them
 * — phone and email join the providers, each with a one-word caption.
 *
 * `ProviderButton` is the other half of that hierarchy, for the gateway door:
 * one provider promoted to a full-width pill, the rest left as tiles beneath
 * it. Same marks, same brand rules, a different weight.
 *
 * Marks are the real ones, at each brand's own colours, and both brands allow
 * the logo-only button: Apple's guidelines require it be at least as prominent
 * as its neighbours (same size, same corner), Google's require the four-colour
 * G on white behind a hairline. Neither follows the theme — a brand glyph that
 * changed with the palette would no longer be the brand glyph. The phone and
 * email tiles are ours, so they do.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { iconSize, Text, useTheme } from '@waves/ui';

export type SocialProvider = 'google' | 'apple' | 'phone' | 'email';

export const SOCIAL_TILE_SIZE = 56;

/**
 * Which field the tile is standing on. `surface` is the white auth sheet, where
 * our own tiles take the theme's muted face. `brand` is the green gateway,
 * where the same tiles turn white so they read as one set with the Google tile
 * beside them — a muted-grey face on a saturated green is neither legible nor
 * the same object. The Google and Apple faces never move either way.
 */
export type SocialField = 'surface' | 'brand';

/**
 * Apple's logo, the single-path glyph at Apple's own proportions. White on the
 * black button, as Sign in with Apple's guidelines require; fixed colour for
 * the same reason as Google's mark — a brand glyph that followed the theme is
 * no longer the brand glyph.
 */
function AppleMark({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#FFFFFF"
        d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.63-1.71-3.19-1.73-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.54 2.67-.39 6.62 1.1 8.79.73 1.06 1.6 2.25 2.74 2.21 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.08 2.65-2.15.84-1.23 1.18-2.42 1.2-2.48-.03-.01-2.29-.88-2.31-3.49zM14.86 5.62c.61-.74 1.02-1.77.91-2.8-.88.04-1.94.59-2.57 1.32-.56.65-1.06 1.7-.93 2.7.98.08 1.98-.5 2.59-1.22z"
      />
    </Svg>
  );
}

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
 * The full-width way in — the one provider promoted above the tiles.
 *
 * Apple's black pill and Google's white one, each at its own guidelines: the
 * mark rides on the leading edge, the label stays optically centred. A spacer
 * the width of the mark balances it, rather than a hard `left` offset, so the
 * row mirrors on its own in Arabic.
 */
export function ProviderButton({
  provider,
  label,
  onPress,
  disabled = false,
  testID,
}: {
  provider: 'google' | 'apple';
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const isApple = provider === 'apple';
  const face = isApple
    ? { backgroundColor: '#000000', borderColor: '#000000' }
    : { backgroundColor: '#FFFFFF', borderColor: '#DADCE0' };
  // Google's own guidance is its dark grey on the white button, not pure black.
  const ink = isApple ? '#FFFFFF' : '#1F1F1F';
  const markSize = 20;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56,
        borderRadius: theme.radius.pill,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.spacing.xl,
        gap: theme.spacing.md,
        opacity: disabled ? 0.5 : pressed ? 0.9 : 1,
        ...face,
      })}
    >
      {isApple ? <AppleMark size={markSize} /> : <GoogleMark size={markSize} />}
      <Text variant="subheading" align="center" style={{ flex: 1, color: ink, fontWeight: '700' }}>
        {label}
      </Text>
      {/* Balances the mark, so the label is centred in the pill and not off it. */}
      <View style={{ width: markSize }} />
    </Pressable>
  );
}

/**
 * One tile: the mark centred, an optional one-word caption underneath.
 *
 * The caption is what keeps a logo from being a decoration — it names the
 * account you would be using. The spoken label is the full sentence
 * ("Continue with Google"), never the caption.
 */
export function SocialTile({
  provider,
  accessibilityLabel,
  caption,
  onPress,
  disabled = false,
  field = 'surface',
  testID,
}: {
  provider: SocialProvider;
  accessibilityLabel: string;
  caption?: string;
  onPress: () => void;
  disabled?: boolean;
  field?: SocialField;
  testID?: string;
}) {
  const theme = useTheme();
  const onBrandField = field === 'brand';
  // Each brand's guidelines pin its own palette: Google's light tile with a
  // hairline, Apple's solid black. Phone and email are ours and take the field.
  const face =
    provider === 'apple'
      ? { backgroundColor: '#000000', borderColor: '#000000' }
      : provider === 'google'
        ? { backgroundColor: '#FFFFFF', borderColor: '#DADCE0' }
        : onBrandField
          ? { backgroundColor: '#FFFFFF', borderColor: '#DADCE0' }
          : { backgroundColor: theme.color.surfaceMuted, borderColor: theme.color.border };

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        alignItems: 'center',
        gap: theme.spacing.sm,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: SOCIAL_TILE_SIZE,
          height: SOCIAL_TILE_SIZE,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          alignItems: 'center',
          justifyContent: 'center',
          ...face,
        }}
      >
        {provider === 'apple' ? (
          <AppleMark size={24} />
        ) : provider === 'google' ? (
          <GoogleMark size={24} />
        ) : (
          <Ionicons
            name={provider === 'email' ? 'mail-outline' : 'call-outline'}
            size={iconSize.md}
            color={theme.color.brand}
          />
        )}
      </View>
      {caption ? (
        <Text
          variant="caption"
          tone={onBrandField ? undefined : 'muted'}
          style={onBrandField ? { color: theme.color.onBrand } : undefined}
        >
          {caption}
        </Text>
      ) : null}
    </Pressable>
  );
}
