/**
 * What a group is about, guessed from its name.
 *
 * The new-group screen used to open with eight emoji laid out as a picker. It
 * cost a row and a half of a screen somebody is trying to get through, to ask a
 * question that the name they are already typing almost always answers: a group
 * called "Goa December" is a beach, "Flat 402" is a flat, "Ravi + me" is not a
 * trip. So the picker is gone and the name drives the icon instead.
 *
 * Same bargain as `guessCategory`, and the same shape: lowercase whole words,
 * never substrings — `ola` is a cab company and also the middle of "chocolate".
 * The vocabulary is deliberately Indian for the same reason it is there: a list
 * written elsewhere knows "vacation" and not "shaadi", and files Kasol under
 * nothing.
 *
 * Returns null rather than a default when nothing matches. Null means the guess
 * has nothing to say, and the caller — which knows what kind of group the
 * person picked — has a better answer than this file could invent.
 */

export interface GroupIcon {
  /** What gets drawn. The app renders this directly; no icon font involved. */
  readonly emoji: string;
  /** Lowercase whole words that mean this icon. */
  readonly keywords: readonly string[];
}

/**
 * Order is the tiebreak, so the specific sits above the general: "Goa trip"
 * scores one for beach and one for travel, and beach is the better picture.
 */
export const GROUP_ICONS: readonly GroupIcon[] = [
  {
    emoji: '🏖️',
    keywords: [
      'beach',
      'goa',
      'pondicherry',
      'pondy',
      'varkala',
      'gokarna',
      'alibaug',
      'andaman',
      'maldives',
      'bali',
      'phuket',
      'island',
      'islands',
      'sea',
      'coast',
      'seaside',
      'shore',
      'resort',
    ],
  },
  {
    emoji: '⛰️',
    keywords: [
      'mountain',
      'mountains',
      'hill',
      'hills',
      'trek',
      'trekking',
      'hike',
      'hiking',
      'himalaya',
      'himalayas',
      'manali',
      'leh',
      'ladakh',
      'shimla',
      'ooty',
      'munnar',
      'coorg',
      'kodaikanal',
      'spiti',
      'kasol',
      'rishikesh',
      'camp',
      'camping',
    ],
  },
  {
    emoji: '🎓',
    keywords: [
      'college',
      'school',
      'class',
      'classmates',
      'batch',
      'university',
      'uni',
      'semester',
      'alumni',
      'seniors',
      'juniors',
      'fresher',
      'freshers',
    ],
  },
  {
    emoji: '🎉',
    keywords: [
      'party',
      'birthday',
      'bday',
      'wedding',
      'shaadi',
      'reception',
      'sangeet',
      'anniversary',
      'celebration',
      'farewell',
      'reunion',
      'newyear',
      'diwali',
      'holi',
      'christmas',
      'eid',
      'pongal',
      'onam',
    ],
  },
  {
    emoji: '🏠',
    keywords: [
      'home',
      'house',
      'flat',
      'flats',
      'flatmate',
      'flatmates',
      'apartment',
      'rent',
      'roommate',
      'roommates',
      'pg',
      'hostel',
      'villa',
      'society',
      'household',
      'maintenance',
    ],
  },
  {
    emoji: '💜',
    keywords: ['couple', 'partner', 'boyfriend', 'girlfriend', 'hubby', 'wifey', 'honeymoon'],
  },
  {
    emoji: '🍽️',
    keywords: [
      'dinner',
      'dinners',
      'lunch',
      'brunch',
      'breakfast',
      'food',
      'foodie',
      'restaurant',
      'dining',
      'potluck',
      'bbq',
      'barbecue',
      'feast',
      'mess',
      'canteen',
      'tiffin',
    ],
  },
  {
    emoji: '🏢',
    keywords: [
      'office',
      'work',
      'team',
      'project',
      'colleagues',
      'coworkers',
      'startup',
      'client',
      'offsite',
      'standup',
    ],
  },
  {
    emoji: '🚗',
    keywords: [
      'car',
      'bike',
      'cab',
      'taxi',
      'fuel',
      'petrol',
      'diesel',
      'uber',
      'ola',
      'rapido',
      'commute',
      'carpool',
      'roadtrip',
    ],
  },
  {
    emoji: '🛒',
    keywords: [
      'grocery',
      'groceries',
      'kirana',
      'supermarket',
      'shopping',
      'bigbasket',
      'blinkit',
      'zepto',
      'dmart',
      'market',
      'ration',
    ],
  },
  {
    emoji: '🏏',
    keywords: [
      'cricket',
      'match',
      'ipl',
      'football',
      'turf',
      'badminton',
      'tennis',
      'gym',
      'tournament',
    ],
  },
  {
    emoji: '🎬',
    keywords: [
      'movie',
      'movies',
      'cinema',
      'concert',
      'gig',
      'show',
      'netflix',
      'subscription',
      'subscriptions',
      'gaming',
      'tickets',
    ],
  },
  {
    // Last: every one of these also appears in a name that is more specific
    // than "somebody is going somewhere", and those should win.
    emoji: '✈️',
    keywords: [
      'trip',
      'trips',
      'tour',
      'travel',
      'travels',
      'vacation',
      'holiday',
      'getaway',
      'flight',
      'flights',
      'backpacking',
      'itinerary',
      'europe',
      'thailand',
      'dubai',
      'japan',
      'singapore',
    ],
  },
];

/** Lowercased whole words, Unicode-aware so Tamil and Hindi survive intact. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * The icon a group name suggests, or null when it suggests nothing.
 *
 * Most hits wins; ties go to whichever is listed first, so the same name gives
 * the same icon on every device — the determinism ADR-009 asks of the money,
 * applied to something much smaller.
 */
export function guessGroupEmoji(name: string): string | null {
  const tokens = new Set(tokenise(name));
  if (tokens.size === 0) return null;

  let best: string | null = null;
  let bestHits = 0;
  for (const icon of GROUP_ICONS) {
    let hits = 0;
    for (const keyword of icon.keywords) {
      if (tokens.has(keyword)) hits += 1;
    }
    if (hits > bestHits) {
      best = icon.emoji;
      bestHits = hits;
    }
  }
  return best;
}

/** The kind of group its name suggests. String values, not an app enum, so core
 *  stays free of the mobile `GroupType` — the caller casts. Matches the enum's
 *  string values exactly ('trip' | 'home' | ...). */
export type GuessedGroupType = 'trip' | 'home' | 'couple' | 'event' | 'friends' | 'other';

/**
 * The picture the name-guesser lands on, mapped to a kind of group. One source
 * of truth: whatever emoji `guessGroupEmoji` picks decides the kind, so "Goa"
 * (a beach) is a trip and "Flat 402" (a house) is a home. Every icon that means
 * "somebody is going somewhere" maps to Trip; the rest to the nearest kind.
 */
const EMOJI_TO_TYPE: Record<string, GuessedGroupType> = {
  '🏖️': 'trip',
  '⛰️': 'trip',
  '✈️': 'trip',
  '🏠': 'home',
  '🛒': 'home',
  '💜': 'couple',
  '🎉': 'event',
  '🎓': 'friends',
  '🏏': 'friends',
  '🍽️': 'friends',
  '🎬': 'friends',
  '🏢': 'other',
  '🚗': 'other',
};

/**
 * The kind of group a name suggests, or null when it suggests nothing — the
 * caller (which opens on a sensible default) decides what "nothing" means. Lets
 * the new-group screen keep Trip out of the default while still catching the
 * "Goa trip" that genuinely is one, from the same word list the icon reads.
 */
export function guessGroupType(name: string): GuessedGroupType | null {
  const emoji = guessGroupEmoji(name);
  return emoji ? (EMOJI_TO_TYPE[emoji] ?? null) : null;
}
