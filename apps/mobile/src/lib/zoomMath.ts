export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Keeps a pan offset inside the image area visible at the current zoom scale. */
export function clampZoomPan(value: number, viewport: number, scale: number): number {
  'worklet';
  if (scale <= 1 || viewport <= 0) return 0;
  const limit = ((scale - 1) * viewport) / 2;
  return Math.min(limit, Math.max(-limit, value));
}

/** Clamps both axes of a zoomed image pan to the current viewport and scale. */
export function clampZoomPoint(
  point: { readonly x: number; readonly y: number },
  size: Size,
  scale: number,
): { x: number; y: number } {
  'worklet';
  return {
    x: clampZoomPan(point.x, size.width, scale),
    y: clampZoomPan(point.y, size.height, scale),
  };
}
