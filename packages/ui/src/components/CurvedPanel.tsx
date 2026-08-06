import type { ReactNode } from 'react';
import { useWindowDimensions, View, type ViewStyle } from 'react-native';

import { curveGeometry } from '../curve';
import { useTheme } from '../theme';

export interface CurvedPanelProps {
  children?: ReactNode;
  /** How tall the coloured area is. */
  height: number;
  /** Brand purple, or the soft tint for a lighter first impression. */
  tone?: 'brand' | 'soft';
  /**
   * How deep the sweep is, 0–1 of the panel height. Higher curves harder;
   * 0 is a straight edge.
   */
  curve?: number;
  style?: ViewStyle;
}

/**
 * A coloured panel whose bottom edge sweeps rather than cuts.
 *
 * Drawn with an over-wide box and a large bottom radius rather than an SVG
 * path: the arc is the middle of a much wider ellipse, which is why it reads as
 * a gentle sweep instead of two corners that have been rounded. It also keeps
 * this out of react-native-svg — a native module that would have to be in every
 * build before the sign-in screen could render, and a native module missing
 * from a build is how this app has previously lost a whole screen.
 *
 * Children sit above the curve at true screen width; the widening is only ever
 * the background's problem.
 */
export function CurvedPanel({
  children,
  height,
  tone = 'brand',
  curve = 0.55,
  style,
}: CurvedPanelProps) {
  const theme = useTheme();
  const { width } = useWindowDimensions();

  // Wide enough that the screen only ever sees the middle of the arc, and no
  // wider — see curve.ts, where the arithmetic and its three caps live.
  const { overhang, drawnWidth, radius } = curveGeometry(width, height, curve);

  return (
    <View style={[{ height }, style]}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: -overhang,
          width: drawnWidth,
          height,
          backgroundColor: tone === 'brand' ? theme.color.brand : theme.color.brandSoft,
          borderBottomLeftRadius: radius,
          borderBottomRightRadius: radius,
        }}
      />
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}
