/**
 * Saying who paid, in one place.
 *
 * A bill can record several payers, and every screen that mentions one has to
 * decide the same thing: name the person, or count them. Getting it wrong is
 * not a cosmetic slip — "Asha paid" over a bill that Asha and Ravi split puts
 * the whole thing on one of them, in a list somebody reads to remember what
 * happened.
 *
 * The rules live here as plain functions so the group ledger, the month
 * drill-down and the audit trail cannot drift apart, and so they can be tested
 * without a screen (mobile's vitest renders nothing by design).
 */

/** The payer rows as every read model carries them: id and minor amount. */
export interface PayerRow {
  readonly member_id: string;
  readonly amount: string;
}

/** Who paid, as a row subtitle has to say it. */
export type PaidBy =
  | { readonly kind: 'one'; readonly memberId: string | null; readonly amount: bigint }
  | { readonly kind: 'several'; readonly count: number; readonly amount: bigint };

/**
 * One payer is named and credited with what they put in. Several are counted,
 * and the figure is the total between them — naming whoever happens to sort
 * first would credit them with the whole bill.
 *
 * No payers at all reads as one unnamed one, which is what a row with a missing
 * version already showed.
 */
export function paidBy(payers: readonly PayerRow[]): PaidBy {
  if (payers.length > 1) {
    return {
      kind: 'several',
      count: payers.length,
      amount: payers.reduce((sum, row) => sum + BigInt(row.amount), 0n),
    };
  }
  const only = payers[0];
  return {
    kind: 'one',
    memberId: only?.member_id ?? null,
    amount: only ? BigInt(only.amount) : 0n,
  };
}

/**
 * A stable key for "who paid, and how much" — what the audit trail compares.
 *
 * The amounts belong in it. Comparing only the set of names meant that moving
 * ₹100 from Asha to Ravi on an unchanged ₹1,000 bill left no trace at all: the
 * total never moved, so there was no amount line either, and an edit to a
 * recorded fact went unrecorded on the one screen whose whole job is recording
 * edits (ADR-004).
 */
export function payerFactsKey(payers: readonly PayerRow[]): string {
  return payers
    .map((row) => `${row.member_id}:${row.amount}`)
    .sort()
    .join(',');
}

/**
 * The payers as the audit trail prints them. One payer is a name: the amount
 * beside it would only repeat the bill's own total line. Several carry their
 * figures, because with the set unchanged the figures are the entire change —
 * "Asha, Ravi → Asha, Ravi" says nothing.
 */
export function payerAuditText(
  payers: readonly PayerRow[],
  nameOf: (id: string | null) => string,
  formatAmount: (minor: bigint) => string,
  none: string,
): string {
  if (payers.length === 0) return none;
  if (payers.length === 1) return nameOf(payers[0]!.member_id);
  return payers
    .map((row) => `${nameOf(row.member_id)} ${formatAmount(BigInt(row.amount))}`)
    .join(', ');
}
