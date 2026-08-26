export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface NaturalImageSize {
  readonly uri: string;
  readonly size: { readonly w: number; readonly h: number };
}

/** Selects dimensions only for the currently rendered image URI. */
export function naturalSizeForUri(
  natural: NaturalImageSize | null,
  uri: string,
): { w: number; h: number } | null {
  return natural?.uri === uri ? natural.size : null;
}

/** Keeps one zoomed axis inside the visible viewport without assuming the image fills it. */
export function clampZoomPan(
  value: number,
  viewport: number,
  content: number,
  scale: number,
): number {
  'worklet';
  if (scale <= 1 || viewport <= 0 || content <= 0) return 0;
  const limit = Math.max(0, (scale * content - viewport) / 2);
  return Math.min(limit, Math.max(-limit, value));
}

/** Clamps both axes of a zoomed image pan using contained image and viewport dimensions. */
export function clampZoomPoint(
  point: { readonly x: number; readonly y: number },
  viewport: Size,
  content: Size,
  scale: number,
): { x: number; y: number } {
  'worklet';
  return {
    x: clampZoomPan(point.x, viewport.width, content.width, scale),
    y: clampZoomPan(point.y, viewport.height, content.height, scale),
  };
}
