import { aiCost, daily, geo, money } from '@/lib/data';

/**
 * Reports, as CSV, because the thing anybody actually wants to do with a table
 * of numbers is put it in a spreadsheet.
 *
 * The route is behind the same middleware as the pages, and every function it
 * calls re-checks the session itself — a download link is the kind of URL that
 * gets pasted somewhere, and it must be worthless to whoever finds it.
 */

const REPORTS = {
  daily: async () => rows(await daily(90)),
  geo: async () => rows(await geo()),
  money: async () => rows(await money()),
  ai: async () => rows(await aiCost(90)),
} satisfies Record<string, () => Promise<string>>;

type ReportName = keyof typeof REPORTS;

export async function GET(_request: Request, context: { params: Promise<{ report: string }> }) {
  const { report } = await context.params;
  if (!(report in REPORTS)) {
    return new Response('No such report', { status: 404 });
  }

  const csv = await REPORTS[report as ReportName]();
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="baaki-${report}-${today()}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

const today = () => new Date().toISOString().slice(0, 10);

/** Header row from the first object's keys; every row quoted the same way. */
function rows<T extends object>(data: readonly T[]): string {
  if (data.length === 0) return '';
  const columns = Object.keys(data[0]!);
  const lines = [columns.map(cell).join(',')];
  for (const row of data) {
    const fields = row as Record<string, unknown>;
    lines.push(columns.map((column) => cell(fields[column])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * RFC 4180 quoting. Every field is quoted rather than only the ones that need
 * it — a country code is two letters today and the day one of these fields
 * carries a comma is not the day to find out this function was optimistic.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}
