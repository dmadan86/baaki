/**
 * Sanitising and normalising the Markdown a comment carries.
 *
 * Expense comments are stored as Markdown, but only a deliberately tiny subset
 * is ever meaningful — bold, italic, strikethrough and bullet lists (see
 * `CommentMarkdown`). Everything the renderer does not understand renders as
 * literal text, so the render side is inherently safe. This module is the write
 * side of that contract: whatever a client sends is normalised down to the same
 * subset before it leaves the device, so the stored value never carries anything
 * the renderer would have to be trusted to ignore.
 *
 * Comments are text only — no images, ever (ADR-046 keeps comment bytes off R2).
 * Image Markdown is therefore stripped here as well as never offered in the UI.
 *
 * React Native renders through `<Text>`, which has no DOM and executes no HTML,
 * so a `<script>` in a comment is only ever the five literal characters. The
 * sanitiser still strips HTML-shaped tags so the *stored* value stays clean for
 * any future reader (e.g. an export, or a web client that must render to HTML —
 * where raw HTML would be an XSS vector and must additionally be sanitised at
 * that renderer).
 */

/** Matches the server CHECK (`char_length(body) <= 2000`) and the RPC guard. */
export const MAX_COMMENT_LENGTH = 2000;

// An HTML-shaped tag: `<tag …>`, `</tag>` or `<tag/>`. Anchored on a letter
// after the `<` so ordinary prose like `a < b` or `x <- y` is left untouched.
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

// Image Markdown: `![alt](url)` — removed outright (comments never carry bytes).
const IMAGE_MD = /!\[[^\]]*\]\([^)]*\)/g;

// Link Markdown: `[text](url)` — the renderer has no link support, so keep the
// visible text and drop the target rather than leave a raw URL sitting in the
// body. Runs after image stripping so an image's `![…]` is already gone.
const LINK_MD = /\[([^\]]*)\]\([^)]*\)/g;

// Control characters that are never legitimate in a typed comment. Tab and
// newline are kept (newlines carry the line structure the renderer reads);
// everything else in the C0/C1 range and the DEL is dropped.
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Reduce a raw comment string to the stored, safe Markdown subset:
 *
 * - normalise CRLF / CR to LF,
 * - strip control characters (keeping tab and newline),
 * - remove HTML-shaped tags and image Markdown, and flatten links to their text,
 * - collapse three-or-more blank lines to a single blank line,
 * - trim, and hard-cap at {@link MAX_COMMENT_LENGTH}.
 *
 * Pure and deterministic. The empty string is a valid result (an empty comment
 * is refused by the caller, not here).
 */
export function sanitizeCommentMarkdown(input: string): string {
  let text = input.replace(/\r\n?/g, '\n');
  text = text.replace(CONTROL_CHARS, '');
  text = text.replace(IMAGE_MD, '');
  text = text.replace(LINK_MD, '$1');
  text = text.replace(HTML_TAG, '');
  // Collapse runs of blank lines: at most one empty line between paragraphs.
  text = text.replace(/\n{3,}/g, '\n\n');
  // Trim outer whitespace, then also strip trailing spaces on each line so the
  // stored value is stable regardless of how the toolbar inserted markers.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
  if (text.length > MAX_COMMENT_LENGTH) text = text.slice(0, MAX_COMMENT_LENGTH).trim();
  return text;
}
