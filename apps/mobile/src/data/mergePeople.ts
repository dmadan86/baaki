/**
 * The pure logic behind merging same-person ghosts on the Friends screen.
 *
 * Kept free of React and the network so it can be reasoned about and tested on
 * its own: what may be merged, which member ids a selection resolves to, the
 * name to pre-fill, and how a server error becomes something a person can read.
 * The screen wires these to state and the `mergeGhosts` RPC; the rules live
 * here.
 */
import type { PersonBalanceRow } from './api';

/**
 * Only a ghost — someone with no Baaki account — can be merged. A real person is
 * already one identity across every group by their profile id, so folding them
 * under a made-up name would be a lie, not a merge.
 */
export function isMergeable(row: Pick<PersonBalanceRow, 'is_ghost'>): boolean {
  return row.is_ghost;
}

/**
 * The distinct group-member ids behind a set of picked people.
 *
 * A ghost can surface as several rows — one per currency they are unsettled in —
 * but is a single member, and a merge acts on members. De-duplicating here means
 * picking "person1" who owes both ₹ and € counts once, not twice.
 */
export function memberIdsForMerge(rows: readonly Pick<PersonBalanceRow, 'member_id'>[]): string[] {
  return [...new Set(rows.map((row) => row.member_id))];
}

/** A merge needs at least two distinct people; one person is nothing to merge. */
export function canMerge(rows: readonly Pick<PersonBalanceRow, 'member_id'>[]): boolean {
  return memberIdsForMerge(rows).length >= 2;
}

/**
 * The name to pre-fill on the merge screen: the most common display name among
 * the picked people, ties broken by the order they were picked. Blank or
 * whitespace-only names are ignored; if nothing usable remains it returns an
 * empty string, and the screen keeps the confirm button disabled until a name
 * is typed.
 */
export function defaultMergeName(rows: readonly Pick<PersonBalanceRow, 'display_name'>[]): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const row of rows) {
    const name = row.display_name?.trim();
    if (!name) continue;
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const name of order) {
    const count = counts.get(name) ?? 0;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** The strings {@link mergeErrorMessage} needs — a subset of the i18n block. */
export interface MergeErrorStrings {
  errorTooFew: string;
  errorNotMergeable: string;
  errorNameRequired: string;
  errorNotSignedIn: string;
  errorGeneric: string;
}

/**
 * Map a {@link mergeGhosts} failure to a human message.
 *
 * The RPC raises with a stable prefix (`TOO_FEW`, `NOT_MERGEABLE`,
 * `NAME_REQUIRED`, `NOT_SIGNED_IN`) ahead of its developer text; match on that
 * so a named outcome reads as plain language.
 *
 * Anything unrecognised — a dropped connection, or a server that is missing or
 * behind on the merge function — is not one of those outcomes, and a bare "try
 * again" hides what actually went wrong. Those fall back to the generic line
 * with the raw message appended, so a failure in the field can be read off the
 * screen rather than guessed at.
 */
export function mergeErrorMessage(error: unknown, t: MergeErrorStrings): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('TOO_FEW')) return t.errorTooFew;
  if (message.includes('NOT_MERGEABLE')) return t.errorNotMergeable;
  if (message.includes('NAME_REQUIRED')) return t.errorNameRequired;
  if (message.includes('NOT_SIGNED_IN')) return t.errorNotSignedIn;
  const detail = message.trim();
  return detail ? `${t.errorGeneric} (${detail})` : t.errorGeneric;
}
