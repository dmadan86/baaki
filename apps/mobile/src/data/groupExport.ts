/**
 * Per-group export — the pure core (TDR §11, ADR-004).
 *
 * A single group's ledger, assembled entirely from data the caller has already
 * read out of the local mirror, into one plain model that two renderers turn
 * into a file: a professional PDF (an HTML template printed by expo-print) and
 * a real .xlsx workbook (SheetJS). Nothing in this file touches the network, the
 * filesystem, or any native module — that is the whole point. It takes rows and
 * returns strings/objects, so it can be unit-tested on plain Node without a
 * device, and the screen that owns the native I/O stays a thin shell around it.
 *
 * Money stays honest here: amounts are bigint minor units end to end (ADR-003),
 * formatted for display through `@waves/core` (`format`) and, only for the
 * spreadsheet where a cell must be summable, turned into a major-unit Number via
 * `toMajorString`. Currencies never mix in a single total (ADR-004): the summary
 * band totals per currency, each on its own line.
 */

import { format, minorUnitScale, toMajorString, type CurrencyCode } from '@waves/core';

import type { ExpenseRow, SettlementRow } from './types';
import { expenseTitle } from './expenseTitle';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A member with its display name already resolved by the caller.
 *
 * Name resolution (`displayName` in `data/types`) depends on the viewer's
 * profile id and their device-local block list — state this pure module has no
 * business reaching for — so the screen resolves each name first and hands us
 * the finished string. That keeps this function a pure function of its inputs
 * and lets a test pass three plain members with no mocks.
 */
export interface ExportMemberInput {
  readonly id: string;
  /** Already-resolved, viewer-aware display name ("You", "Priya", …). */
  readonly name: string;
  readonly role: 'admin' | 'member';
  /** A ghost has not joined yet — surfaced so the sheet can note it. */
  readonly isGhost: boolean;
}

/**
 * The localized labels the model needs to bake into its display strings.
 *
 * Category names, the group-type label, settlement-method names and the two
 * role words are all language-dependent, so the caller (which has `useStrings`)
 * resolves them and passes them in. Table headers and section titles are the
 * renderer's concern and live in `GroupExportLabels` instead.
 */
export interface ExportModelLabels {
  /** The app wordmark — the same in every locale, never translated. */
  readonly appName: string;
  /** The group's type, already localized ("Trip", "Home", …). */
  readonly groupType: string;
  /** Built-in category id → localized name (the `t.categories` map). */
  readonly categories: Readonly<Record<string, string>>;
  /** Settlement method id → localized name ("UPI", "Cash", …). */
  readonly methods: Readonly<Record<string, string>>;
  /** What to call an expense nobody described. */
  readonly untitled: string;
  /** The two membership roles. */
  readonly roleAdmin: string;
  readonly roleMember: string;
  /** A ghost member's standing ("Not joined yet"). */
  readonly notJoined: string;
  /** Fallback when a member id resolves to nobody. */
  readonly someone: string;
  /** Balance directions, for the balances rows and the spreadsheet. */
  readonly owed: string;
  readonly owes: string;
  readonly settled: string;
}

/**
 * Everything `buildGroupExportModel` needs, all already read from the mirror.
 * `balances` is the ledger's net-per-member map for the group's default
 * currency (what the Balances tab shows).
 */
export interface GroupExportInput {
  readonly group: {
    readonly name: string;
    readonly coverEmoji: string | null;
    readonly type: string;
    readonly currency: string;
  };
  readonly members: readonly ExportMemberInput[];
  readonly expenses: readonly ExpenseRow[];
  readonly settlements: readonly SettlementRow[];
  readonly balances: ReadonlyMap<string, bigint>;
  readonly labels: ExportModelLabels;
  /** ISO instant the export was generated — captured once by the caller, never
   *  read from the clock in here (this stays a pure function). */
  readonly generatedOnIso: string;
  /** BCP-47 locale that drives money and date formatting. */
  readonly locale: string;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One money value, ready for both renderers. */
export interface ExportMoney {
  /** Integer minor units — the source of truth (ADR-003). */
  readonly minor: bigint;
  readonly currency: string;
  /** Locale-formatted with symbol, for the PDF and any human-facing cell. */
  readonly text: string;
  /** Major-unit Number so a spreadsheet can sum the column. */
  readonly value: number;
}

export interface ExportMemberRow {
  readonly id: string;
  readonly name: string;
  /** The localized role word. */
  readonly role: string;
  readonly isGhost: boolean;
}

export interface ExportExpenseRow {
  readonly id: string;
  /** ISO calendar date (no zone), or null for a row with no version yet. */
  readonly date: string | null;
  /** Localized day-month-year stamp for the date, or '' when undated. */
  readonly dateText: string;
  readonly description: string;
  /** Localized category name, or '' when the expense has none. */
  readonly category: string;
  /** Who paid, comma-joined (one name, or several for a split payment). */
  readonly paidBy: string;
  readonly amount: ExportMoney;
  /** The people the bill was split across, comma-joined. */
  readonly participants: string;
  readonly participantCount: number;
  /** A soft-deleted expense stays in the export (append-only ledger, ADR-004),
   *  flagged rather than dropped. */
  readonly deleted: boolean;
}

export interface ExportSettlementRow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly amount: ExportMoney;
  readonly date: string | null;
  readonly dateText: string;
  /** Localized method name ("UPI", "Cash", …). */
  readonly method: string;
  readonly status: string;
}

export enum BalanceDir {
  Owed = 'owed',
  Owes = 'owes',
  Settled = 'settled',
}

export interface ExportBalanceRow {
  readonly memberId: string;
  /** The direction word carries the sign, so `amount` is the magnitude only —
   *  a clean "₹1,200.00" beside "owes", never a stray minus in the statement. */
  readonly name: string;
  readonly amount: ExportMoney;
  /** Signed major-unit number for the spreadsheet: positive means the group owes
   *  them, negative means they owe, zero is square. Lets a column sum to zero. */
  readonly signedValue: number;
  readonly direction: BalanceDir;
  /** The localized direction sentence ("is owed", "owes", "settled up"). */
  readonly directionText: string;
}

/** A per-currency spend total for the summary band (ADR-004: never mixed). */
export interface ExportTotalRow {
  readonly amount: ExportMoney;
  /** How many (non-deleted) expenses contributed to this currency's total. */
  readonly count: number;
}

export interface GroupExportModel {
  readonly appName: string;
  readonly groupName: string;
  readonly coverEmoji: string | null;
  readonly groupType: string;
  /** The group's default currency code. */
  readonly currency: string;
  readonly locale: string;
  /** True for a right-to-left locale (Arabic) — the renderers mirror on it. */
  readonly isRtl: boolean;
  /** Localized "generated on <date>" date stamp. */
  readonly generatedOnText: string;
  readonly members: readonly ExportMemberRow[];
  readonly expenses: readonly ExportExpenseRow[];
  readonly settlements: readonly ExportSettlementRow[];
  readonly balances: readonly ExportBalanceRow[];
  /** Per-currency spend totals, biggest currency first isn't meaningful across
   *  currencies, so they keep first-seen order. */
  readonly totals: readonly ExportTotalRow[];
  readonly memberCount: number;
  readonly expenseCount: number;
  readonly settlementCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A right-to-left locale — only Arabic among the four we ship. */
export function isRtlLocale(locale: string): boolean {
  return /^ar\b/i.test(locale) || locale.toLowerCase().startsWith('ar-');
}

/** Build one `ExportMoney` from minor units, formatted for the locale. */
function money(minor: bigint, currency: string, locale: string): ExportMoney {
  const code = currency as CurrencyCode;
  return {
    minor,
    currency,
    text: format({ minor, currency: code }, { locale }),
    // Number() is safe for display/sum: a value big enough to lose precision
    // (>9e15 minor units) is not a real split, and a spreadsheet cell is not
    // ledger arithmetic (the same reasoning `@waves/core` format() uses).
    value: Number(toMajorString({ minor, currency: code })),
  };
}

/**
 * A localized day-month-year stamp for an ISO calendar date, read in UTC so it
 * prints the day the expense is dated rather than shifting across a zone. An
 * unparseable date falls back to the raw ISO string rather than throwing.
 */
function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(parsed));
}

/** The localized name for a member id, or the "someone" fallback. */
function nameFor(id: string | null, byId: Map<string, ExportMemberInput>, someone: string): string {
  if (!id) return someone;
  return byId.get(id)?.name ?? someone;
}

// ---------------------------------------------------------------------------
// The assembly
// ---------------------------------------------------------------------------

/**
 * Turn already-read group data into the export model. Pure: no clock, no
 * network, no native. Deleted expenses are kept but flagged and excluded from
 * the spend totals (they never happened, ledger-wise); every settlement and
 * member is included as-is.
 */
export function buildGroupExportModel(input: GroupExportInput): GroupExportModel {
  const { group, labels, locale } = input;
  const byId = new Map(input.members.map((member) => [member.id, member]));

  const members: ExportMemberRow[] = input.members.map((member) => ({
    id: member.id,
    name: member.name,
    role: member.role === 'admin' ? labels.roleAdmin : labels.roleMember,
    isGhost: member.isGhost,
  }));

  const expenses: ExportExpenseRow[] = input.expenses.map((expense) => {
    const version = expense.currentVersion;
    const description = expenseTitle(
      version?.description,
      version?.category,
      { categories: labels.categories, expense: { untitled: labels.untitled } },
      version?.category_meta,
    );
    // A custom tag names itself; a built-in resolves through the categories map;
    // an uncategorised expense shows a blank category cell rather than a word.
    const category =
      version?.category_meta?.label ??
      (version?.category ? (labels.categories[version.category] ?? '') : '');
    const payers = version?.payers ?? [];
    const shares = version?.shares ?? [];
    const paidBy = payers.map((payer) => nameFor(payer.member_id, byId, labels.someone)).join(', ');
    const participantNames = shares.map((share) => nameFor(share.member_id, byId, labels.someone));
    const date = version?.expense_date ?? null;
    const amountMinor = version ? BigInt(version.amount) : 0n;
    return {
      id: expense.id,
      date,
      dateText: formatDate(date, locale),
      description,
      category,
      paidBy,
      amount: money(amountMinor, version?.currency ?? group.currency, locale),
      participants: participantNames.join(', '),
      participantCount: participantNames.length,
      deleted: Boolean(expense.deleted_at),
    };
  });

  const settlements: ExportSettlementRow[] = input.settlements.map((settlement) => ({
    id: settlement.id,
    from: nameFor(settlement.from_member_id, byId, labels.someone),
    to: nameFor(settlement.to_member_id, byId, labels.someone),
    amount: money(BigInt(settlement.amount), settlement.currency, locale),
    date: settlement.initiated_at ?? null,
    dateText: formatDate(settlement.initiated_at ?? null, locale),
    method: labels.methods[settlement.method] ?? settlement.method,
    status: settlement.status,
  }));

  // Balances: the ledger's net-per-member map, in the group default currency.
  // A member the map omits is square (0). Order follows the member list so the
  // balances table reads in the same order as the members table.
  const balances: ExportBalanceRow[] = input.members.map((member) => {
    const minor = input.balances.get(member.id) ?? 0n;
    const direction =
      minor > 0n ? BalanceDir.Owed : minor < 0n ? BalanceDir.Owes : BalanceDir.Settled;
    const directionText =
      direction === BalanceDir.Owed
        ? labels.owed
        : direction === BalanceDir.Owes
          ? labels.owes
          : labels.settled;
    const magnitude = minor < 0n ? -minor : minor;
    return {
      memberId: member.id,
      name: member.name,
      // The magnitude for display (the word carries the direction); the signed
      // value for the spreadsheet, where the sign is the useful part of a sum.
      amount: money(magnitude, group.currency, locale),
      signedValue: money(minor, group.currency, locale).value,
      direction,
      directionText,
    };
  });

  // Per-currency spend totals (ADR-004). Deleted expenses are excluded — they
  // are shown in the table for the record but were reversed out of the ledger.
  const totalMinorByCurrency = new Map<string, { minor: bigint; count: number }>();
  for (const expense of input.expenses) {
    if (expense.deleted_at) continue;
    const version = expense.currentVersion;
    if (!version) continue;
    const currency = version.currency;
    const entry = totalMinorByCurrency.get(currency) ?? { minor: 0n, count: 0 };
    entry.minor += BigInt(version.amount);
    entry.count += 1;
    totalMinorByCurrency.set(currency, entry);
  }
  const totals: ExportTotalRow[] = [...totalMinorByCurrency.entries()].map(([currency, entry]) => ({
    amount: money(entry.minor, currency, locale),
    count: entry.count,
  }));

  return {
    appName: labels.appName,
    groupName: group.name,
    coverEmoji: group.coverEmoji,
    groupType: labels.groupType,
    currency: group.currency,
    locale,
    isRtl: isRtlLocale(locale),
    generatedOnText: formatDate(input.generatedOnIso, locale),
    members,
    expenses,
    settlements,
    balances,
    totals,
    memberCount: members.length,
    expenseCount: input.expenses.length,
    settlementCount: settlements.length,
  };
}

// Re-export minorUnitScale so callers importing from this module have the whole
// money vocabulary in one place; it participates in no logic here.
export { minorUnitScale };
