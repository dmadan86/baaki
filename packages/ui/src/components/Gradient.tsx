import React, { Component, type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

export interface GradientProps {
  children?: ReactNode;
  /** Corner radius; defaults to the card radius so it drops into a layout. */
  radius?: number;
  /**
   * The stops, dark corner to light. Defaults to the brand wash; pass a theme
   * gradient (e.g. `theme.gradient.accent`) for a second-hued tile. The flat
   * fallback paints the first stop, so the first colour must hold white text.
   */
  colors?: readonly string[];
  style?: ViewStyle;
}

/**
 * The brand wash: one purple sliding into a lighter one, corner to corner.
 *
 * Flat brand is fine and was what Waves shipped; a wash gives the balance the
 * depth the reference boards get from theirs, and costs nothing at rest. The
 * colours are the brand ramp rather than anything new, so a gradient can never
 * disagree with the rest of the app about what purple is.
 *
 * `expo-linear-gradient` is a native module, and a native module missing from
 * a build is how this app has previously lost a whole screen. There are two
 * ways it can be missing, and both fall back to the flat brand colour rather
 * than crash:
 *
 *   1. The JS package is absent — `require` throws, caught below.
 *   2. The JS package is present but the *native* view manager is not in the
 *      binary (`Can't find ViewManager 'ExpoLinearGradient'`). That does not
 *      throw from `require`; it throws when React mounts the view, so a
 *      `require` check cannot see it. An error boundary does — it catches the
 *      mount failure and paints the flat colour, and latches off for the rest
 *      of the session so the next gradient does not retry the same crash.
 *
 * Either way the balance stays legible, still white on purple, and nobody sees
 * a red box because a decoration was unavailable.
 */
export function Gradient({ children, radius, colors, style }: GradientProps) {
  const theme = useTheme();
  const LinearGradient = loadLinearGradient();
  const borderRadius = radius ?? theme.radius.md;
  const stops = colors ?? theme.gradient.brand;

  const flat = (
    <View style={[{ backgroundColor: stops[0] ?? theme.color.brand, borderRadius }, style]}>
      {children}
    </View>
  );

  if (!LinearGradient) return flat;

  return (
    <GradientBoundary fallback={flat}>
      <LinearGradient
        colors={stops}
        // Top-left to bottom-right: the reference sweeps diagonally, and a
        // vertical wash on a short card reads as a printing error.
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[{ borderRadius }, style]}
      >
        {children}
      </LinearGradient>
    </GradientBoundary>
  );
}

/**
 * Catches a mount failure from the native gradient view and shows the flat
 * fallback instead. On the first failure it disables the gradient for the whole
 * session, so a screen with several gradients does not throw once per gradient.
 */
class GradientBoundary extends Component<{ fallback: ReactNode; children: ReactNode }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    disabled = true;
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type LinearGradientComponent = (props: {
  colors: readonly string[];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  style?: unknown;
  children?: ReactNode;
}) => React.JSX.Element;

let resolved: LinearGradientComponent | null | undefined;
/** Latched on once the native view fails to mount; keeps every gradient flat after. */
let disabled = false;

function loadLinearGradient(): LinearGradientComponent | null {
  if (disabled) return null;
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
