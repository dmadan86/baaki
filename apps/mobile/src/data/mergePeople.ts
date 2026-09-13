/**
 * The pure logic behind merging same-person ghosts on the Friends screen.
 *
 * Kept free of React and the network so it can be reasoned about and tested on
 * its own: who may be merged, which member ids a selection resolves to, the
 * name to pre-fill, and how a server error becomes something a person can read.
 * The screen wires these to state and the `mergeGhosts` RPC; the rules live
 * here.
 *
 * The candidates are built from group membership, not from balances. A guest is
 * a person you can merge whether or not they currently owe you anything, and a
 * guest you gave a phone number to when you invited them is exactly the one you
 * are most likely to be merging *into* — so the balance list, which drops
 * anybody square with you, is the wrong roster to pick from.
 */
import { sameAddress } from '@/lib/contactMatch';

import type { PersonBalanceRow } from './api';
import { isGhost } from './types';

/**
 * Only a ghost — someone with no Waves account — can be merged. A real person is
 * already one identity across every group by their profile id, so folding them
 * under a made-up name would be a lie, not a merge.
 */
export function isMergeable(row: Pick<PersonBalanceRow, 'is_ghost'>): boolean {
  return row.is_ghost;
}

/** One group membership, as much of it as the candidate list reads. */
export interface MergeableMember {
  /** The `group_members` row id — per-group, and what the merge RPC takes. */
  readonly id: string;
  readonly group_id: string;
  /** Their profile id, or null for a ghost. Only ghosts are offered. */
  readonly profile_id: string | null;
  readonly ghost_name: string | null;
  /** Set once they have left; somebody gone is not somebody you merge. */
  readonly left_at: string | null;
  /** Where their invite was written — the one address this app records. */
  readonly invite_email?: string | null;
  /** E.164. */
  readonly invite_phone?: string | null;
  /**
   * True while this membership exists only in the local queue (ADR-005) — added
   * offline, or still on its way up. The merge RPC looks the row up in
   * `group_members` and refuses the *whole* merge if it is not there yet, so a
   * pending person can be shown but must never be picked.
   */
  readonly pending?: boolean;
}

/** A merge the viewer has already recorded against a membership (A38). */
export interface RecordedMerge {
  readonly person_id: string;
  readonly display_name: string;
}

/**
 * One person the merge screen can offer, with whatever makes them *someone*
 * already: an address you wrote down, and the groups they turn up in.
 *
 * `member_ids` is every membership folded under this person, not one of them —
 * a person you merged before is several rows in several groups, and the merge
 * has to carry all of them.
 */
export interface MergeCandidate {
  /** COALESCE(merge person_id, member_id) — a ghost's key (see `personKeyOf`). */
  readonly person_key: string;
  /** Every group membership behind this person. */
  readonly member_ids: readonly string[];
  /** The groups they appear in — the invite step's list, and their reach. */
  readonly group_ids: readonly string[];
  readonly display_name: string;
  /** The number recorded against them when they were invited, if any. */
  readonly phone: string | null;
  /** The address recorded against them when they were invited, if any. */
  readonly email: string | null;
  /**
   * Any one of their memberships is still only in the local queue.
   *
   * The server checks *every* member id it is handed and refuses the whole merge
   * if one of them is not a row it can see, so this is deliberately "any", not
   * "all": one unsynced membership is enough to make the merge fail, and it
   * would fail saying this person is not a guest you share a group with —
   * untrue, and about somebody the screen itself just listed. So they are shown
   * (hiding a person you added a minute ago is its own lie) and cannot be
   * picked until the queue drains.
   */
  readonly pending: boolean;
}

/** Everything {@link defaultMergeName} weighs — a candidate, or just a name. */
export interface NamedPerson {
  readonly display_name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  /** How many groups they turn up in. Absent reads as "unknown", never as reach. */
  readonly group_count?: number;
}

/**
 * Whether we hold an address for this person — the strongest thing short of an
 * account that says "this is a particular human", and the reason their name
 * should be the one the merge keeps.
 */
export function hasContact(person: Pick<NamedPerson, 'phone' | 'email'>): boolean {
  return Boolean(person.phone?.trim() || person.email?.trim());
}

/**
 * Build the mergeable people out of raw memberships.
 *
 * Group memberships in, one row per human out: ghosts only (see
 * {@link isMergeable}), people who have left dropped, and everything the viewer
 * has already merged folded under the one person key so a second merge extends
 * that person rather than splitting them.
 *
 * Ordered identified-first, then by name: the person you have details for is
 * the one you are merging a stray name *into*, so they lead the list.
 */
export function buildMergeCandidates(
  members: readonly MergeableMember[],
  merges: ReadonlyMap<string, RecordedMerge>,
  someoneLabel = 'Someone',
): MergeCandidate[] {
  interface Draft {
    person_key: string;
    member_ids: string[];
    group_ids: string[];
    /** The name the viewer gave the merge — it outranks any single ghost name. */
    mergedName: string;
    ghostName: string;
    phone: string | null;
    email: string | null;
    pending: boolean;
  }

  const byKey = new Map<string, Draft>();
  for (const member of members) {
    if (member.left_at !== null) continue;
    if (!isMergeable({ is_ghost: isGhost(member) })) continue;

    const merge = merges.get(member.id) ?? null;
    // A ghost merge the viewer recorded is their own proof that two rows are one
    // human; failing that a ghost stays keyed to its own membership.
    //
    // Nothing else may enter this expression. It has to spell identity exactly
    // as `personKeyOf` and the SQL's COALESCE(profile_id, person_id, member id)
    // do, because the key travels: Friends, the group ledger and the simplify
    // sheet all push it into `friends/person/[key]`, which hands it straight to
    // two server RPCs. A locally-invented key opens that screen empty. A shared
    // invite number is worth *suggesting* a merge over — see
    // {@link suggestMergeCluster} — but it may not decide who somebody is.
    const key = merge?.person_id ?? member.id;
    let draft = byKey.get(key);
    if (!draft) {
      draft = {
        person_key: key,
        member_ids: [],
        group_ids: [],
        mergedName: '',
        ghostName: '',
        phone: null,
        email: null,
        pending: false,
      };
      byKey.set(key, draft);
    }
    if (member.pending === true) draft.pending = true;
    if (!draft.member_ids.includes(member.id)) draft.member_ids.push(member.id);
    if (!draft.group_ids.includes(member.group_id)) draft.group_ids.push(member.group_id);

    const merged = merge?.display_name?.trim() ?? '';
    if (merged && !draft.mergedName) draft.mergedName = merged;
    const ghost = member.ghost_name?.trim() ?? '';
    if (ghost && !draft.ghostName) draft.ghostName = ghost;

    const phone = member.invite_phone?.trim() ?? '';
    if (phone && !draft.phone) draft.phone = phone;
    const email = member.invite_email?.trim() ?? '';
    if (email && !draft.email) draft.email = email;
  }

  const candidates: MergeCandidate[] = [...byKey.values()].map((draft) => ({
    person_key: draft.person_key,
    member_ids: draft.member_ids,
    group_ids: draft.group_ids,
    display_name: draft.mergedName || draft.ghostName || someoneLabel,
    phone: draft.phone,
    email: draft.email,
    pending: draft.pending,
  }));

  candidates.sort((a, b) => {
    // Anybody who cannot be picked yet sinks below everybody who can.
    const byReady = Number(a.pending) - Number(b.pending);
    if (byReady !== 0) return byReady;
    const byIdentity = Number(hasContact(b)) - Number(hasContact(a));
    if (byIdentity !== 0) return byIdentity;
    const byReach = b.group_ids.length - a.group_ids.length;
    if (byReach !== 0) return byReach;
    return a.display_name.localeCompare(b.display_name);
  });
  return candidates;
}

/**
 * The people to pre-tick: a guest and everybody carrying the same invite
 * address. A suggestion — never an identity.
 *
 * Two ghosts you wrote the same number against are almost certainly one human,
 * and saying so is the whole of what the original report asked for. What this
 * deliberately does *not* do is fold them into one person behind the user's
 * back. They stay two candidates, both ticked, both named in the confirmation
 * dialog, and either can be unticked — so the merge that gets written is one the
 * user asserted, exactly as it is for a name match (see {@link contactNameMatch}
 * — a heuristic may propose an identity, it may not decide one).
 *
 * It is a star around the first guest with a partner, not a transitive closure:
 * `samePhone` allows a shorter number to be the tail of a longer one, so "same
 * address" is not an equivalence relation — A can match both B and C while B and
 * C match nothing. Closing over that would invent a group nobody's data
 * supports. One seed and its direct matches is a claim we can actually stand
 * behind, and the user sees every member of it before anything is written.
 *
 * People still waiting to sync are left out: they cannot be picked at all.
 */
export function suggestMergeCluster(candidates: readonly MergeCandidate[]): MergeCandidate[] {
  const usable = candidates.filter((row) => !row.pending && hasContact(row));
  for (const seed of usable) {
    const partners = usable.filter(
      (other) => other.person_key !== seed.person_key && sameAddress(seed, other),
    );
    if (partners.length > 0) return [seed, ...partners];
  }
  return [];
}

/** What a picked device contact's name resolves to on the mergeable roster. */
export interface ContactNameMatch {
  /** The one guest that name unambiguously fits, or null. */
  readonly pick: MergeCandidate | null;
  /** The name fits several different people, so it fits nobody in particular. */
  readonly ambiguous: boolean;
}
/**
 * Who a picked contact's name points at.
 *
 * Ticking somebody because a device contact carries their name is the whole
 * recognition this screen runs on — but only when the name points at exactly one
 * person. It used to tick *every* guest wearing that name, which was survivable
 * while the roster was only people carrying a live debt; over every guest in
 * every group, one contact called "Alex" could sweep three different humans into
 * a merge that cannot be undone. So several matches tick nobody and the screen
 * says why: a name shared by three people is not evidence about any of them.
 *
 * Anybody still waiting to sync is excluded outright — they cannot be picked by
 * hand either, so a contact must not pick them by the side door.
 */
export function contactNameMatch(
  guests: readonly MergeCandidate[],
  contactName: string,
): ContactNameMatch {
  const needle = contactName.trim().toLowerCase();
  if (!needle) return { pick: null, ambiguous: false };
  const matches = guests.filter(
    (row) => !row.pending && row.display_name.trim().toLowerCase() === needle,
  );
  return {
    pick: matches.length === 1 ? (matches[0] ?? null) : null,
    ambiguous: matches.length > 1,
  };
}

/**
 * The distinct group-member ids behind a set of picked people.
 *
 * A person can be several memberships — one per group, and more still once a
 * previous merge has folded them — and a merge acts on members, so every one of
 * them has to travel. De-duplicating here means a person picked twice (or a
 * membership two picked people share) counts once, not twice.
 */
export function memberIdsForMerge(rows: readonly Pick<MergeCandidate, 'member_ids'>[]): string[] {
  return [...new Set(rows.flatMap((row) => [...row.member_ids]))];
}

/**
 * A merge needs at least two distinct *people*; one person is nothing to merge.
 *
 * Counted by person key, not by membership — somebody already merged across
 * three groups is three member ids and still only one person, and offering to
 * "merge" them with themselves would write nothing and mean nothing.
 */
export function canMerge(rows: readonly Pick<MergeCandidate, 'person_key'>[]): boolean {
  return new Set(rows.map((row) => row.person_key)).size >= 2;
}

/** The most common name in a set, ties broken by the order they were picked. */
function mostCommonName(rows: readonly NamedPerson[]): string {
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

/**
 * The name to pre-fill on the merge screen — the identified person's, wherever
 * one of the picked people is identified.
 *
 * Merging is nearly always a stray "person1" being folded into somebody you
 * actually know, so the surviving name should be the known one rather than
 * whichever spelling happened to turn up most often. In order:
 *
 * 1. Somebody with an address you recorded — a phone number or an email is the
 *    nearest thing to proof of a particular human that a guest can carry.
 * 2. Failing that, whoever turns up in the most groups, when that is more than
 *    one: a name you have written down in three places is a real person's, and
 *    a name in exactly one group tells you nothing the others don't.
 * 3. Failing both, the most common name among the picks — the old rule, kept
 *    for the case where nothing distinguishes anybody.
 *
 * Within each tier the most common name wins, ties broken by pick order. Blank
 * and whitespace-only names are ignored throughout; if nothing usable remains
 * it returns an empty string and the screen keeps the confirm button disabled
 * until a name is typed. The screen only ever *pre-fills* with this — the field
 * stays editable, so a wrong guess costs one tap to fix.
 */
export function defaultMergeName(rows: readonly NamedPerson[]): string {
  // Each tier falls through on a blank winner rather than returning it: an
  // identified person whose name is empty says nothing, and swallowing the
  // lower tiers to hand back '' would leave the field blank when a perfectly
  // good name was sitting one tier down.
  const byContact = mostCommonName(rows.filter((row) => hasContact(row)));
  if (byContact) return byContact;

  const reach = rows.reduce((most, row) => Math.max(most, row.group_count ?? 0), 0);
  if (reach > 1) {
    const byReach = mostCommonName(rows.filter((row) => (row.group_count ?? 0) === reach));
    if (byReach) return byReach;
  }

  return mostCommonName(rows);
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
 * behind on the merge function — is not one of those named outcomes and falls
 * back to the generic line. The raw error is deliberately NOT shown: a Postgres
 * or schema message is developer text, and putting it in front of a person both
 * leaks internals and reads as noise. Named outcomes above carry the meaning.
 */
export function mergeErrorMessage(error: unknown, t: MergeErrorStrings): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('TOO_FEW')) return t.errorTooFew;
  if (message.includes('NOT_MERGEABLE')) return t.errorNotMergeable;
  if (message.includes('NAME_REQUIRED')) return t.errorNameRequired;
  if (message.includes('NOT_SIGNED_IN')) return t.errorNotSignedIn;
  return t.errorGeneric;
}
