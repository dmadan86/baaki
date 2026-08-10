import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme, type Theme } from '../theme';
import { Text } from './Text';

/**
 * A message the screen wants a person to actually read — a submit that failed,
 * a warning before an irreversible tap, a note that something worked.
 *
 * It exists because the alternative kept turning up: a bare line of
 * `<Text tone="negative">` wedged between the form and the button, the same red
 * as a hundred other things, easy to miss and easy to mistake for a field
 * label. A message worth showing is worth giving a shape — a tinted panel in
 * its own colour, an icon that says at a glance which of the four this is, and
 * air around the words. This is that shape, in one place, so every screen says
 * "that did not work" the same way.
 *
 * Icon-agnostic on purpose: this package carries no icon library, the way
 * `PillTabBar` does not. The screen passes a render function and is handed back
 * the colour the icon should be, so the glyph always matches the tone without
 * the caller having to look it up.
 */
export type CalloutTone = 'negative' | 'warning' | 'positive' | 'info';

interface CalloutColors {
  readonly fg: string;
  readonly bg: string;
}

function calloutColors(theme: Theme, tone: CalloutTone): CalloutColors {
  switch (tone) {
    case 'warning':
      return { fg: theme.color.warning, bg: theme.color.warningSoft };
    case 'positive':
      return { fg: theme.color.positive, bg: theme.color.positiveSoft };
    case 'info':
      return { fg: theme.color.brand, bg: theme.color.brandSoft };
    case 'negative':
    default:
      return { fg: theme.color.negative, bg: theme.color.negativeSoft };
  }
}

export function Callout({
  tone = 'negative',
  icon,
  title,
  children,
  style,
}: {
  tone?: CalloutTone;
  /**
   * Rendered at the leading edge, handed the tone's colour so it matches
   * without the caller resolving it. Omit for a message that needs no glyph.
   */
  icon?: (color: string) => ReactNode;
  /** An optional bold line above the body — a short name for what happened. */
  title?: string;
  /** The message. A string in the common case; nodes when it needs a link. */
  children: ReactNode;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const { fg, bg } = calloutColors(theme, tone);
  return (
    <View
      accessible
      accessibilityRole={tone === 'negative' ? 'alert' : 'text'}
      style={[
        {
          flexDirection: 'row',
          alignItems: title ? 'flex-start' : 'center',
          gap: theme.spacing.md,
          backgroundColor: bg,
          borderRadius: theme.radius.md,
          padding: theme.spacing.lg,
        },
        style,
      ]}
    >
      {/* Nudged onto the first line's optical centre when there is a title
          stacked above the body; centred with the single line otherwise. */}
      {icon ? <View style={{ marginTop: title ? 1 : 0 }}>{icon(fg)}</View> : null}
      <View style={{ flex: 1, gap: 2 }}>
        {title ? (
          <Text variant="subheading" style={{ color: fg }}>
            {title}
          </Text>
        ) : null}
        <Text variant="caption" style={{ color: fg }}>
          {children}
        </Text>
      </View>
    </View>
  );
}
