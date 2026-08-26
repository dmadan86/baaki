import { describe, expect, it } from 'vitest';

import { clampZoomPan, clampZoomPoint } from '../src/lib/zoomMath';

describe('clampZoomPan', () => {
  it('keeps fit-scale images centered', () => {
    expect(clampZoomPan(120, 300, 1)).toBe(0);
    expect(clampZoomPan(-120, 300, 0.8)).toBe(0);
  });

  it('clamps positive and negative pan to the scaled viewport bounds', () => {
    expect(clampZoomPan(999, 300, 2)).toBe(150);
    expect(clampZoomPan(-999, 300, 2)).toBe(-150);
    expect(clampZoomPan(90, 300, 2)).toBe(90);
  });
});

describe('clampZoomPoint', () => {
  it('clamps each axis independently', () => {
    expect(clampZoomPoint({ x: 500, y: -500 }, { width: 200, height: 400 }, 3)).toEqual({
      x: 200,
      y: -400,
    });
  });
});
