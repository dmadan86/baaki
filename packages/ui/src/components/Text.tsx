import {
  StyleSheet,
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
} from 'react-native';

import { useTheme, type Theme } from '../theme';
import type { typography } from '../tokens';

export type TextVariant = keyof typeof typography;
export type TextTone =
  'default' | 'muted' | 'faint' | 'brand' | 'positive' | 'negative' | 'onBrand';

/**
 * The colour a tone resolves to.
 *
 * Exported because a caller sometimes needs the colour rather than a `<Text>`
 * — a nested span that must inherit its parent's size but not its opacity, for
 * one. Anything that recomputes this mapping locally will drift from it.
 */
export function toneColor(theme: Theme, tone: TextTone): string {
  switch (tone) {
    case 'muted':
      return theme.color.textMuted;
    case 'faint':
      return theme.color.textFaint;
    case 'brand':
      return theme.color.brand;
    case 'positive':
      return theme.color.positive;
    case 'negative':
      return theme.color.negative;
    case 'onBrand':
      return theme.color.onBrand;
    default:
      return theme.color.text;
  }
}

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  tone?: TextTone;
  align?: TextStyle['textAlign'];
  /** Tabular figures keep money columns from jittering as digits change. */
  tabular?: boolean;
}

export function Text({
  variant = 'body',
  tone = 'default',
  align,
  tabular = false,
  style,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const scale = theme.typography[variant];

  // A caller that overrides `fontSize` and nothing else would otherwise keep
  // the variant's line height, and the glyph gets clipped to a box built for
  // 15pt text — which is how a 43pt emoji ends up with its feet cut off. Scale
  // the line height by the same factor unless the caller stated one.
  const override = StyleSheet.flatten(style) as TextStyle | undefined;
  const lineHeight =
    typeof override?.fontSize === 'number' && override.lineHeight === undefined
      ? Math.round(override.fontSize * (scale.lineHeight / scale.fontSize))
      : scale.lineHeight;

  const color = toneColor(theme, tone);

  return (
    <RNText
      // Dynamic type is respected (TDR §11) — we cap the growth so money rows
      // stay readable rather than clipping.
      maxFontSizeMultiplier={1.6}
      style={[
        {
          fontSize: scale.fontSize,
          lineHeight,
          fontWeight: scale.fontWeight as TextStyle['fontWeight'],
          color,
          textAlign: align,
        },
        tabular && { fontVariant: ['tabular-nums'] },
        style,
      ]}
      {...rest}
    />
  );
}
