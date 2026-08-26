/**
 * The remainder rule (ADR-009). Integer division leaves 0..n-1 minor units
 * over; they are handed out one at a time, in stable member order, starting at
 * an offset derived from the expense id. Same inputs → same output, always;
 * different expenses → a different person absorbs the extra paisa.
 */

import type { MemberId } from './types';

/** FNV-1a 32-bit. Chosen for being tiny, stable, and identical in TS and SQL. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // hash *= 16777619, kept in uint32 without overflowing the float53 mantissa
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Members sorted by id — the stable order every device agrees on. */
export function stableOrder(members: readonly MemberId[]): MemberId[] {
  return [...members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function rotationOffset(seed: string, count: number): number {
  if (count <= 0) return 0;
  return fnv1a32(seed) % count;
}

/**
 * Hand out `remainder` minor units (may be negative) across `order`, starting at
 * `offset`. Normal split callers pass a remainder smaller than `order.length`,
 * but this helper is exported for tests and SQL parity, so large direct inputs
 * are handled in O(n) by applying full rounds before the rotated leftovers.
 */
export function distributeRemainder(
  shares: Map<MemberId, bigint>,
  remainder: bigint,
  order: readonly MemberId[],
  offset: number,
): void {
  if (remainder === 0n || order.length === 0) return;
  const sign = remainder > 0n ? 1n : -1n;
  const magnitude = remainder > 0n ? remainder : -remainder;
  const count = BigInt(order.length);
  const fullRounds = magnitude / count;
  const leftovers = Number(magnitude % count);

  if (fullRounds !== 0n) {
    for (const member of order) {
      shares.set(member, (shares.get(member) ?? 0n) + sign * fullRounds);
    }
  }

  let index = offset % order.length;
  for (let left = 0; left < leftovers; left += 1) {
    const member = order[index] as MemberId;
    shares.set(member, (shares.get(member) ?? 0n) + sign);
    index = (index + 1) % order.length;
  }
}

/**
 * Split `amount` proportionally to `weights` (bigint, non-negative), giving
 * every member the floor of their exact share and rotating the leftover minor
 * units among members with a positive weight.
 */
export function distributeProportionally(
  amount: bigint,
  weights: ReadonlyMap<MemberId, bigint>,
  seed: string,
): Map<MemberId, bigint> {
  const shares = new Map<MemberId, bigint>();
  let totalWeight = 0n;
  for (const weight of weights.values()) totalWeight += weight;

  const order = stableOrder([...weights.keys()]);
  if (totalWeight === 0n) {
    for (const member of order) shares.set(member, 0n);
    return shares;
  }

  let allocated = 0n;
  for (const member of order) {
    const weight = weights.get(member) ?? 0n;
    // Floor toward negative infinity is wrong for negative totals; we floor the
    // magnitude and let the remainder pass carry the sign.
    const exact = amount * weight;
    const share = exact / totalWeight;
    shares.set(member, share);
    allocated += share;
  }

  const eligible = order.filter((member) => (weights.get(member) ?? 0n) > 0n);
  distributeRemainder(shares, amount - allocated, eligible, rotationOffset(seed, eligible.length));
  return shares;
}
