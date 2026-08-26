import { describe, expect, it } from 'vitest';

import { clampZoomPan, clampZoomPoint, naturalSizeForUri } from '../src/lib/zoomMath';

describe('naturalSizeForUri', () => {
  it('ignores stale dimensions from a previously rendered image uri', () => {
    const previous = { uri: 'file://old.jpg', size: { w: 1000, h: 500 } };

    expect(naturalSizeForUri(previous, 'file://new.jpg')).toBeNull();
    expect(naturalSizeForUri(previous, 'file://old.jpg')).toEqual({ w: 1000, h: 500 });
  });
});

describe('clampZoomPan', () => {
  it('keeps fit-scale images centered', () => {
    expect(clampZoomPan(120, 300, 240, 1)).toBe(0);
    expect(clampZoomPan(-120, 300, 240, 0.8)).toBe(0);
  });

  it('clamps positive and negative pan to the scaled content bounds', () => {
    expect(clampZoomPan(999, 300, 300, 2)).toBe(150);
    expect(clampZoomPan(-999, 300, 300, 2)).toBe(-150);
    expect(clampZoomPan(90, 300, 300, 2)).toBe(90);
  });

  it('keeps a contained landscape image from panning into vertical blank space', () => {
    expect(clampZoomPan(999, 400, 150, 2)).toBe(0);
  });

  it('allows pan once contained portrait content grows past the viewport', () => {
    expect(clampZoomPan(999, 300, 260, 2)).toBe(110);
  });
});

describe('clampZoomPoint', () => {
  it('clamps each axis independently using contained content dimensions', () => {
    expect(
      clampZoomPoint(
        { x: 500, y: -500 },
        { width: 200, height: 400 },
        { width: 160, height: 400 },
        3,
      ),
    ).toEqual({
      x: 140,
      y: -400,
    });
  });
});
