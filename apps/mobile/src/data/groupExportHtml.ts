/**
 * The PDF template — a self-contained HTML document for `expo-print`.
 *
 * expo-print renders HTML in a system WebView and prints it to a PDF, so unlike
 * the base-14 PDF writer in `@waves/core` this speaks full Unicode: Tamil, Hindi
 * and Arabic descriptions print exactly, and money keeps its real symbol. The
 * document is styled like a financial statement — a branded header, a summary
 * band, then balances / expenses / settlements tables with zebra striping and
 * right-aligned money columns — using print CSS with a system font stack so it
 * needs no network (a strict rule for a WebView print) and looks native on any
 * device.
 *
 * Pure and native-free: it takes a `GroupExportModel` plus the visible labels
 * and returns an HTML string, so it is unit-testable without a device.
 */

import { BalanceDir, type GroupExportModel } from './groupExport';

/**
 * Every visible label the document prints that is not already baked into the
 * model. The screen resolves these from `useStrings`; a test passes a small
 * English set.
 */
export interface GroupExportLabels {
  /** Document + section titles. */
  readonly documentTitle: string;
  readonly generatedOn: string;
  readonly totalSpent: string;
  readonly membersLabel: string;
  readonly expensesLabel: string;
  readonly settlementsLabel: string;
  readonly balancesTitle: string;
  readonly membersTitle: string;
  /** Table column headers. */
  readonly colDate: string;
  readonly colDescription: string;
  readonly colCategory: string;
  readonly colPaidBy: string;
  readonly colAmount: string;
  readonly colParticipants: string;
  readonly colFrom: string;
  readonly colTo: string;
  readonly colMethod: string;
  readonly colStatus: string;
  readonly colMember: string;
  readonly colRole: string;
  readonly colBalance: string;
  readonly colDirection: string;
  /** Empty-section note and the deleted-row tag. */
  readonly noneYet: string;
  readonly deletedTag: string;
  /** Footer line. */
  readonly footer: string;
}

/** HTML-escape a dynamic string so a description with `<`, `&` or `"` is safe. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One `<tr>` of arbitrary cells; `align` marks the money column right. */
function row(cells: readonly { readonly html: string; readonly cls?: string }[]): string {
  return `<tr>${cells
    .map((cell) => `<td class="${cell.cls ?? ''}">${cell.html}</td>`)
    .join('')}</tr>`;
}

function headerRow(labels: readonly { readonly text: string; readonly cls?: string }[]): string {
  return `<tr>${labels
    .map((label) => `<th class="${label.cls ?? ''}">${escapeHtml(label.text)}</th>`)
    .join('')}</tr>`;
}

/** A "nothing here yet" placeholder row spanning the whole table. */
function emptyRow(span: number, note: string): string {
  return `<tr><td class="empty" colspan="${span}">${escapeHtml(note)}</td></tr>`;
}

/**
 * Render the whole statement to one HTML string.
 *
 * The palette is a light print palette with one brand accent (Waves indigo);
 * the CSS lives inline in a single `<style>` so the document is entirely
 * self-contained. `dir="rtl"` and right alignment flip on for an Arabic locale.
 */
export function renderGroupExportHtml(model: GroupExportModel, labels: GroupExportLabels): string {
  const dir = model.isRtl ? 'rtl' : 'ltr';
  // In RTL the text columns hang right and the money column hangs left; in LTR
  // it is the reverse. One class toggles the money column's edge.
  const moneyAlign = model.isRtl ? 'text-align:left' : 'text-align:right';
  const startAlign = model.isRtl ? 'text-align:right' : 'text-align:left';

  const emoji = model.coverEmoji ? `${escapeHtml(model.coverEmoji)} ` : '';

  const summaryTotals = model.totals.length
    ? model.totals
        .map(
          (total) =>
            `<div class="total-line"><span class="total-amt">${escapeHtml(
              total.amount.text,
            )}</span><span class="total-cur">${escapeHtml(total.amount.currency)}</span></div>`,
        )
        .join('')
    : `<div class="total-line"><span class="total-amt">—</span></div>`;

  const balanceRows = model.balances.length
    ? model.balances
        .map((balance) => {
          const cls =
            balance.direction === BalanceDir.Owed
              ? 'pos'
              : balance.direction === BalanceDir.Owes
                ? 'neg'
                : 'muted';
          return row([
            { html: escapeHtml(balance.name) },
            { html: escapeHtml(balance.directionText), cls: 'muted' },
            {
              html: `<span class="${cls}">${escapeHtml(balance.amount.text)}</span>`,
              cls: 'money',
            },
          ]);
        })
        .join('')
    : emptyRow(3, labels.noneYet);

  const expenseRows = model.expenses.length
    ? model.expenses
        .map((expense) => {
          const desc = expense.deleted
            ? `<span class="struck">${escapeHtml(expense.description)}</span> <span class="tag">${escapeHtml(
                labels.deletedTag,
              )}</span>`
            : escapeHtml(expense.description);
          return row([
            { html: escapeHtml(expense.dateText), cls: 'nowrap' },
            { html: desc },
            { html: escapeHtml(expense.category), cls: 'muted' },
            { html: escapeHtml(expense.paidBy) },
            { html: escapeHtml(expense.amount.text), cls: 'money' },
          ]);
        })
        .join('')
    : emptyRow(5, labels.noneYet);

  const settlementRows = model.settlements.length
    ? model.settlements
        .map((settlement) =>
          row([
            { html: escapeHtml(settlement.dateText), cls: 'nowrap' },
            { html: escapeHtml(settlement.from) },
            { html: escapeHtml(settlement.to) },
            { html: escapeHtml(settlement.method), cls: 'muted' },
            { html: escapeHtml(settlement.amount.text), cls: 'money' },
          ]),
        )
        .join('')
    : emptyRow(5, labels.noneYet);

  const memberRows = model.members.length
    ? model.members
        .map((member) =>
          row([{ html: escapeHtml(member.name) }, { html: escapeHtml(member.role), cls: 'muted' }]),
        )
        .join('')
    : emptyRow(2, labels.noneYet);

  // The whole document. `@page` gives print margins; the accent bar and the
  // summary band carry the brand; zebra striping and a hairline grid make the
  // tables read as a statement rather than a dump.
  return `<!DOCTYPE html>
<html lang="${escapeHtml(model.locale)}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(labels.documentTitle)}</title>
<style>
  :root {
    --brand: #4f46e5;
    --brand-soft: #eef2ff;
    --ink: #111827;
    --ink-muted: #6b7280;
    --line: #e5e7eb;
    --pos: #047857;
    --neg: #b91c1c;
    --zebra: #f9fafb;
  }
  * { box-sizing: border-box; }
  @page { margin: 32px; }
  html, body {
    margin: 0;
    padding: 0;
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
      Arial, "Noto Sans", "Noto Sans Arabic", "Noto Sans Tamil", "Noto Sans Devanagari", sans-serif;
    font-size: 12px;
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .wrap { padding: 8px 4px 28px; }
  header.brand {
    border-top: 4px solid var(--brand);
    padding-top: 14px;
    margin-bottom: 18px;
  }
  .brand-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .app-name {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--brand);
  }
  .group-name { font-size: 22px; font-weight: 700; margin: 2px 0 0; }
  .group-type { color: var(--ink-muted); font-size: 12px; margin-top: 2px; }
  .generated { color: var(--ink-muted); font-size: 11px; text-align: ${model.isRtl ? 'left' : 'right'}; }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    background: var(--brand-soft);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 22px;
  }
  .summary .cell { flex: 1 1 30%; min-width: 120px; }
  .summary .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-muted);
    margin-bottom: 4px;
  }
  .summary .value { font-size: 18px; font-weight: 700; }
  .total-line { display: flex; align-items: baseline; gap: 6px; }
  .total-amt { font-size: 18px; font-weight: 700; }
  .total-cur { font-size: 10px; color: var(--ink-muted); }

  section { margin-bottom: 22px; }
  h2 {
    font-size: 13px;
    font-weight: 700;
    margin: 0 0 8px;
    padding-bottom: 4px;
    border-bottom: 2px solid var(--line);
  }
  table { width: 100%; border-collapse: collapse; }
  th {
    ${startAlign};
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-muted);
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
  }
  td {
    ${startAlign};
    padding: 6px 8px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  tbody tr:nth-child(even) td { background: var(--zebra); }
  th.money, td.money { ${moneyAlign}; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.nowrap { white-space: nowrap; }
  td.muted, .muted { color: var(--ink-muted); }
  td.empty { color: var(--ink-muted); text-align: center; padding: 14px; }
  .pos { color: var(--pos); font-weight: 600; }
  .neg { color: var(--neg); font-weight: 600; }
  .struck { text-decoration: line-through; color: var(--ink-muted); }
  .tag {
    display: inline-block;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--neg);
    border: 1px solid var(--neg);
    border-radius: 4px;
    padding: 0 4px;
  }
  footer {
    margin-top: 26px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
    color: var(--ink-muted);
    font-size: 10px;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="wrap">
    <header class="brand">
      <div class="brand-row">
        <div>
          <div class="app-name">${escapeHtml(model.appName)}</div>
          <h1 class="group-name">${emoji}${escapeHtml(model.groupName)}</h1>
          <div class="group-type">${escapeHtml(model.groupType)}</div>
        </div>
        <div class="generated">${escapeHtml(labels.generatedOn)}<br />${escapeHtml(
          model.generatedOnText,
        )}</div>
      </div>
    </header>

    <div class="summary">
      <div class="cell">
        <div class="label">${escapeHtml(labels.totalSpent)}</div>
        <div class="value">${summaryTotals}</div>
      </div>
      <div class="cell">
        <div class="label">${escapeHtml(labels.membersLabel)}</div>
        <div class="value">${model.memberCount}</div>
      </div>
      <div class="cell">
        <div class="label">${escapeHtml(labels.expensesLabel)}</div>
        <div class="value">${model.expenseCount}</div>
      </div>
    </div>

    <section>
      <h2>${escapeHtml(labels.balancesTitle)}</h2>
      <table>
        <thead>${headerRow([
          { text: labels.colMember },
          { text: labels.colDirection },
          { text: labels.colBalance, cls: 'money' },
        ])}</thead>
        <tbody>${balanceRows}</tbody>
      </table>
    </section>

    <section>
      <h2>${escapeHtml(labels.expensesLabel)}</h2>
      <table>
        <thead>${headerRow([
          { text: labels.colDate },
          { text: labels.colDescription },
          { text: labels.colCategory },
          { text: labels.colPaidBy },
          { text: labels.colAmount, cls: 'money' },
        ])}</thead>
        <tbody>${expenseRows}</tbody>
      </table>
    </section>

    <section>
      <h2>${escapeHtml(labels.settlementsLabel)}</h2>
      <table>
        <thead>${headerRow([
          { text: labels.colDate },
          { text: labels.colFrom },
          { text: labels.colTo },
          { text: labels.colMethod },
          { text: labels.colAmount, cls: 'money' },
        ])}</thead>
        <tbody>${settlementRows}</tbody>
      </table>
    </section>

    <section>
      <h2>${escapeHtml(labels.membersTitle)}</h2>
      <table>
        <thead>${headerRow([{ text: labels.colMember }, { text: labels.colRole }])}</thead>
        <tbody>${memberRows}</tbody>
      </table>
    </section>

    <footer>${escapeHtml(labels.footer)}</footer>
  </div>
</body>
</html>`;
}
