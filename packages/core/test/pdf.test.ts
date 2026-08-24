/**
 * The PDF export is a summary, not the lossless path (JSON/CSV are). These
 * tests pin the three things that must not break: money formats with the right
 * decimals per currency, non-WinAnsi text degrades to '?' rather than corrupting
 * the file, and the assembled document is a structurally valid, single-byte
 * (Latin-1) PDF that paginates.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTENT_WIDTH,
  columnsMaxWidth,
  formatMinor,
  LEDGER_TABLE_COLUMNS,
  PdfBuilder,
  winAnsi,
} from '../src/export/pdf';

describe('formatMinor', () => {
  it('uses each currency’s own decimal places', () => {
    expect(formatMinor(123456n, 'INR')).toBe('1,234.56');
    expect(formatMinor(1000n, 'JPY')).toBe('1,000'); // zero-decimal
    expect(formatMinor(1000n, 'KWD')).toBe('1.000'); // three-decimal
    expect(formatMinor(5n, 'USD')).toBe('0.05');
  });

  it('groups thousands and keeps a sign', () => {
    expect(formatMinor(1234567890n, 'USD')).toBe('12,345,678.90');
    expect(formatMinor(-4200n, 'INR')).toBe('-42.00');
    expect(formatMinor('700', 'INR')).toBe('7.00'); // accepts a numeric string
  });
});

describe('winAnsi', () => {
  it('keeps ASCII and Latin-1, degrades the rest to a question mark', () => {
    expect(winAnsi('Café résumé')).toBe('Café résumé');
    expect(winAnsi('கறி dinner')).toBe('??? dinner'); // 3 Tamil code points
    expect(winAnsi('pay 🎉 now')).toBe('pay ? now'); // emoji -> single '?'
    expect(winAnsi('taxi\tride')).toBe('taxi ride'); // tab -> space
  });
});

describe('PdfBuilder', () => {
  it('emits a structurally valid, Latin-1-only PDF', () => {
    const pdf = new PdfBuilder().heading('Trip').body('Line one').build();
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
    expect(pdf).toContain('endobj');
    expect(pdf).toContain('startxref');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    // Every char must be <= 0xFF so string offsets equal byte offsets and btoa works.
    for (const ch of pdf) expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0xff);
  });

  it('paginates when the content outgrows one page', () => {
    const builder = new PdfBuilder().heading('Big trip');
    for (let i = 0; i < 200; i += 1) builder.row(`row ${i}`);
    const pdf = builder.build();
    const pageCount = (pdf.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
  });

  it('always produces at least one page, even empty', () => {
    const pdf = new PdfBuilder().build();
    expect(pdf).toContain('/Type /Page');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('keeps the ledger table within the printable page width', () => {
    // The last column is cut off if the row is wider than the page; this is the
    // guard that the export's chosen widths clear it.
    const widths = LEDGER_TABLE_COLUMNS.map((column) => column.width);
    expect(columnsMaxWidth(widths, 9)).toBeLessThanOrEqual(CONTENT_WIDTH);
  });

  it('truncates an overflowing cell with an ASCII marker, never a ? ellipsis', () => {
    const pdf = new PdfBuilder()
      .columns([{ text: 'x'.repeat(400), width: LEDGER_TABLE_COLUMNS[1].width }])
      .build();
    expect(pdf).toContain('...'); // ASCII, draws correctly in WinAnsi
    expect(pdf).not.toContain('…'); // U+2026 would render as '?'
  });
});
