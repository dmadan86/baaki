/**
 * Travel split presets: the four ways a trip divides a bill that a plain
 * equal/exact split makes tedious to enter by hand.
 *
 * None of these is a new kind of money. Each is a *builder* that returns the
 * split params the ledger already understands — `shares`, `adjustment`,
 * `equal`, `exact` — so every travel split flows through the one audited,
 * property-tested `computeShares` and the server recomputes it with no special
 * case (TDR §3.1, §4). What the ledger stores is canonical params; "this was a
 * room split" is a convenience at entry time, not a new row type.
 *
 *   * **By nights / presence** → `shares` weighted by how many nights each
 *     person stayed (a five-night hotel where two joined for two nights).
 *   * **Car rental** → the base splits equally among the people sharing the
 *     car, fuel and tolls ride on top as per-person `adjustment`s, and the
 *     driver can be left out entirely.
 *   * **This ride only** → an `equal` split across just the people who were in
 *     the taxi, not the whole group.
 *   * **My treat** → an `exact` split where the host's share is the whole bill
 *     and everyone else owes nothing: it shows in the history, it moves no debt.
 *
 * Minor units and bigint for every amount; weights are counts (nights, people)
 * and stay integers.
 */

import type { AdjustmentParams, EqualParams, ExactParams, MemberId, SharesParams } from './types';
import { SplitError, SplitErrorCode } from './types';

/**
 * Split by a per-member count — nights stayed, days present, seats taken.
 * A member with a zero (or absent) count carries no weight and pays nothing;
 * at least one positive count is required, the same rule `shares` enforces.
 *
 * The counts are *weights*, not money: the expense total is divided in their
 * proportion by `computeShares`, remainder and all, so it stays exact.
 */
export function splitByUnits(unitsByMember: Readonly<Record<MemberId, number>>): SharesParams {
  const weights: Record<MemberId, number> = {};
  let positive = false;
  for (const [member, units] of Object.entries(unitsByMember)) {
    if (!Number.isInteger(units) || units < 0) {
      throw new SplitError(
        SplitErrorCode.InvalidWeight,
        `Units must be non-negative integers, got ${units} for ${member}`,
      );
    }
    if (units > 0) positive = true;
    weights[member] = units;
  }
  if (!positive) {
    throw new SplitError(
      SplitErrorCode.NoPositiveWeight,
      'A by-nights split needs at least one member with a positive count',
    );
  }
  return { kind: 'shares', weights };
}

export interface CarRentalInput {
  /** Everyone sharing the car, before the driver is (optionally) excused. */
  readonly participants: readonly MemberId[];
  /** Per-member fuel/toll amounts in minor units, added on top of the base. */
  readonly extrasByMember?: Readonly<Record<MemberId, bigint>>;
  /** A driver who pays nothing — left out of the base split entirely. */
  readonly exemptDriver?: MemberId;
}

export interface CarRentalSplit {
  readonly params: AdjustmentParams;
  /** The people the base is split across — the driver removed if exempt. */
  readonly participants: MemberId[];
}

/**
 * Base rental split equally among the riders, fuel and tolls added per person.
 *
 * The base is the residual an `adjustment` split divides equally after the
 * per-member extras are taken out, so `Σ shares` is still the expense total.
 * Excusing the driver simply drops them from the participant set: they take no
 * base and, unless they are also given an extra, owe nothing.
 */
export function carRentalSplit(input: CarRentalInput): CarRentalSplit {
  const participants = input.participants.filter((member) => member !== input.exemptDriver);
  if (participants.length === 0) {
    throw new SplitError(
      SplitErrorCode.EmptyParticipants,
      'A car-rental split needs at least one rider paying the base',
    );
  }

  const adjustments: Record<MemberId, bigint> = {};
  for (const [member, amount] of Object.entries(input.extrasByMember ?? {})) {
    if (amount < 0n) {
      throw new SplitError(
        SplitErrorCode.InvalidItem,
        `A fuel/toll extra cannot be negative (${amount} for ${member})`,
      );
    }
    // An extra for the excused driver would put them back in the split; that is
    // a contradiction, so refuse it rather than silently re-including them.
    if (member === input.exemptDriver) {
      throw new SplitError(
        SplitErrorCode.UnknownMember,
        'The exempt driver cannot also carry a fuel/toll extra',
      );
    }
    adjustments[member] = amount;
  }

  return { params: { kind: 'adjustment', adjustments }, participants };
}

export interface RidersSplit {
  readonly params: EqualParams;
  readonly participants: MemberId[];
}

/**
 * This ride only: an equal split across just the people who were in it. A thin
 * convenience over an `equal` split with a hand-picked participant set — named
 * because "the airport taxi was only four of us" is a thing people say.
 */
export function ridersSplit(riders: readonly MemberId[]): RidersSplit {
  const participants = [...new Set(riders)];
  if (participants.length === 0) {
    throw new SplitError(SplitErrorCode.EmptyParticipants, 'A ride needs at least one rider');
  }
  return { params: { kind: 'equal' }, participants };
}

export interface TreatInput {
  /** The host — the one whose treat this is. Ends up owing the whole bill. */
  readonly host: MemberId;
  /** Everyone the treat covers, the host included. */
  readonly participants: readonly MemberId[];
  /** The bill, in minor units. */
  readonly amountMinor: bigint;
}

/**
 * My treat: the host's share is the entire bill, everyone else owes nothing.
 *
 * Modelled as an `exact` split so it is honest in the ledger — the expense is
 * real, it shows in the history and the spend charts, and it settles to no
 * debt because the only non-zero share belongs to the person who paid. The
 * guests appear with a zero share so the row set still lists who was there.
 */
export function treatSplit(input: TreatInput): ExactParams {
  if (input.amountMinor < 0n) {
    throw new SplitError(SplitErrorCode.NegativeTotal, 'A treat cannot be a negative amount');
  }
  if (!input.participants.includes(input.host)) {
    throw new SplitError(
      SplitErrorCode.UnknownMember,
      'The host of a treat must be one of its participants',
    );
  }
  const amounts: Record<MemberId, bigint> = {};
  for (const member of new Set(input.participants)) {
    amounts[member] = member === input.host ? input.amountMinor : 0n;
  }
  return { kind: 'exact', amounts };
}
