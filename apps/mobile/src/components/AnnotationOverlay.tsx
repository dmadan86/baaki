import { Svg, Polyline, Text as SvgText } from 'react-native-svg';

import type { Annotations } from '@/lib/annotations';

/**
 * Draws a receipt's pen/text markup over the image. Pure and read-only — the
 * same renderer the editor previews live and the viewer shows over a saved
 * image, so what you drew is exactly what everyone later sees.
 *
 * Every coordinate is normalised (0..1) to the image, so this only needs the
 * pixel size the image is currently drawn at: it scales points by width/height
 * and a stroke width / text size by the smaller edge, and the overlay lines up
 * at a thumbnail or a full-screen zoom alike.
 */
export function AnnotationOverlay({
  annotations,
  width,
  height,
}: {
  annotations: Annotations;
  width: number;
  height: number;
}): React.JSX.Element | null {
  if (width <= 0 || height <= 0) return null;
  const minEdge = Math.min(width, height);

  return (
    <Svg
      width={width}
      height={height}
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, top: 0 }}
    >
      {annotations.strokes.map((stroke, i) => {
        const pts: string[] = [];
        for (let p = 0; p + 1 < stroke.points.length; p += 2) {
          pts.push(
            `${(stroke.points[p] as number) * width},${(stroke.points[p + 1] as number) * height}`,
          );
        }
        return (
          <Polyline
            key={`s${i}`}
            points={pts.join(' ')}
            fill="none"
            stroke={stroke.color}
            strokeWidth={Math.max(1, stroke.width * minEdge)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      {annotations.texts.map((note, i) => (
        <SvgText
          key={`t${i}`}
          x={note.x * width}
          y={note.y * height}
          fill={note.color}
          fontSize={Math.max(8, note.size * minEdge)}
          fontWeight="700"
          // A thin contrasting outline so a note stays legible over a busy
          // receipt whatever colour it is.
          stroke="rgba(0,0,0,0.45)"
          strokeWidth={0.5}
        >
          {note.text}
        </SvgText>
      ))}
    </Svg>
  );
}
