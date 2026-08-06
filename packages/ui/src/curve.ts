/**
 * Where to draw a `CurvedPanel`'s background so its bottom edge sweeps.
 *
 * Separate from the component, and free of React Native, because this is the
 * part that can be wrong without looking wrong: the panel still renders, still
 * fills, still has the right colour — it is just flat. That shipped once
 * already (the sign-in header), and a screenshot is the only thing that caught
 * it.
 */

export interface CurveGeometry {
  /** How far past each screen edge the coloured box is drawn. */
  readonly overhang: number;
  /** Total width of the drawn box: the screen plus both overhangs. */
  readonly drawnWidth: number;
  /** The bottom corner radius to apply. */
  readonly radius: number;
  /** How far the sweep drops below the panel's bottom, at the screen edge. */
  readonly edgeDip: number;
}

/**
 * The screen's edge sits this far into the corner arc, as a fraction of the
 * radius. It has to scale *with* the radius rather than with the screen: an
 * overhang wider than the arc puts the whole curve off-screen and leaves the
 * flat middle showing, which is exactly how a curve goes missing.
 *
 * At this value the visible drop is about 15% of the radius — enough to read as
 * a sweep, little enough that there is still a straight run of colour to put a
 * wordmark on.
 */
const EDGE_INSET = 0.474;

export function curveGeometry(width: number, height: number, curve: number): CurveGeometry {
  // Three caps, and each one belongs here rather than left to the renderer.
  // CSS scales *every* radius on a box down together when any pair overruns a
  // side, so a radius 40px too tall does not come back 40px shorter — it comes
  // back a different shape, in this case a rectangle. Clamping in code means
  // what is asked for is what is drawn.
  //
  //   height * curve * 2 — what the caller asked for
  //   height            — a corner cannot be taller than its box
  //   width * 0.95      — the two bottom corners together cannot exceed the
  //                       drawn width, and the drawn width depends on the
  //                       radius, which settles at width / 1.052
  const radius = Math.max(0, Math.min(height * curve * 2, height, width * 0.95));
  const overhang = radius * EDGE_INSET;
  const inset = radius - overhang;

  return {
    overhang,
    drawnWidth: width + overhang * 2,
    radius,
    edgeDip: radius - Math.sqrt(Math.max(0, radius * radius - inset * inset)),
  };
}
