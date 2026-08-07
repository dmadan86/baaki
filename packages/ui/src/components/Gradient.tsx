import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

export interface GradientProps {
  children?: ReactNode;
  /** Corner radius; defaults to the card radius so it drops into a layout. */
  radius?: number;
  style?: ViewStyle;
}

/**
 * The brand wash: one purple sliding into a lighter one, corner to corner.
 *
 * Flat brand is fine and was what Baaki shipped; a wash gives the balance the
 * depth the reference boards get from theirs, and costs nothing at rest. The
 * colours are the brand ramp rather than anything new, so a gradient can never
 * disagree with the rest of the app about what purple is.
 *
 * `expo-linear-gradient` is a native module, and a native module missing from
 * a build is how this app has previously lost a whole screen. So it is
 * required lazily behind a check that cannot throw, and a build without it
 * paints the flat brand colour and carries on — the balance is still legible,
 * still white on purple, and nobody sees a crash because a decoration was
 * unavailable.
 */
export function Gradient({ children, radius, style }: GradientProps) {
  const theme = useTheme();
  const LinearGradient = loadLinearGradient();
  const borderRadius = radius ?? theme.radius.md;

  if (!LinearGradient) {
    return (
      <View style={[{ backgroundColor: theme.color.brand, borderRadius }, style]}>{children}</View>
    );
  }

  return (
    <LinearGradient
      colors={theme.gradient.brand}
      // Top-left to bottom-right: the reference sweeps diagonally, and a
      // vertical wash on a short card reads as a printing error.
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[{ borderRadius }, style]}
    >
      {children}
    </LinearGradient>
  );
}

type LinearGradientComponent = (props: {
  colors: readonly string[];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  style?: unknown;
  children?: ReactNode;
}) => React.JSX.Element;

let resolved: LinearGradientComponent | null | undefined;

function loadLinearGradient(): LinearGradientComponent | null {
  if (resolved !== undefined) return resolved;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('expo-linear-gradient') as { LinearGradient?: LinearGradientComponent };
    resolved = module.LinearGradient ?? null;
  } catch {
    resolved = null;
  }
  return resolved;
}
