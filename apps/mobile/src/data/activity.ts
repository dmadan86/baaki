/**
 * Turning an activity row into a sentence.
 *
 * This lives outside both feed screens because there are two of them — the
 * cross-group tab and the tab on a group — and a feed that words the same
 * event two different ways is a feed people stop trusting. It was already
 * wrong once: the group tab rendered `verb` and `object_type` raw, so an
 * offline-sync conflict read "Ravi superseded expense_version", which names
 * a table rather than telling the person their edit was replaced.
 *
 * The actor is the point of the whole thing. On a shared ledger "Dinner was
 * edited" answers nothing — "Ravi edited Dinner" does. Written from the
 * reader's point of view, so their own actions read as "You".
 */

import { actorName, type ActivityRow } from './types';

export function describeActivity(entry: ActivityRow, myProfileId: string | null): string {
  const { payload } = entry;
  const description = typeof payload.description === 'string' ? payload.description : null;
  const who = actorName(entry.actor, myProfileId);

  switch (entry.verb) {
    case 'added':
      return `${who} added ${description ?? 'an expense'}`;
    case 'edited':
      return `${who} edited ${description ?? 'an expense'}`;
    case 'deleted':
      return `${who} deleted ${description ?? 'an expense'}`;
    case 'restored':
      return `${who} restored ${description ?? 'an expense'}`;
    case 'superseded': {
      // The conflict entry from offline sync (ADR-005). Both edits survive in
      // expense_versions; this row exists so the person whose edit lost can
      // find it and put it back. Saying "superseded expense" told them nothing.
      const replaced =
        typeof payload.supersededDescription === 'string' ? payload.supersededDescription : null;
      return replaced
        ? `${who}'s edit replaced an earlier one — "${replaced}" is still in the history`
        : `${who}'s edit replaced an earlier one`;
    }
    case 'settled':
      return `${who} recorded a settlement`;
    case 'confirmed':
      return `${who} confirmed a settlement`;
    case 'joined':
      return `${who} joined`;
    case 'created':
      return `${who} created the group`;
    default:
      // An unknown verb is a row written by a newer build than this one. Say
      // what is known rather than dropping it — a feed with holes in it is
      // worse than a feed with one clumsy line.
      return `${who} ${entry.verb} ${entry.object_type}`;
  }
}

export function verbEmoji(verb: string): string {
  switch (verb) {
    case 'added':
      return '🧾';
    case 'edited':
    case 'superseded':
      return '✏️';
    case 'deleted':
      return '🗑️';
    case 'restored':
      return '↩️';
    case 'settled':
      return '💸';
    case 'confirmed':
      return '✅';
    case 'joined':
      return '👋';
    case 'created':
      return '✨';
    default:
      return '•';
  }
}
