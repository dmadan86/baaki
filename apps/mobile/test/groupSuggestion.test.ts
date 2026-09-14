/**
 * What Review is allowed to claim about where a draft belongs.
 *
 * The rule this replaces answered exactly one question — "has this same shop
 * been filed before?" — which is no answer at all on the first morning of a
 * trip, when every shop is new precisely because you are somewhere new. That is
 * the case these tests are mostly about.
 *
 * The other half is the part with no upside and all the risk: when the answer
 * is to say nothing. A chip that lies files somebody's money into the wrong
 * ledger; a chip that asks costs one tap. So every ambiguity below — two trips
 * at once, a merchant split down the middle, a trip and a merchant pulling
 * apart — is asserted to come out as null.
 */

import { describe, expect, it } from 'vitest';

import { GroupType, type GroupRow } from '@/data/types';
import {
  buildSuggestionIndex,
  suggestGroup,
  tripsCovering,
  tripWindowsOf,
  type FiledExpense,
  type TripWindow,
} from '@/lib/groupSuggestion';

const GOA = 'group-goa';
const FLAT = 'group-flat';
const OFFICE = 'group-office';

const everywhere = new Set([GOA, FLAT, OFFICE]);

function filed(groupId: string, description: string, category: string | null = null): FiledExpense {
  return { groupId, description, category };
}

function draft(over: Partial<Parameters<typeof suggestGroup>[0]['capture']> = {}) {
  return {
    description: 'Some shop',
    category: null,
    expense_date: '2026-03-15',
    target_group_id: null,
    ...over,
  };
}

const goaTrip: TripWindow = { groupId: GOA, startDate: '2026-03-10', endDate: '2026-03-20' };

describe('what a person said outranks what the app worked out', () => {
  it('answers a tagged draft outright, whatever the history says', () => {
    const index = buildSuggestionIndex([
      filed(FLAT, 'Swiggy'),
      filed(FLAT, 'Swiggy'),
      filed(FLAT, 'Swiggy'),
    ]);
    const answer = suggestGroup({
      capture: draft({ description: 'SWIGGY*ORDER 8842', target_group_id: OFFICE }),
      index,
      trips: [goaTrip],
      assignable: everywhere,
    });
    expect(answer).toEqual({ groupId: OFFICE, reason: 'tagged', confidence: 1 });
  });

  it('ignores a tag pointing at a group the viewer can no longer write to', () => {
    // The group was left, or archived away. Falling through to the other
    // signals is right; pointing at it would be a chip that fails on tap.
    const answer = suggestGroup({
      capture: draft({ target_group_id: 'group-gone' }),
      index: buildSuggestionIndex([]),
      trips: [],
      assignable: everywhere,
    });
    expect(answer).toBeNull();
  });
});

describe('a trip that was running', () => {
  it('answers a shop it has never seen before, which is the whole point', () => {
    const answer = suggestGroup({
      capture: draft({ description: 'CAFE MADEIRA VAGATOR', expense_date: '2026-03-15' }),
      index: buildSuggestionIndex([]),
      trips: [goaTrip],
      assignable: everywhere,
    });
    expect(answer?.groupId).toBe(GOA);
    expect(answer?.reason).toBe('trip');
  });

  it('includes both ends of the window', () => {
    for (const day of ['2026-03-10', '2026-03-20']) {
      expect(tripsCovering(day, [goaTrip])).toEqual([GOA]);
    }
    expect(tripsCovering('2026-03-09', [goaTrip])).toEqual([]);
    expect(tripsCovering('2026-03-21', [goaTrip])).toEqual([]);
  });

  it('outranks a shop you usually file at home, while you are away', () => {
    // Three filings at the flat is a settled home for this merchant — and the
    // trip still wins, because that is what a person means by "I'm on a trip".
    const index = buildSuggestionIndex([
      filed(FLAT, 'Starbucks'),
      filed(FLAT, 'Starbucks'),
      filed(FLAT, 'Starbucks'),
    ]);
    const answer = suggestGroup({
      capture: draft({ description: 'STARBUCKS', expense_date: '2026-03-15' }),
      index,
      trips: [goaTrip],
      assignable: everywhere,
    });
    expect(answer?.groupId).toBe(GOA);
  });

  it('says nothing when two trips cover the same day', () => {
    const overlapping: TripWindow[] = [
      goaTrip,
      { groupId: OFFICE, startDate: '2026-03-14', endDate: '2026-03-16' },
    ];
    expect(
      suggestGroup({
        capture: draft({ expense_date: '2026-03-15' }),
        index: buildSuggestionIndex([]),
        trips: overlapping,
        assignable: everywhere,
      }),
    ).toBeNull();
  });

  it('is silent again the day after it ends', () => {
    expect(
      suggestGroup({
        capture: draft({ description: 'CAFE MADEIRA VAGATOR', expense_date: '2026-03-21' }),
        index: buildSuggestionIndex([]),
        trips: [goaTrip],
        assignable: everywhere,
      }),
    ).toBeNull();
  });
});

describe('where this shop has been filed before', () => {
  it('answers when a merchant has one settled home, however it is written', () => {
    // The gateway wrapping differs every time; the brand underneath is what
    // both sides are keyed on.
    const index = buildSuggestionIndex([
      filed(FLAT, 'Swiggy'),
      filed(FLAT, 'POS UPI SWIGGY*ORDER 8842'),
    ]);
    const answer = suggestGroup({
      capture: draft({ description: 'POS UPI SWIGGY*ORDER 9931' }),
      index,
      trips: [],
      assignable: everywhere,
    });
    expect(answer?.groupId).toBe(FLAT);
    expect(answer?.reason).toBe('merchant');
  });

  it('weighs by share rather than by the last one in', () => {
    // Three to the flat, one to the office: the flat, and not by a hair.
    const index = buildSuggestionIndex([
      filed(FLAT, 'Blue Tokai'),
      filed(FLAT, 'Blue Tokai'),
      filed(FLAT, 'Blue Tokai'),
      filed(OFFICE, 'Blue Tokai'),
    ]);
    const answer = suggestGroup({
      capture: draft({ description: 'Blue Tokai' }),
      index,
      trips: [],
      assignable: everywhere,
    });
    expect(answer?.groupId).toBe(FLAT);
  });

  it('says nothing about a merchant split down the middle', () => {
    const index = buildSuggestionIndex([filed(FLAT, 'Uber'), filed(OFFICE, 'Uber')]);
    expect(
      suggestGroup({
        capture: draft({ description: 'UBER *TRIP' }),
        index,
        trips: [],
        assignable: everywhere,
      }),
    ).toBeNull();
  });

  it('refuses to learn anything from a name that is only gateway noise', () => {
    const index = buildSuggestionIndex([filed(FLAT, 'AB'), filed(FLAT, '')]);
    expect(index.merchants.size).toBe(0);
    expect(
      suggestGroup({
        capture: draft({ description: 'AB' }),
        index,
        trips: [],
        assignable: everywhere,
      }),
    ).toBeNull();
  });

  it('does not learn user, rider, traveller or financer as merchants', () => {
    const index = buildSuggestionIndex([
      filed(FLAT, 'User'),
      filed(FLAT, 'Rider'),
      filed(FLAT, 'Traveller'),
      filed(FLAT, 'Traveler'),
      filed(FLAT, 'Financer'),
    ]);

    expect(index.merchants.size).toBe(0);
    for (const description of ['USER', 'RIDER', 'TRAVELLER', 'TRAVELER', 'FINANCER']) {
      expect(
        suggestGroup({
          capture: draft({ description }),
          index,
          trips: [],
          assignable: everywhere,
        }),
      ).toBeNull();
    }
  });

  it('drops a merchant whose only home is a group the viewer has left', () => {
    const index = buildSuggestionIndex([
      filed('group-gone', 'Swiggy'),
      filed('group-gone', 'Swiggy'),
    ]);
    expect(
      suggestGroup({
        capture: draft({ description: 'SWIGGY' }),
        index,
        trips: [],
        assignable: everywhere,
      }),
    ).toBeNull();
  });
});

describe('this kind of spend, before', () => {
  it('cannot answer off a single filing', () => {
    const index = buildSuggestionIndex([filed(FLAT, 'Some restaurant', 'food')]);
    expect(
      suggestGroup({
        capture: draft({ description: 'A place nobody has been', category: 'food' }),
        index,
        trips: [],
        assignable: everywhere,
      }),
    ).toBeNull();
  });

  it('answers once a category has a settled home and nothing disagrees', () => {
    const index = buildSuggestionIndex([
      filed(FLAT, 'Big Bazaar', 'groceries'),
      filed(FLAT, 'More Supermarket', 'groceries'),
      filed(FLAT, 'Nature Basket', 'groceries'),
    ]);
    const answer = suggestGroup({
      capture: draft({ description: 'A shop nobody has been', category: 'groceries' }),
      index,
      trips: [],
      assignable: everywhere,
    });
    expect(answer?.groupId).toBe(FLAT);
    expect(answer?.reason).toBe('category');
  });

  it('says nothing when a category is spread across groups', () => {
    const index = buildSuggestionIndex([
      filed(FLAT, 'One', 'food'),
      filed(FLAT, 'Two', 'food'),
      filed(OFFICE, 'Three', 'food'),
      filed(OFFICE, 'Four', 'food'),
    ]);
    expect(
      suggestGroup({
        capture: draft({ description: 'Five', category: 'food' }),
        index,
        trips: [],
        assignable: everywhere,
      }),
    ).toBeNull();
  });
});

describe('signals that disagree', () => {
  it('lets a strong merchant memory answer when no trip was running', () => {
    const index = buildSuggestionIndex([
      filed(OFFICE, 'Chai Point', 'food'),
      filed(OFFICE, 'Chai Point', 'food'),
    ]);
    const answer = suggestGroup({
      capture: draft({ description: 'CHAI POINT', category: 'food', expense_date: '2026-04-01' }),
      index,
      trips: [goaTrip],
      assignable: everywhere,
    });
    expect(answer?.groupId).toBe(OFFICE);
  });

  it('adds up agreeing signals rather than taking only the strongest', () => {
    // The trip covers the day and the shop has been filed to that same trip
    // before. Nothing here should make the answer *less* certain than the trip
    // alone would have been.
    const index = buildSuggestionIndex([
      filed(GOA, 'Cafe Madeira Vagator'),
      filed(GOA, 'Cafe Madeira Vagator'),
    ]);
    const answer = suggestGroup({
      capture: draft({ description: 'CAFE MADEIRA VAGATOR', expense_date: '2026-03-15' }),
      index,
      trips: [goaTrip],
      assignable: everywhere,
    });
    expect(answer?.groupId).toBe(GOA);
    expect(answer?.confidence).toBe(1);
  });
});

describe('which groups are windows at all', () => {
  const group = (over: Partial<GroupRow>): GroupRow =>
    ({
      id: 'g',
      type: GroupType.Trip,
      start_date: null,
      end_date: null,
      ...over,
    }) as GroupRow;

  it('takes dated trips and nothing else', () => {
    const windows = tripWindowsOf([
      group({ id: GOA, start_date: '2026-03-10', end_date: '2026-03-20' }),
      // A trip somebody never dated is not a window: "we went to Goa at some
      // point" must not file this morning's coffee.
      group({ id: 'undated-trip' }),
      group({ id: FLAT, type: GroupType.Home, start_date: '2026-01-01', end_date: '2026-12-31' }),
    ]);
    expect(windows).toEqual([{ groupId: GOA, startDate: '2026-03-10', endDate: '2026-03-20' }]);
  });
});
