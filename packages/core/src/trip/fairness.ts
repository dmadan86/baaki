/**
 * Fairness: is one person carrying the trip?
 *
 * Two questions travellers actually ask, both answered from the ledger the
 * group already has, and both obeying the same rule the rest of the trip maths
 * obeys — **currencies never mix (ADR-004).** Rupees fronted and euros fronted
 * are two different sacrifices; there is no rate that makes "who paid most"
 * comparable across them, so every figure here is per currency and the screen
 * shows each on its own line.
 *
 *   * **Who paid too much** — "Ananya has paid 70% of the trip." A share of what
 *     the group *fronted*, not what anybody owes. Flagged only when it runs past
 *     a multiple of an even share, so a two-person trip does not nag at 55%.
 *   * **Who should pay next** — the person whose net (fronted minus their share
 *     of consumption) is furthest negative: they have consumed more of the trip
 *     than they have laid out, so handing them the next bill nudges the group
 *     back toward even without anyone settling up mid-trip.
 *
 * Nothing here is money that moves. It never proposes a transfer — `simplify`
 * does that. This only surfaces a lopsidedness a human then acts on.
 *
 * Minor units and bigint throughout; the only float is a display ratio, taken
 * with scaled-integer division so it is exact for amounts a double would round.
 */

/** One member's standing in one currency, already reduced from the ledger. */
export interface MemberContribution {
  readonly member: string;
  readonly currency: string;
  /** What they fronted at the counter, in minor units. */
  readonly paidMinor: bigint;
  /** Their share of what was consumed, in minor units (the split's verdict). */
  readonly owedMinor: bigint;
}

export interface MemberFairness {
  readonly member: string;
  readonly paidMinor: bigint;
  readonly owedMinor: bigint;
  /** paid − owed. Positive: fronted more than their share (a creditor). */
  readonly netMinor: bigint;
  /** paid / totalPaid, clamped to [0, 1]. Zero when nobody has paid yet. */
  readonly paidRatio: number;
}

export interface Overpayer {
  readonly member: string;
  readonly paidRatio: number;
}

export interface CurrencyFairness {
  readonly currency: string;
  readonly totalPaidMinor: bigint;
  /** Members sorted by paidRatio, largest first; ties broken by member id. */
  readonly members: readonly MemberFairness[];
  /** The one carrying a disproportionate share of the fronting, or null. */
  readonly overpayer: Overpayer | null;
  /** Who should front the next bill to even things out, or null when balanced. */
  readonly nextPayer: string | null;
}

export interface FairnessOptions {
  /**
   * How many times an even share a member's paid-share must exceed before they
   * count as an overpayer. 1.5 means: in a four-person trip (even share 25%),
   * the flag trips at 37.5%; in a two-person trip (even share 50%), at 75%.
   */
  readonly overpayerMultiple?: number;
}

const DEFAULT_OVERPAYER_MULTIPLE = 1.5;

/** A paid/total ratio in [0, 1], exact via scaled-integer division. */
function ratioOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  if (part <= 0n) return 0;
  if (part >= total) return 1;
  return Number((part * 10_000n) / total) / 10_000;
}

/**
 * Fairness, one block per currency present in the contributions.
 *
 * A currency appears if anyone paid or owed anything in it. Members with no
 * activity in a currency are simply absent from that block — nobody's standing
 * is invented as a zero.
 */
export function fairness(
  contributions: readonly MemberContribution[],
  options: FairnessOptions = {},
): CurrencyFairness[] {
  const multiple = options.overpayerMultiple ?? DEFAULT_OVERPAYER_MULTIPLE;

  const byCurrency = new Map<string, Map<string, { paid: bigint; owed: bigint }>>();
  for (const c of contributions) {
    const currency = c.currency.toUpperCase();
    const members = byCurrency.get(currency) ?? new Map();
    const row = members.get(c.member) ?? { paid: 0n, owed: 0n };
    row.paid += c.paidMinor;
    row.owed += c.owedMinor;
    members.set(c.member, row);
    byCurrency.set(currency, members);
  }

  const out: CurrencyFairness[] = [];
  for (const [currency, members] of byCurrency) {
    let totalPaid = 0n;
    for (const { paid } of members.values()) totalPaid += paid;

    const rows: MemberFairness[] = [...members.entries()]
      .map(([member, { paid, owed }]) => ({
        member,
        paidMinor: paid,
        owedMinor: owed,
        netMinor: paid - owed,
        paidRatio: ratioOf(paid, totalPaid),
      }))
      .sort((a, b) => b.paidRatio - a.paidRatio || a.member.localeCompare(b.member));

    // The fair share of the *fronting* is 1/n; the flag trips past a multiple of
    // it. n counts members who took any part in this currency.
    const evenShare = rows.length > 0 ? 1 / rows.length : 0;
    const threshold = evenShare * multiple;
    const leader = rows[0];
    const overpayer =
      leader && totalPaid > 0n && leader.paidRatio >= threshold
        ? { member: leader.member, paidRatio: leader.paidRatio }
        : null;

    // Who should pay next: the furthest-negative net. Null when nobody has
    // underpaid (everyone is square or a creditor) — there is no one to nudge.
    let nextPayer: string | null = null;
    let worst = 0n;
    for (const row of rows) {
      if (row.netMinor < worst || (row.netMinor === worst && nextPayer === null && row.netMinor < 0n)) {
        worst = row.netMinor;
        nextPayer = row.member;
      }
    }

    out.push({ currency, totalPaidMinor: totalPaid, members: rows, overpayer, nextPayer });
  }

  return out.sort((a, b) => a.currency.localeCompare(b.currency));
}
