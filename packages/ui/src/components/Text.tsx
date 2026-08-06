import {
  StyleSheet,
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
} from 'react-native';

import { useTheme } from '../theme';
import type { typography } from '../tokens';

export type TextVariant = keyof typeof typography;
export type TextTone =
  'default' | 'muted' | 'faint' | 'brand' | 'positive' | 'negative' | 'onBrand';

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

  const color =
    tone === 'muted'
      ? theme.color.textMuted
      : tone === 'faint'
        ? theme.color.textFaint
        : tone === 'brand'
          ? theme.color.brand
          : tone === 'positive'
            ? theme.color.positive
            : tone === 'negative'
              ? theme.color.negative
              : tone === 'onBrand'
                ? theme.color.onBrand
                : theme.color.text;

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
