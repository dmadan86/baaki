/**
 * Fairness pins the two ways the maths could mislead a group: mixing currencies
 * into one "who paid most", and nagging a small group where someone paying half
 * is simply their turn.
 */

import { describe, expect, it } from 'vitest';

import { fairness, type MemberContribution } from '../src/trip/fairness';

describe('fairness', () => {
  it('keeps each currency on its own, never adding rupees to euros', () => {
    const contributions: MemberContribution[] = [
      { member: 'ravi', currency: 'INR', paidMinor: 7000n, owedMinor: 3000n },
      { member: 'asha', currency: 'INR', paidMinor: 3000n, owedMinor: 3000n },
      { member: 'neha', currency: 'INR', paidMinor: 0n, owedMinor: 4000n },
      { member: 'ravi', currency: 'EUR', paidMinor: 9000n, owedMinor: 3000n },
    ];
    const result = fairness(contributions);
    const inr = result.find((r) => r.currency === 'INR');
    const eur = result.find((r) => r.currency === 'EUR');
    expect(inr?.totalPaidMinor).toBe(10000n);
    expect(eur?.totalPaidMinor).toBe(9000n); // ravi's rupees never inflate his euros
  });

  it('names the overpayer only past a multiple of an even share', () => {
    // Four members, even share 25%; ravi fronted 70% → flagged at the 37.5% line.
    const four: MemberContribution[] = [
      { member: 'ravi', currency: 'INR', paidMinor: 7000n, owedMinor: 2500n },
      { member: 'a', currency: 'INR', paidMinor: 1000n, owedMinor: 2500n },
      { member: 'b', currency: 'INR', paidMinor: 1000n, owedMinor: 2500n },
      { member: 'c', currency: 'INR', paidMinor: 1000n, owedMinor: 2500n },
    ];
    expect(fairness(four)[0]!.overpayer).toMatchObject({ member: 'ravi' });

    // Two members, even share 50%; a 60/40 split is not a flag (threshold 75%).
    const two: MemberContribution[] = [
      { member: 'ravi', currency: 'INR', paidMinor: 6000n, owedMinor: 5000n },
      { member: 'asha', currency: 'INR', paidMinor: 4000n, owedMinor: 5000n },
    ];
    expect(fairness(two)[0]!.overpayer).toBeNull();
  });

  it('picks the furthest-negative net as who pays next, and null when square', () => {
    const lopsided: MemberContribution[] = [
      { member: 'ravi', currency: 'INR', paidMinor: 9000n, owedMinor: 3000n },
      { member: 'asha', currency: 'INR', paidMinor: 0n, owedMinor: 3000n },
      { member: 'neha', currency: 'INR', paidMinor: 0n, owedMinor: 3000n },
    ];
    // asha and neha both owe 3000 net; tie breaks to the first by id.
    expect(fairness(lopsided)[0]!.nextPayer).toBe('asha');

    const square: MemberContribution[] = [
      { member: 'ravi', currency: 'INR', paidMinor: 3000n, owedMinor: 3000n },
      { member: 'asha', currency: 'INR', paidMinor: 3000n, owedMinor: 3000n },
    ];
    expect(fairness(square)[0]!.nextPayer).toBeNull();
  });

  it('reports a zero paid-ratio when nobody has fronted anything yet', () => {
    const unpaid: MemberContribution[] = [
      { member: 'ravi', currency: 'INR', paidMinor: 0n, owedMinor: 2000n },
      { member: 'asha', currency: 'INR', paidMinor: 0n, owedMinor: 2000n },
    ];
    const block = fairness(unpaid)[0]!;
    expect(block.totalPaidMinor).toBe(0n);
    expect(block.members.every((m) => m.paidRatio === 0)).toBe(true);
    expect(block.overpayer).toBeNull();
  });
});
