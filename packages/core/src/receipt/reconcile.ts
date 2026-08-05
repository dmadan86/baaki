/**
 * Checking the model's arithmetic (ADR-008 / TDR §6).
 *
 * A vision model reading a crumpled thermal receipt will sometimes drop a
 * digit, and it will do so confidently. The defence is not a better prompt: it
 * is that a receipt carries its own checksum — the items and charges have to
 * add up to the printed total. When they don't, we know something was misread
 * before the user ever sees a number, and we can point at the lines to check
 * rather than silently creating a wrong expense.
 *
 * "AI proposes, human confirms" is only meaningful if the human is told what to
 * look at.
 */

import {
  LOW_CONFIDENCE,
  RECONCILE_TOLERANCE,
  type ParsedReceipt,
  type ReceiptCheck,
  type ReceiptProblem,
} from './types';

export function sumCharges(charges: readonly { amount: number }[]): number {
  return charges.reduce((total, charge) => total + charge.amount, 0);
}

/** Everything added to the items: tax, service, tip, less discounts. */
export function extrasOf(receipt: ParsedReceipt): number {
  return (
    sumCharges(receipt.taxes) +
    (receipt.serviceCharge ?? 0) +
    (receipt.tip ?? 0) -
    sumCharges(receipt.discounts)
  );
}

export function itemsTotalOf(receipt: ParsedReceipt): number {
  return receipt.items.reduce((total, item) => total + item.total, 0);
}

/**
 * Does this receipt add up, and which lines should a person look at?
 *
 * Never throws: a receipt that fails every check is still returned, described,
 * so the review screen can show the photo beside the problems. Refusing to
 * produce an answer would just push the failure somewhere less useful.
 */
export function checkReceipt(receipt: ParsedReceipt): ReceiptCheck {
  const problems: ReceiptProblem[] = [];
  const needsReview = new Set<number>();

  if (receipt.items.length === 0) {
    problems.push({
      kind: 'no_items',
      message: 'No line items were found on this receipt',
    });
  }

  receipt.items.forEach((item, itemIndex) => {
    if (item.total < 0) {
      problems.push({
        kind: 'negative_line',
        itemIndex,
        message: `"${item.label}" came out negative — it may be a discount printed as a line`,
      });
      needsReview.add(itemIndex);
    }
    if (item.confidence < LOW_CONFIDENCE) {
      problems.push({
        kind: 'low_confidence',
        itemIndex,
        message: `"${item.label}" was hard to read — check the name and amount`,
      });
      needsReview.add(itemIndex);
    }
  });

  const itemsTotal = itemsTotalOf(receipt);
  const extras = extrasOf(receipt);
  const difference = receipt.grandTotal - (itemsTotal + extras);
  const reconciles = Math.abs(difference) <= RECONCILE_TOLERANCE;

  if (!reconciles) {
    problems.push({
      kind: 'does_not_reconcile',
      message:
        `The lines add up to ${itemsTotal + extras} but the receipt says ${receipt.grandTotal}. ` +
        'Something was misread — check the amounts before saving.',
    });
    // When the total is wrong we cannot say which line is at fault, so every
    // line the model was least sure of goes on the list.
    const leastConfident = [...receipt.items.keys()].sort(
      (a, b) => (receipt.items[a]?.confidence ?? 1) - (receipt.items[b]?.confidence ?? 1),
    );
    for (const itemIndex of leastConfident.slice(0, 3)) needsReview.add(itemIndex);
  }

  return {
    reconciles,
    difference,
    itemsTotal,
    extras,
    problems,
    needsReview: [...needsReview].sort((a, b) => a - b),
  };
}

/**
 * Turn a reviewed receipt into the parameters an itemized split needs.
 *
 * The expense total is the printed grand total, never the sum of what we
 * parsed: the receipt is the source of truth about how much money left the
 * table. `computeShares` then asserts that items plus charges equal it, so a
 * receipt that does not reconcile cannot become an expense at all.
 */
export function toItemizedParams(
  receipt: ParsedReceipt,
  claims: Readonly<Record<number, readonly string[]>>,
): {
  amount: bigint;
  params: {
    kind: 'itemized';
    items: { label: string; total: bigint }[];
    claims: Record<number, readonly string[]>;
    taxes: bigint;
    serviceCharge: bigint;
    tip: bigint;
    discounts: bigint;
  };
} {
  return {
    amount: BigInt(receipt.grandTotal),
    params: {
      kind: 'itemized',
      items: receipt.items.map((item) => ({ label: item.label, total: BigInt(item.total) })),
      claims: { ...claims },
      taxes: BigInt(sumCharges(receipt.taxes)),
      serviceCharge: BigInt(receipt.serviceCharge ?? 0),
      tip: BigInt(receipt.tip ?? 0),
      discounts: BigInt(sumCharges(receipt.discounts)),
    },
  };
}
