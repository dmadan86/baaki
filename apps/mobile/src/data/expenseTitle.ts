/**
 * What to call an expense nobody described.
 *
 * Describing an expense is optional, and plenty of people never do it — you are
 * at a table, you type 480, you tap save. The app used to answer that by writing
 * the literal English word "Expense" into the row, so a group's list read
 * "Expense / Expense / Expense / Expense" and told you nothing you could not
 * already see from the amounts. It also put a word nobody typed into an
 * append-only ledger, into the CSV export, and into the sentence a notification
 * shows somebody else.
 *
 * The category is the better answer, and it is already there: the row shows its
 * icon, and the label is translated in every language. "Food & drink · Aug 8"
 * beats "Expense · Aug 8", and it is true rather than invented.
 *
 * This lives in one place because five screens ask the same question, and five
 * copies of a fallback are five chances for a list and a detail page to disagree
 * about what the same expense is called.
 */

/** Just enough of the strings table to name an expense, so tests need no mock. */
export interface TitleStrings {
  readonly categories: Readonly<Record<string, string>>;
  readonly expense: { readonly untitled: string };
}

export function expenseTitle(
  description: string | null | undefined,
  category: string | null | undefined,
  t: TitleStrings,
  /** The custom tag's snapshot, when the category is a user tag (extends TDR §8);
   *  its label names the expense, since `t.categories` only knows the built-ins. */
  meta?: { label: string } | null,
): string {
  // `?? ''` is not enough: the column is NOT NULL, so "no description" arrives
  // as an empty string far more often than as null, and whitespace is what a
  // keyboard leaves behind when somebody thinks better of typing.
  const said = (description ?? '').trim();
  if (said !== '') return said;

  // A custom tag names itself; a built-in is named through the string table.
  const label = meta?.label ?? (category ? t.categories[category] : undefined);
  return label ?? t.expense.untitled;
}
