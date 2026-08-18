/**
 * The doorway screens' sweep.
 *
 * This exists because the sign-in header shipped as a flat rectangle. The
 * component was right, the colours were right, the panel was there — the arc
 * had simply been pushed off the sides of the screen by an overhang that did
 * not scale with the radius, and a shorter panel made the radius small. Nothing
 * failed; it just stopped being a curve.
 *
 * So the thing pinned here is not "the numbers are these numbers", it is "at
 * every panel height the app actually uses, the curve is still visible".
 */

import { describe, expect, it } from 'vitest';

import { curveGeometry } from '@waves/ui/curve';

// A narrow phone, a normal one, and a tablet-ish width.
const WIDTHS = [320, 390, 768];

describe('curveGeometry', () => {
  it('drops the edge visibly on a tall panel', () => {
    // The welcome and lock screens: 46% of the screen, capped at 420.
    const { edgeDip } = curveGeometry(390, 420, 0.55);
    expect(edgeDip).toBeGreaterThan(20);
  });

  it('drops the edge visibly on a short panel too', () => {
    // The sign-in header. This is the case that shipped flat: the requested
    // radius (252) was taller than the panel (180), so it was scaled away.
    const { edgeDip } = curveGeometry(390, 180, 0.7);
    expect(edgeDip).toBeGreaterThan(10);
  });

  it('never asks for a radius the renderer would silently rescale', () => {
    for (const width of WIDTHS) {
      for (const height of [120, 180, 260, 420]) {
        for (const curve of [0.2, 0.55, 0.7, 1]) {
          const { radius, drawnWidth } = curveGeometry(width, height, curve);
          // A corner cannot be taller than its box…
          expect(radius).toBeLessThanOrEqual(height);
          // …and two bottom corners cannot be wider than one.
          expect(radius * 2).toBeLessThanOrEqual(drawnWidth);
        }
      }
    }
  });

  it('keeps the arc reaching into the visible width', () => {
    // The overhang must stay inside the arc. Once it passes the radius, the
    // screen sees only the flat middle — which is what "flat" looked like.
    for (const width of WIDTHS) {
      for (const height of [120, 180, 260, 420]) {
        const { overhang, radius, edgeDip } = curveGeometry(width, height, 0.55);
        expect(overhang).toBeLessThan(radius);
        expect(edgeDip).toBeGreaterThan(0);
      }
    }
  });

  it('draws nothing at all rather than half a shape when asked for no curve', () => {
    const { radius, edgeDip, drawnWidth } = curveGeometry(390, 200, 0);
    expect(radius).toBe(0);
    expect(edgeDip).toBe(0);
    expect(drawnWidth).toBe(390);
  });
});
