/**
 * The Excel workbook — a real .xlsx built with SheetJS (pure JS, no native
 * module, so it ships fine over OTA and runs in a unit test unchanged).
 *
 * Five sheets — Summary, Expenses, Settlements, Balances, Members — with money
 * kept as a numeric major-unit value in its own column and the ISO currency
 * code in the adjacent column, so a reader can sum a column and never mix two
 * currencies into one cell (ADR-004). Where a human will read the number, a
 * formatted display column sits beside it.
 *
 * Pure: `buildGroupExportWorkbook` returns a SheetJS workbook, and
 * `workbookToBase64` serialises it. The screen owns the file write + share.
 */

import * as XLSX from 'xlsx';

import { type GroupExportModel } from './groupExport';

/** The visible labels the workbook needs — sheet names and column headers. */
export interface GroupExportSheetLabels {
  readonly sheetSummary: string;
  readonly sheetExpenses: string;
  readonly sheetSettlements: string;
  readonly sheetBalances: string;
  readonly sheetMembers: string;
  /** Summary rows. */
  readonly fieldGroup: string;
  readonly fieldType: string;
  readonly fieldCurrency: string;
  readonly fieldGeneratedOn: string;
  readonly fieldMembers: string;
  readonly fieldExpenses: string;
  readonly fieldSettlements: string;
  readonly fieldTotalSpent: string;
  /** Column headers, shared where they mean the same thing. */
  readonly colDate: string;
  readonly colDescription: string;
  readonly colCategory: string;
  readonly colPaidBy: string;
  readonly colParticipants: string;
  readonly colAmount: string;
  readonly colDisplay: string;
  readonly colCurrency: string;
  readonly colDeleted: string;
  readonly colFrom: string;
  readonly colTo: string;
  readonly colMethod: string;
  readonly colStatus: string;
  readonly colCount: string;
  readonly colMember: string;
  readonly colRole: string;
  readonly colDirection: string;
  readonly colBalance: string;
  readonly colJoined: string;
  /** Cell values for the two booleans. */
  readonly yes: string;
  readonly no: string;
}

type Cell = string | number | boolean;
type Sheet = Cell[][];

/**
 * Assemble the five sheets. Returns a SheetJS workbook — serialise it with
 * `workbookToBase64`.
 */
export function buildGroupExportWorkbook(
  model: GroupExportModel,
  labels: GroupExportSheetLabels,
): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  // --- Summary ------------------------------------------------------------
  const summary: Sheet = [
    [labels.fieldGroup, model.groupName],
    [labels.fieldType, model.groupType],
    [labels.fieldCurrency, model.currency],
    [labels.fieldGeneratedOn, model.generatedOnText],
    [labels.fieldMembers, model.memberCount],
    [labels.fieldExpenses, model.expenseCount],
    [labels.fieldSettlements, model.settlementCount],
    [],
    // Per-currency spend totals, each a summable number beside its code.
    [labels.fieldTotalSpent, labels.colCurrency, labels.colCount],
    ...model.totals.map((total) => [total.amount.value, total.amount.currency, total.count]),
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summary), labels.sheetSummary);

  // --- Expenses -----------------------------------------------------------
  const expenses: Sheet = [
    [
      labels.colDate,
      labels.colDescription,
      labels.colCategory,
      labels.colPaidBy,
      labels.colParticipants,
      labels.colAmount,
      labels.colCurrency,
      labels.colDisplay,
      labels.colDeleted,
    ],
    ...model.expenses.map((expense) => [
      expense.date ?? '',
      expense.description,
      expense.category,
      expense.paidBy,
      expense.participants,
      expense.amount.value,
      expense.amount.currency,
      expense.amount.text,
      expense.deleted ? labels.yes : labels.no,
    ]),
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(expenses), labels.sheetExpenses);

  // --- Settlements --------------------------------------------------------
  const settlements: Sheet = [
    [
      labels.colDate,
      labels.colFrom,
      labels.colTo,
      labels.colMethod,
      labels.colStatus,
      labels.colAmount,
      labels.colCurrency,
      labels.colDisplay,
    ],
    ...model.settlements.map((settlement) => [
      settlement.date ?? '',
      settlement.from,
      settlement.to,
      settlement.method,
      settlement.status,
      settlement.amount.value,
      settlement.amount.currency,
      settlement.amount.text,
    ]),
  ];
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(settlements),
    labels.sheetSettlements,
  );

  // --- Balances -----------------------------------------------------------
  const balances: Sheet = [
    [
      labels.colMember,
      labels.colDirection,
      labels.colBalance,
      labels.colCurrency,
      labels.colDisplay,
    ],
    ...model.balances.map((balance) => [
      balance.name,
      balance.directionText,
      // Signed major-unit number, so a column sum reflects who owes whom.
      balance.signedValue,
      balance.amount.currency,
      balance.amount.text,
    ]),
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(balances), labels.sheetBalances);

  // --- Members ------------------------------------------------------------
  const members: Sheet = [
    [labels.colMember, labels.colRole, labels.colJoined],
    ...model.members.map((member) => [
      member.name,
      member.role,
      member.isGhost ? labels.no : labels.yes,
    ]),
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(members), labels.sheetMembers);

  return workbook;
}

/** Serialise a workbook to a base64 .xlsx string (for the file write). */
export function workbookToBase64(workbook: XLSX.WorkBook): string {
  return XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' }) as string;
}
