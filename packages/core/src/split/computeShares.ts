/**
 * Split computation (TDR §3.1). Pure, deterministic, integer-only.
 *
 * Invariant, property-tested: `Σ shares === amount` for every split type and
 * every valid input. The server recomputes this from `split_params` and rejects
 * any client that disagrees (TDR §4, `SHARE_MISMATCH`).
 */

import {
  distributeProportionally,
  distributeRemainder,
  rotationOffset,
  stableOrder,
} from './remainder';
import {
  SplitError,
  SplitErrorCode,
  SplitType,
  type ComputeSharesInput,
  type ItemizedParams,
  type MemberId,
  type ShareMap,
  type SplitParams,
} from './types';

const TOTAL_BASIS_POINTS = 10000;

export function splitTypeOf(params: SplitParams): SplitType {
  return params.kind as SplitType;
}

export function computeShares(input: ComputeSharesInput): ShareMap {
  const participants = validateParticipants(input.participants);
  if (input.amount < 0n) {
    throw new SplitError(SplitErrorCode.NegativeTotal, 'Expense total cannot be negative');
  }

  const shares = computeByType(input, participants);

  // Every participant appears, even with a zero share, so the UI and the
  // expense_shares table agree on the row set.
  for (const member of participants) {
    if (!shares.has(member)) shares.set(member, 0n);
  }

  assertSumsTo(shares, input.amount);
  return shares;
}

function computeByType(input: ComputeSharesInput, participants: readonly MemberId[]): ShareMap {
  switch (input.params.kind) {
    case 'equal':
      return splitEqually(input.amount, participants, input.seed);

    case 'exact': {
      const shares = new Map<MemberId, bigint>();
      let total = 0n;
      for (const [member, amount] of Object.entries(input.params.amounts)) {
        requireParticipant(member, participants);
        shares.set(member, amount);
        total += amount;
      }
      if (total !== input.amount) {
        throw new SplitError(
          SplitErrorCode.ExactSumMismatch,
          `Exact shares sum to ${total} but the expense is ${input.amount}`,
        );
      }
      return shares;
    }

    case 'percent': {
      const weights = new Map<MemberId, bigint>();
      let total = 0;
      for (const [member, basisPoints] of Object.entries(input.params.basisPoints)) {
        requireParticipant(member, participants);
        if (!Number.isInteger(basisPoints) || basisPoints < 0) {
          throw new SplitError(
            SplitErrorCode.InvalidWeight,
            `Basis points must be non-negative integers, got ${basisPoints} for ${member}`,
          );
        }
        weights.set(member, BigInt(basisPoints));
        total += basisPoints;
      }
      if (total !== TOTAL_BASIS_POINTS) {
        throw new SplitError(
          SplitErrorCode.PercentSumMismatch,
          `Percentages must sum to 100% (10000 basis points), got ${total}`,
        );
      }
      return distributeProportionally(input.amount, weights, input.seed);
    }

    case 'shares': {
      const weights = new Map<MemberId, bigint>();
      let positive = false;
      for (const [member, weight] of Object.entries(input.params.weights)) {
        requireParticipant(member, participants);
        if (!Number.isInteger(weight) || weight < 0) {
          throw new SplitError(
            SplitErrorCode.InvalidWeight,
            `Weights must be non-negative integers, got ${weight} for ${member}`,
          );
        }
        if (weight > 0) positive = true;
        weights.set(member, BigInt(weight));
      }
      if (!positive) {
        throw new SplitError(
          SplitErrorCode.NoPositiveWeight,
          'At least one member needs a positive weight',
        );
      }
      return distributeProportionally(input.amount, weights, input.seed);
    }

    case 'adjustment': {
      let adjustmentTotal = 0n;
      const adjustments = new Map<MemberId, bigint>();
      for (const [member, adjustment] of Object.entries(input.params.adjustments)) {
        requireParticipant(member, participants);
        adjustments.set(member, adjustment);
        adjustmentTotal += adjustment;
      }
      const residual = input.amount - adjustmentTotal;
      const shares = splitEqually(residual, participants, input.seed);
      for (const [member, adjustment] of adjustments) {
        shares.set(member, (shares.get(member) ?? 0n) + adjustment);
      }
      return shares;
    }

    case 'itemized':
      return splitItemized(input.amount, input.params, participants, input.seed);
  }
}

/**
 * Equal split with the remainder rule. Handles a negative total (used by the
 * adjustment residual) by rotating negative units the same way.
 */
export function splitEqually(
  amount: bigint,
  participants: readonly MemberId[],
  seed: string,
): ShareMap {
  const order = stableOrder(participants);
  const count = BigInt(order.length);
  const base = amount / count; // bigint division truncates toward zero
  const shares = new Map<MemberId, bigint>();
  for (const member of order) shares.set(member, base);
  distributeRemainder(shares, amount - base * count, order, rotationOffset(seed, order.length));
  return shares;
}

function splitItemized(
  amount: bigint,
  params: ItemizedParams,
  participants: readonly MemberId[],
  seed: string,
): ShareMap {
  if (params.items.length === 0) {
    throw new SplitError(SplitErrorCode.InvalidItem, 'An itemized split needs at least one line item');
  }

  const subtotals = new Map<MemberId, bigint>();
  for (const member of participants) subtotals.set(member, 0n);

  let itemsTotal = 0n;
  params.items.forEach((item, index) => {
    if (item.total < 0n) {
      throw new SplitError(SplitErrorCode.InvalidItem, `Line ${index} has a negative total`);
    }
    const claimers = params.claims[index] ?? [];
    if (claimers.length === 0) {
      // ADR-008: unclaimed items block finalization — the UI must chase the
      // last person before the expense can be created.
      throw new SplitError(
        SplitErrorCode.UnclaimedItem,
        `Line ${index} ("${item.label ?? ''}") is unclaimed`,
      );
    }
    for (const claimer of claimers) requireParticipant(claimer, participants);

    const lineShares = splitEqually(item.total, claimers, `${seed}:item:${index}`);
    for (const [member, share] of lineShares) {
      subtotals.set(member, (subtotals.get(member) ?? 0n) + share);
    }
    itemsTotal += item.total;
  });

  const extras =
    (params.taxes ?? 0n) +
    (params.serviceCharge ?? 0n) +
    (params.tip ?? 0n) -
    (params.discounts ?? 0n);

  if (itemsTotal + extras !== amount) {
    throw new SplitError(
      SplitErrorCode.ItemizedTotalMismatch,
      `Items (${itemsTotal}) plus tax/tip/discounts (${extras}) is ${itemsTotal + extras}, but the expense total is ${amount}`,
    );
  }

  const shares = new Map(subtotals);
  if (extras !== 0n) {
    // Prorate extras by each member's item subtotal. If nobody has a subtotal
    // (a bill of only tax, e.g. a service-charge-only correction) fall back to
    // an equal split so the money still lands somewhere deterministic.
    const anySubtotal = [...subtotals.values()].some((value) => value > 0n);
    const prorated = anySubtotal
      ? distributeProportionally(extras, subtotals, `${seed}:extras`)
      : splitEqually(extras, participants, `${seed}:extras`);
    for (const [member, share] of prorated) {
      shares.set(member, (shares.get(member) ?? 0n) + share);
    }
  }
  return shares;
}

function validateParticipants(participants: readonly MemberId[]): MemberId[] {
  if (participants.length === 0) {
    throw new SplitError(SplitErrorCode.EmptyParticipants, 'An expense needs at least one participant');
  }
  const unique = new Set(participants);
  if (unique.size !== participants.length) {
    throw new SplitError(SplitErrorCode.DuplicateParticipant, 'Participants must be unique');
  }
  return [...participants];
}

function requireParticipant(member: MemberId, participants: readonly MemberId[]): void {
  if (!participants.includes(member)) {
    throw new SplitError(
      SplitErrorCode.UnknownMember,
      `"${member}" is not a participant in this expense`,
    );
  }
}

export function sumShares(shares: ShareMap): bigint {
  let total = 0n;
  for (const share of shares.values()) total += share;
  return total;
}

function assertSumsTo(shares: ShareMap, amount: bigint): void {
  const total = sumShares(shares);
  if (total !== amount) {
    throw new SplitError(
      SplitErrorCode.ShareMismatch,
      `Computed shares sum to ${total}, expected ${amount}. This is a bug in computeShares.`,
    );
  }
}
