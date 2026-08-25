/**
 * Renders the tiny Markdown subset a comment may carry — and nothing else.
 *
 * Supported: `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, and `- ` / `* `
 * bullet lines, plus hard line breaks. Anything outside that subset is rendered
 * as literal text: no links, no images, no headings, no raw HTML. Because this
 * only ever emits React Native `<Text>`/`<View>` — never HTML — there is no DOM
 * and nothing to execute, so an unrecognised or hostile construct is at worst
 * ugly, never dangerous. The write side (`sanitizeCommentMarkdown`) keeps the
 * stored value inside this same subset, so the two never disagree.
 *
 * The inline parser is a small recursive splitter rather than a dependency: the
 * subset is fixed and narrow, a custom parser keeps links/images/HTML
 * unrepresentable by construction, and it adds no native module (which the
 * current Expo SDK / RN pin makes worth avoiding).
 */

import type { ReactNode } from 'react';
import type { TextStyle } from 'react-native';
import { View } from 'react-native';

import { Text, useTheme } from '@waves/ui';

// Each inline marker, in precedence order. Bold before italic so `**x**` is read
// as bold rather than italic-of-`*x*`; on a tie of start position the earlier
// entry wins (see `firstMatch`). The backreference (`\1`) on italic forces the
// same delimiter to open and close, so `*x*` and `_x_` match but `*x_` does not.
const INLINE: { re: RegExp; style: TextStyle; group: number }[] = [
  { re: /\*\*([\s\S]+?)\*\*/, style: { fontWeight: '700' }, group: 1 },
  { re: /~~([\s\S]+?)~~/, style: { textDecorationLine: 'line-through' }, group: 1 },
  { re: /(\*|_)([\s\S]+?)\1/, style: { fontStyle: 'italic' }, group: 2 },
];

/** The earliest inline match across all markers, or null when the text is plain. */
function firstMatch(text: string): { m: RegExpExecArray; style: TextStyle; group: number } | null {
  let best: { m: RegExpExecArray; style: TextStyle; group: number } | null = null;
  for (const marker of INLINE) {
    const m = marker.re.exec(text);
    // Strictly-smaller keeps ties on the first (higher-precedence) marker.
    if (m && (best === null || m.index < best.m.index)) {
      best = { m, style: marker.style, group: marker.group };
    }
  }
  return best;
}

/**
 * Turn one line of inline Markdown into styled `<Text>` spans. Recurses into the
 * matched inner text (so `**_x_**` nests) and the trailing remainder. `counter`
 * hands out stable keys; RN happily mixes raw strings and `<Text>` as children.
 */
function renderInline(text: string, counter: { n: number }): ReactNode[] {
  if (text === '') return [];
  const hit = firstMatch(text);
  if (!hit) return [text];
  const before = text.slice(0, hit.m.index);
  const inner = hit.m[hit.group] ?? '';
  const after = text.slice(hit.m.index + hit.m[0].length);
  const nodes: ReactNode[] = [];
  if (before) nodes.push(before);
  nodes.push(
    <Text key={`s${counter.n++}`} style={hit.style}>
      {renderInline(inner, counter)}
    </Text>,
  );
  nodes.push(...renderInline(after, counter));
  return nodes;
}

const BULLET = /^[ \t]*[-*][ \t]+(.*)$/;

/**
 * Render a comment body. Block structure is line-based: a `- `/`* ` line is a
 * bullet row, a blank line is a small gap, anything else is a paragraph line.
 */
export function CommentMarkdown({ source }: { source: string }): React.JSX.Element {
  const theme = useTheme();
  const counter = { n: 0 };
  const lines = source.split('\n');
  return (
    <View style={{ gap: 2 }}>
      {lines.map((line, index) => {
        const bullet = BULLET.exec(line);
        if (bullet) {
          return (
            <View key={`l${index}`} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Text variant="body" style={{ color: theme.color.textMuted }}>
                {'•'}
              </Text>
              <Text variant="body" style={{ flex: 1 }}>
                {renderInline(bullet[1] ?? '', counter)}
              </Text>
            </View>
          );
        }
        if (line.trim() === '') {
          // A blank line is a paragraph break — a little vertical air, not a
          // full empty text row (which would collapse to nothing anyway).
          return <View key={`l${index}`} style={{ height: theme.spacing.xs }} />;
        }
        return (
          <Text key={`l${index}`} variant="body">
            {renderInline(line, counter)}
          </Text>
        );
      })}
    </View>
  );
}
