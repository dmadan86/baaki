/**
 * An activity row, worded from the reader's point of view.
 *
 * Mirrors `apps/mobile/src/data/activity.ts` deliberately: a feed that words
 * the same event two different ways across the phone and the browser is a feed
 * people stop trusting. English only for now, as the mobile copy is — the
 * verbs are the same on both.
 */

import { actorName, type ActivityRow } from '@waves/api-client';

export function describeActivity(entry: ActivityRow, myProfileId: string | null): string {
  const { payload } = entry;
  const description = typeof payload?.description === 'string' ? payload.description : null;
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
    case 'superseded':
      return `${who}'s edit replaced an earlier one`;
    case 'auto_confirmed':
      return 'A settlement was confirmed automatically after a week';
    case 'disputed': {
      const what = description ?? 'an expense';
      return `${who} says ${what} is not right`;
    }
    case 'withdrew_dispute':
      return `${who} took back their correction to ${description ?? 'an expense'}`;
    case 'accepted_dispute':
      return `${who} agreed ${description ?? 'an expense'} needs fixing`;
    case 'rejected_dispute':
      return `${who} says ${description ?? 'an expense'} is correct as it stands`;
    case 'settled':
      return `${who} recorded a settlement`;
    case 'confirmed':
      return `${who} confirmed a settlement`;
    case 'joined':
      return `${who} joined`;
    case 'created':
      return `${who} created the group`;
    default:
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
    case 'auto_confirmed':
    case 'accepted_dispute':
      return '✅';
    case 'disputed':
      return '🚩';
    case 'withdrew_dispute':
    case 'rejected_dispute':
      return '🤝';
    case 'joined':
      return '👋';
    case 'created':
      return '✨';
    default:
      return '•';
  }
}
