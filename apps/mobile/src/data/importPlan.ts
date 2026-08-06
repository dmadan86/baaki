/**
 * Turning something imported into the exact payload the write path takes.
 *
 * Pure on purpose. Both import screens are mostly picking and confirming, and
 * the part that can quietly get money wrong — which member ends up on which
 * share, whose name is on the payment, what the total is — is here where it
 * can be tested without a phone.
 *
 * Nothing in this file writes or enqueues. It produces a plan; the screen
 * shows it, a person confirms it, and only then does it reach the queue.
 */

import {
  serialiseSplitParams,
  type ExpenseCandidate,
  type ImportedExpense,
  type MemberId,
  type SplitParams,
} from '@baaki/core';

/** Everything except the ids, which are derived from `seed` (see lib/importId). */
export interface PlannedExpense {
  /**
   * Stable across re-imports of the same thing. The ids both mutation and
   * expense are derived from, which is what makes a second import a no-op.
   */
  readonly seed: string;
  readonly description: string;
  readonly category: string | null;
  readonly expenseDate: string;
  readonly currency: string;
  readonly amount: bigint;
  readonly splitParams: SplitParams;
  readonly participants: readonly MemberId[];
  readonly payers: Readonly<Record<MemberId, bigint>>;
  readonly notes: string | null;
}

/** A CSV person with no member chosen for them. Refuses rather than guessing. */
export class UnmappedPersonError extends Error {
  constructor(readonly person: string) {
    super(`No one chosen for "${person}"`);
    this.name = 'UnmappedPersonError';
  }
}

/**
 * One bank message into one expense.
 *
 * The message says what left the account and roughly where it went. It does
 * not say who was there, so the split is whatever the person confirming it
 * chose — never inferred from the text.
 */
export function planFromSms(
  candidate: ExpenseCandidate,
  options: {
    readonly payer: MemberId;
    readonly participants: readonly MemberId[];
  },
): PlannedExpense {
  if (options.participants.length === 0) {
    throw new Error('An expense needs at least one person to split between');
  }

  return {
    seed: `sms:${candidate.dedupeKey}`,
    description: candidate.merchant ?? 'Card payment',
    category: null,
    expenseDate: candidate.at.slice(0, 10),
    currency: candidate.amount.currency,
    amount: candidate.amount.minor,
    splitParams: { kind: 'equal' },
    participants: options.participants,
    payers: { [options.payer]: candidate.amount.minor },
    // The message is kept verbatim so the expense can be checked against what
    // the bank actually said, months later, when nobody remembers the trip.
    notes: noteForSms(candidate),
  };
}

function noteForSms(candidate: ExpenseCandidate): string {
  const parts = ['Imported from an SMS'];
  if (candidate.sender) parts.push(`from ${candidate.sender}`);
  if (candidate.accountTail) parts.push(`·⋯${candidate.accountTail}`);
  if (candidate.reference) parts.push(`· ref ${candidate.reference}`);
  if (candidate.dateInferred) parts.push('· date taken from when the message arrived');
  return parts.join(' ');
}

/**
 * One CSV row into one expense.
 *
 * The file names people; a group has member ids. Every name must have been
 * given one — an unmapped person raises rather than being dropped, because
 * dropping them would leave a row whose shares no longer sum to its total and
 * the write path would reject it with something far less useful to read.
 */
export function planFromCsv(
  expense: ImportedExpense,
  mapping: Readonly<Record<string, MemberId>>,
  index: number,
): PlannedExpense {
  const remapped = (amounts: Readonly<Record<string, bigint>>): Record<MemberId, bigint> => {
    const out: Record<MemberId, bigint> = {};
    for (const [person, value] of Object.entries(amounts)) {
      const memberId = mapping[person];
      if (!memberId) throw new UnmappedPersonError(person);
      // Two CSV columns can be pointed at one member — the same person listed
      // under two spellings. Add rather than overwrite, or half their money
      // disappears with nothing to show it happened.
      out[memberId] = (out[memberId] ?? 0n) + value;
    }
    return out;
  };

  const shares = remapped(expense.shares);
  const payers = remapped(expense.payers);

  return {
    // The row's position is part of the seed: a file can legitimately hold two
    // identical rows (the same coffee, twice, on one day) and both are real.
    seed: `csv:${index}:${expense.date}:${expense.description}:${expense.currency}:${expense.amount}`,
    description: expense.description,
    category: expense.category,
    expenseDate: expense.date,
    currency: expense.currency,
    amount: expense.amount,
    splitParams: { kind: 'exact', amounts: shares },
    participants: Object.keys(shares),
    payers: Object.fromEntries(Object.entries(payers).filter(([, value]) => value !== 0n)),
    notes: 'Imported from a Splitwise export',
  };
}

/** The wire form: bigints as decimal strings, exactly as the queue carries them. */
export function toMutationPayload(
  plan: PlannedExpense,
  ids: { readonly expenseId: string },
): Record<string, unknown> {
  return {
    expenseId: ids.expenseId,
    description: plan.description,
    category: plan.category,
    expenseDate: plan.expenseDate,
    currency: plan.currency,
    amount: plan.amount.toString(),
    // An exact split carries minor units, which JSON cannot hold. One
    // definition of that conversion, shared with the server (@baaki/core).
    splitParams: serialiseSplitParams(plan.splitParams),
    participants: [...plan.participants],
    payers: Object.fromEntries(
      Object.entries(plan.payers).map(([id, value]) => [id, value.toString()]),
    ),
    notes: plan.notes,
  };
}
