/**
 * A comment field that renders its formatting *as you type* — bold shows bold,
 * italic shows italic — instead of leaving the raw `**` / `_` markers on show.
 *
 * React Native's `<TextInput>` will style nested `<Text>` children while it stays
 * editable (the same technique mention-highlighters use), so the trick is: keep
 * the *raw* Markdown string as the source of truth (it is what the DB stores and
 * what the caret counts against) and hand the field a styled breakdown of that
 * exact string as children. The children therefore contain *every* character of
 * the raw string — same order, same length — so selection and the caret never
 * drift; the marker characters are simply dimmed rather than removed. Removing
 * them would desync the visible text from the logical string and scramble the
 * caret, so "quiet markers" is the honest ceiling for a pure-JS field (a true
 * WYSIWYG that hides the markers needs a WebView editor).
 *
 * The grammar is exactly the stored subset (`CommentMarkdown` / the sanitiser):
 * `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, and `- ` / `* ` bullets.
 */

import { forwardRef } from 'react';
import {
  TextInput,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputSelectionChangeEventData,
  type TextStyle,
} from 'react-native';

import { Text, useTheme } from '@waves/ui';

interface Flags {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

// The inline markers, in precedence order (bold before italic so `**x**` is bold,
// not italic-of-`*x*`), each with its delimiter widths so the marker characters
// can be located and dimmed. Mirrors `CommentMarkdown`'s INLINE table.
const INLINE: { re: RegExp; flag: keyof Flags; group: number; open: number; close: number }[] = [
  { re: /\*\*([\s\S]+?)\*\*/, flag: 'bold', group: 1, open: 2, close: 2 },
  { re: /~~([\s\S]+?)~~/, flag: 'strike', group: 1, open: 2, close: 2 },
  { re: /(\*|_)([\s\S]+?)\1/, flag: 'italic', group: 2, open: 1, close: 1 },
];

const BULLET_PREFIX = /^([ \t]*[-*][ \t]+)/;

/** The earliest inline match across all markers, or null when the slice is plain. */
function firstMatch(
  text: string,
): { m: RegExpExecArray; flag: keyof Flags; group: number; open: number; close: number } | null {
  let best: {
    m: RegExpExecArray;
    flag: keyof Flags;
    group: number;
    open: number;
    close: number;
  } | null = null;
  for (const marker of INLINE) {
    const m = marker.re.exec(text);
    if (m && (best === null || m.index < best.m.index)) {
      best = { m, flag: marker.flag, group: marker.group, open: marker.open, close: marker.close };
    }
  }
  return best;
}

/** One contiguous run of same-styled characters. */
interface Run {
  text: string;
  marker: boolean;
  flags: Flags;
}

/**
 * Break the raw string into styled runs covering every character exactly once.
 * `marker` runs are the delimiter characters (dimmed); the rest carry the inline
 * flags active at that position.
 */
function toRuns(text: string): Run[] {
  const flags: Flags[] = Array.from({ length: text.length }, () => ({}));
  const marker: boolean[] = Array.from({ length: text.length }, () => false);

  const applyContent = (from: number, to: number, active: Flags) => {
    for (let i = from; i < to; i++) flags[i] = { ...active };
  };
  const markDelimiter = (from: number, to: number) => {
    for (let i = from; i < to; i++) marker[i] = true;
  };

  // Walk one slice, assigning flags at absolute offsets; recurse into the matched
  // inner text (so `**_x_**` nests) and the trailing remainder.
  const walk = (slice: string, base: number, active: Flags): void => {
    if (slice === '') return;
    const hit = firstMatch(slice);
    if (!hit) {
      applyContent(base, base + slice.length, active);
      return;
    }
    if (hit.m.index > 0) applyContent(base, base + hit.m.index, active);
    const openStart = base + hit.m.index;
    markDelimiter(openStart, openStart + hit.open);
    const inner = hit.m[hit.group] ?? '';
    const innerStart = openStart + hit.open;
    walk(inner, innerStart, { ...active, [hit.flag]: true });
    markDelimiter(innerStart + inner.length, innerStart + inner.length + hit.close);
    const afterStart = openStart + hit.m[0].length;
    walk(slice.slice(hit.m.index + hit.m[0].length), afterStart, active);
  };

  // Line-aware so a bullet prefix (`- `) can be dimmed before inline parsing.
  let offset = 0;
  for (const line of text.split('\n')) {
    const bullet = BULLET_PREFIX.exec(line);
    const contentStart = bullet ? bullet[1].length : 0;
    if (bullet) markDelimiter(offset, offset + contentStart);
    walk(line.slice(contentStart), offset + contentStart, {});
    // +1 for the '\n' that split removed (harmless past the last line).
    offset += line.length + 1;
  }

  // Coalesce adjacent characters that share a style into runs.
  const runs: Run[] = [];
  for (let i = 0; i < text.length; i++) {
    const isMarker = marker[i];
    const f = flags[i];
    const prev = runs[runs.length - 1];
    if (
      prev &&
      prev.marker === isMarker &&
      prev.flags.bold === f.bold &&
      prev.flags.italic === f.italic &&
      prev.flags.strike === f.strike
    ) {
      prev.text += text[i];
    } else {
      runs.push({ text: text[i] ?? '', marker: isMarker, flags: f });
    }
  }
  return runs;
}

export interface RichCommentInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSelectionChange?: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  selection?: { start: number; end: number };
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<TextStyle>;
}

/**
 * A drop-in multiline field for the comment editor that displays the stored
 * Markdown subset formatted, while `onChangeText` still reports the raw string.
 */
export const RichCommentInput = forwardRef<TextInput, RichCommentInputProps>(
  function RichCommentInput(
    {
      value,
      onChangeText,
      onSelectionChange,
      selection,
      placeholder,
      maxLength,
      autoFocus,
      accessibilityLabel,
      style,
    },
    ref,
  ): React.JSX.Element {
    const theme = useTheme();
    const runs = value === '' ? [] : toRuns(value);

    return (
      <TextInput
        ref={ref}
        onChangeText={onChangeText}
        onSelectionChange={onSelectionChange}
        selection={selection}
        multiline
        autoFocus={autoFocus}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={theme.color.textFaint}
        accessibilityLabel={accessibilityLabel}
        style={style}
      >
        {/* Children (not `value`) carry the text, so runs can be styled while the
            field stays editable. Every character of `value` is present here, in
            order, so the caret and selection map 1:1 to the raw string. */}
        {runs.map((run, i) => (
          <Text
            key={i}
            style={
              run.marker
                ? { color: theme.color.textFaint }
                : {
                    color: theme.color.text,
                    ...(run.flags.bold ? { fontWeight: '700' as const } : null),
                    ...(run.flags.italic ? { fontStyle: 'italic' as const } : null),
                    ...(run.flags.strike ? { textDecorationLine: 'line-through' as const } : null),
                  }
            }
          >
            {run.text}
          </Text>
        ))}
      </TextInput>
    );
  },
);
