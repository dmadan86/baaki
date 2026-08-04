/**
 * Debt simplification (ADR-009 / TDR §3.2).
 *
 * This is a PRESENTATION layer: it proposes the smallest set of transfers that
 * settles the group, but the underlying pairwise ledger is untouched, so
 * toggling it never rewrites history and "why am I paying Priya?" stays
 * answerable from the real edges.
 *
 * Invariants, property-tested:
 *  - every member's net position is unchanged
 *  - at most n−1 transfers per currency
 *  - deterministic ordering for identical input
 */

import type { CurrencyCode } from '../money/currency';
import type { NetBalances, PairwiseEdge } from '../balances/types';
import type { MemberId } from '../split/types';

export interface Transfer {
  readonly from: MemberId;
  readonly to: MemberId;
  readonly currency: CurrencyCode;
  readonly amount: bigint;
}

/** Greedy max-debtor ↔ max-creditor matching, per currency. */
export function simplify(balances: NetBalances): Transfer[] {
  const transfers: Transfer[] = [];
  const currencies = [...balances.keys()].sort();

  for (const currency of currencies) {
    const perCurrency = balances.get(currency);
    if (!perCurrency) continue;

    const debtors: { member: MemberId; amount: bigint }[] = [];
    const creditors: { member: MemberId; amount: bigint }[] = [];
    for (const member of [...perCurrency.keys()].sort()) {
      const balance = perCurrency.get(member) ?? 0n;
      if (balance < 0n) debtors.push({ member, amount: -balance });
      else if (balance > 0n) creditors.push({ member, amount: balance });
    }

    // Ties broken by member id so two devices produce byte-identical output.
    const byAmountThenId = (
      a: { member: MemberId; amount: bigint },
      b: { member: MemberId; amount: bigint },
    ): number =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.member.localeCompare(b.member);

    while (debtors.length > 0 && creditors.length > 0) {
      debtors.sort(byAmountThenId);
      creditors.sort(byAmountThenId);
      const debtor = debtors[0];
      const creditor = creditors[0];
      if (!debtor || !creditor) break;

      const amount = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;
      transfers.push({ from: debtor.member, to: creditor.member, currency, amount });
      debtor.amount -= amount;
      creditor.amount -= amount;
      if (debtor.amount === 0n) debtors.shift();
      if (creditor.amount === 0n) creditors.shift();
    }
  }

  return transfers;
}

/** Convenience: simplify starting from the real pairwise edges. */
export function simplifyPairwise(edges: readonly PairwiseEdge[]): Transfer[] {
  const balances: NetBalances = new Map();
  const bump = (currency: CurrencyCode, member: MemberId, delta: bigint): void => {
    let perCurrency = balances.get(currency);
    if (!perCurrency) {
      perCurrency = new Map();
      balances.set(currency, perCurrency);
    }
    perCurrency.set(member, (perCurrency.get(member) ?? 0n) + delta);
  };
  for (const edge of edges) {
    bump(edge.currency, edge.from, -edge.amount);
    bump(edge.currency, edge.to, edge.amount);
  }
  return simplify(balances);
}

/**
 * "Why am I paying Priya?" — the pairwise edges that a suggested transfer
 * stands in for, so the UI can expand the derivation (ADR-009).
 */
export function explainTransfer(
  transfer: Transfer,
  edges: readonly PairwiseEdge[],
): PairwiseEdge[] {
  return edges.filter(
    (edge) =>
      edge.currency === transfer.currency &&
      (edge.from === transfer.from || edge.to === transfer.from),
  );
}
