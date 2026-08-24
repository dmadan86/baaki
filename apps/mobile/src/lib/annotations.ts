/**
 * Receipt markup — the small vector overlay a person draws over a receipt image
 * (A46). It is stored as data on the attachment row, never baked into the pixels,
 * so it stays editable and the same image serves everyone.
 *
 * Every coordinate is normalised to the image: `0..1` across the width and the
 * height, and a stroke width / text size is a fraction of the image's smaller
 * edge. That way the overlay lines up whatever size the image is drawn at — a
 * thumbnail, a full-screen zoom, another phone.
 *
 * The parser is defensive: the JSON came from the database (which a determined
 * client could have written directly), so it clamps every number into range and
 * caps the counts, and a value it cannot make sense of is dropped rather than
 * trusted. A garbage blob parses to an empty overlay, never a crash.
 */

/** A freehand stroke: a flat list of points `[x0, y0, x1, y1, …]`, each 0..1. */
export interface AnnotStroke {
  readonly color: string;
  readonly width: number;
  readonly points: readonly number[];
}

/** A text note anchored at (x, y) in 0..1 image space; `size` is a fraction of
 *  the image's smaller edge. */
export interface AnnotText {
  readonly x: number;
  readonly y: number;
  readonly color: string;
  readonly size: number;
  readonly text: string;
}

export interface Annotations {
  readonly strokes: readonly AnnotStroke[];
  readonly texts: readonly AnnotText[];
}

export const EMPTY_ANNOTATIONS: Annotations = { strokes: [], texts: [] };

/** The pen/text palette — a short, high-contrast set that reads on a receipt. */
export const ANNOT_COLORS = ['#EF4444', '#2563EB', '#16A34A', '#F59E0B', '#111827', '#FFFFFF'];

// Caps: enough for real markup, small enough to bound render cost and the 256KB
// column the migration enforces.
const MAX_STROKES = 300;
const MAX_POINTS = 2000; // per stroke (flat, so 1000 x/y pairs)
const MAX_TEXTS = 60;
const MAX_TEXT_LEN = 200;

function clamp01(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function clampSize(n: unknown): number {
  // A stroke width / text size is a fraction of the smaller edge; keep it sane.
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(0.5, Math.max(0.001, n)) : 0.01;
}

function safeColor(c: unknown): string {
  // Only accept a `#rgb`/`#rrggbb` hex — never arbitrary text that a renderer
  // might treat as something else.
  return typeof c === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c) ? c : '#EF4444';
}

export function parseAnnotations(raw: unknown): Annotations {
  if (!raw || typeof raw !== 'object') return EMPTY_ANNOTATIONS;
  const obj = raw as { strokes?: unknown; texts?: unknown };

  const strokes: AnnotStroke[] = [];
  if (Array.isArray(obj.strokes)) {
    for (const s of obj.strokes.slice(0, MAX_STROKES)) {
      if (!s || typeof s !== 'object') continue;
      const st = s as { color?: unknown; width?: unknown; points?: unknown };
      if (!Array.isArray(st.points)) continue;
      const points = st.points.slice(0, MAX_POINTS).map(clamp01);
      if (points.length < 2) continue; // Need at least one point (x, y).
      strokes.push({ color: safeColor(st.color), width: clampSize(st.width), points });
    }
  }

  const texts: AnnotText[] = [];
  if (Array.isArray(obj.texts)) {
    for (const t of obj.texts.slice(0, MAX_TEXTS)) {
      if (!t || typeof t !== 'object') continue;
      const tx = t as { x?: unknown; y?: unknown; color?: unknown; size?: unknown; text?: unknown };
      const text = typeof tx.text === 'string' ? tx.text.slice(0, MAX_TEXT_LEN) : '';
      if (text.trim() === '') continue;
      texts.push({
        x: clamp01(tx.x),
        y: clamp01(tx.y),
        color: safeColor(tx.color),
        size: clampSize(tx.size),
        text,
      });
    }
  }

  return { strokes, texts };
}

export function isEmptyAnnotations(a: Annotations): boolean {
  return a.strokes.length === 0 && a.texts.length === 0;
}

/**
 * The letterboxed rectangle an image of `natural` size is drawn at when fit
 * (`contain`) inside a `box`. Both the editor and the viewer size the image and
 * its overlay to this exact rectangle so normalised markup lines up with the
 * pixels. Falls back to the whole box until the natural size is known.
 */
export function containRect(
  box: { w: number; h: number },
  natural: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (box.w <= 0 || box.h <= 0 || natural.w <= 0 || natural.h <= 0) {
    return { x: 0, y: 0, w: box.w, h: box.h };
  }
  const scale = Math.min(box.w / natural.w, box.h / natural.h);
  const w = natural.w * scale;
  const h = natural.h * scale;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}
