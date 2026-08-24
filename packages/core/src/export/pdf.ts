/**
 * A tiny, dependency-free PDF writer — enough for a human-readable ledger, no
 * more. Deno has no PDF library we trust and native deps are off the table in
 * an edge function, so this hand-rolls the format: a catalog, a page tree, one
 * content stream per page, and the three base-14 fonts (Helvetica,
 * Helvetica-Bold, Courier) that every reader ships, so nothing is embedded.
 *
 * The lossless exports are JSON and CSV (ADR-012). This is the summary you hand
 * someone: it degrades gracefully rather than perfectly. Base-14 fonts speak
 * WinAnsi, not Unicode, so a Tamil or Arabic description is transliterated to
 * '?' here while remaining exact in the JSON/CSV. Money never degrades — amounts
 * are printed with their ISO currency *code* (ASCII), never a symbol, and each
 * currency stands on its own line (ADR-004: currencies never mix).
 *
 * The whole document is assembled as a Latin-1 string (every char ≤ 0xFF, so
 * one char is one byte), which makes xref byte offsets equal string offsets and
 * lets the caller `btoa()` it straight to base64.
 */

import { minorUnitExponent, type CurrencyCode } from '../money/currency';

/**
 * Minor units → a human decimal, ASCII only, using the same decimal-places
 * table the rest of the app uses (`minorUnitExponent`). The ISO code (never a
 * symbol) is appended by the caller, so the string stays WinAnsi-safe and two
 * currencies never look interchangeable (ADR-004).
 */
export function formatMinor(amount: bigint | number | string, currency: string): string {
  const minor = typeof amount === 'bigint' ? amount : BigInt(amount);
  const places = minorUnitExponent((currency ?? '').toUpperCase() as CurrencyCode);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places) || '0';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = places > 0 ? `.${digits.slice(digits.length - places)}` : '';
  return `${negative ? '-' : ''}${grouped}${fraction}`;
}

const PAGE_WIDTH = 595; // A4 at 72 dpi, near enough
const PAGE_HEIGHT = 842;
const MARGIN = 44;
const BOTTOM = MARGIN;

type FontId = 'F1' | 'F2' | 'F3'; // Helvetica, Helvetica-Bold, Courier

interface Line {
  readonly text: string;
  readonly font: FontId;
  readonly size: number;
  /** Extra space, in points, above this line. */
  readonly gapBefore: number;
}

/**
 * Collapse anything a base-14 font cannot draw to a WinAnsi-safe string.
 * Printable ASCII and Latin-1 pass; a tab becomes a space; everything else
 * (CJK, Indic, Arabic, emoji) becomes '?'. Control characters are dropped.
 */
export function winAnsi(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9) out += ' ';
    else if (code < 32) continue;
    else if (code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += ch;
    else out += '?';
  }
  return out;
}

/** Escape a PDF text string: backslash, parens, and keep it Latin-1. */
function pdfString(input: string): string {
  return winAnsi(input).replace(/[\\()]/g, (m) => `\\${m}`);
}

/** Rough width of a base-14 string at a size, for truncation only. */
function approxWidth(text: string, font: FontId, size: number): number {
  // Courier is a true monospace at 0.6em; Helvetica averages ~0.5em.
  const em = font === 'F3' ? 0.6 : 0.5;
  return text.length * size * em;
}

/** Truncate with an ellipsis so a long cell never runs off the page. */
function clip(text: string, font: FontId, size: number, maxWidth: number): string {
  if (approxWidth(text, font, size) <= maxWidth) return text;
  const perChar = (font === 'F3' ? 0.6 : 0.5) * size;
  const room = Math.max(1, Math.floor(maxWidth / perChar) - 1);
  return `${text.slice(0, room)}…`;
}

export class PdfBuilder {
  private readonly lines: Line[] = [];

  /** A heading in Helvetica-Bold. */
  heading(text: string, size = 15): this {
    this.lines.push({ text, font: 'F2', size, gapBefore: this.lines.length ? 14 : 0 });
    return this;
  }

  subheading(text: string, size = 11): this {
    this.lines.push({ text, font: 'F2', size, gapBefore: 10 });
    return this;
  }

  /** Body text in Helvetica. */
  body(text: string, size = 10): this {
    this.lines.push({ text, font: 'F1', size, gapBefore: 2 });
    return this;
  }

  /** A monospaced row (Courier) so columns line up. */
  row(text: string, size = 9): this {
    this.lines.push({ text, font: 'F3', size, gapBefore: 1 });
    return this;
  }

  spacer(points = 8): this {
    this.lines.push({ text: '', font: 'F1', size: 0, gapBefore: points });
    return this;
  }

  /** A single-line Courier row from fixed-width columns. */
  columns(cells: readonly { text: string; width: number }[], size = 9): this {
    let line = '';
    for (const cell of cells) {
      const chars = Math.max(1, Math.floor(cell.width / (size * 0.6)));
      const text = clip(cell.text, 'F3', size, cell.width);
      line += text.padEnd(chars + 1, ' ');
    }
    return this.row(line.trimEnd(), size);
  }

  /** Lay the lines out into paginated content streams. */
  private paginate(): string[] {
    const usableWidth = PAGE_WIDTH - MARGIN * 2;
    const pages: string[] = [];
    let stream = '';
    let y = PAGE_HEIGHT - MARGIN;
    let open = false;

    const flush = (): void => {
      if (open) {
        stream += 'ET\n';
        pages.push(stream);
        open = false;
      }
    };

    for (const line of this.lines) {
      const advance = (line.size || 10) + line.gapBefore;
      if (!open || y - advance < BOTTOM) {
        flush();
        stream = 'BT\n';
        y = PAGE_HEIGHT - MARGIN;
        open = true;
      }
      y -= advance;
      if (line.text) {
        const text = clip(line.text, line.font, line.size, usableWidth);
        stream += `/${line.font} ${line.size} Tf\n1 0 0 1 ${MARGIN} ${y.toFixed(1)} Tm\n(${pdfString(text)}) Tj\n`;
      }
    }
    flush();
    if (pages.length === 0) pages.push('BT\nET\n');
    return pages;
  }

  /** Serialise to a Latin-1 PDF string; `btoa()` it for base64. */
  build(): string {
    const pageStreams = this.paginate();

    const objects: string[] = [];
    const add = (body: string): number => {
      objects.push(body);
      return objects.length; // 1-based object number
    };

    // Reserve: 1 catalog, 2 pages; fonts and page/content objects follow.
    const catalogNo = 1;
    const pagesNo = 2;
    objects.push('', ''); // placeholders for 1 and 2

    const helv = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    );
    const helvBold = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    );
    const courier = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    );

    const resources = `<< /Font << /F1 ${helv} 0 R /F2 ${helvBold} 0 R /F3 ${courier} 0 R >> >>`;

    const pageNumbers: number[] = [];
    for (const stream of pageStreams) {
      const contentNo = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageNo = add(
        `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources ${resources} /Contents ${contentNo} 0 R >>`,
      );
      pageNumbers.push(pageNo);
    }

    objects[catalogNo - 1] = `<< /Type /Catalog /Pages ${pagesNo} 0 R >>`;
    objects[pagesNo - 1] =
      `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNumbers.length} >>`;

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets[index] = pdf.length;
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    }
    pdf +=
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF`;

    return pdf;
  }
}
