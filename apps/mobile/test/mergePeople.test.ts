import { describe, expect, it } from 'vitest';

import {
  canMerge,
  defaultMergeName,
  isMergeable,
  memberIdsForMerge,
  mergeErrorMessage,
  type MergeErrorStrings,
} from '@/data/mergePeople';

/** A minimal person row — only the fields the merge logic reads. */
function row(over: Partial<{ member_id: string; display_name: string; is_ghost: boolean }> = {}) {
  return {
    member_id: over.member_id ?? 'm1',
    display_name: over.display_name ?? 'person1',
    is_ghost: over.is_ghost ?? true,
  };
}

describe('isMergeable', () => {
  it('allows a ghost', () => {
    expect(isMergeable({ is_ghost: true })).toBe(true);
  });

  it('refuses a real person — they are already one identity by their profile', () => {
    expect(isMergeable({ is_ghost: false })).toBe(false);
  });
});

describe('memberIdsForMerge', () => {
  it('returns the distinct member ids', () => {
    expect(memberIdsForMerge([row({ member_id: 'a' }), row({ member_id: 'b' })])).toEqual([
      'a',
      'b',
    ]);
  });

  it('counts one ghost seen in two currencies as a single member', () => {
    // Same person1, unsettled in both ₹ and € — two rows, one member.
    const inr = row({ member_id: 'a' });
    const eur = row({ member_id: 'a' });
    expect(memberIdsForMerge([inr, eur])).toEqual(['a']);
  });

  it('is empty for no selection', () => {
    expect(memberIdsForMerge([])).toEqual([]);
  });
});

describe('canMerge', () => {
  it('needs at least two distinct people', () => {
    expect(canMerge([])).toBe(false);
    expect(canMerge([row({ member_id: 'a' })])).toBe(false);
    expect(canMerge([row({ member_id: 'a' }), row({ member_id: 'b' })])).toBe(true);
  });

  it('does not count the same member twice (two currencies of one ghost)', () => {
    expect(canMerge([row({ member_id: 'a' }), row({ member_id: 'a' })])).toBe(false);
  });

  it('allows three or more', () => {
    expect(
      canMerge([row({ member_id: 'a' }), row({ member_id: 'b' }), row({ member_id: 'c' })]),
    ).toBe(true);
  });
});

describe('defaultMergeName', () => {
  it('picks the most common name', () => {
    const rows = [
      row({ display_name: 'Ravi' }),
      row({ display_name: 'person1' }),
      row({ display_name: 'person1' }),
    ];
    expect(defaultMergeName(rows)).toBe('person1');
  });

  it('breaks a tie by the order picked', () => {
    const rows = [row({ display_name: 'Ravi' }), row({ display_name: 'person1' })];
    expect(defaultMergeName(rows)).toBe('Ravi');
  });

  it('ignores blank and whitespace-only names', () => {
    const rows = [
      row({ display_name: '   ' }),
      row({ display_name: '' }),
      row({ display_name: 'person1' }),
    ];
    expect(defaultMergeName(rows)).toBe('person1');
  });

  it('trims the chosen name', () => {
    expect(defaultMergeName([row({ display_name: '  person1  ' })])).toBe('person1');
  });

  it('returns empty string when nothing usable remains', () => {
    expect(defaultMergeName([row({ display_name: '   ' }), row({ display_name: '' })])).toBe('');
    expect(defaultMergeName([])).toBe('');
  });
});

describe('mergeErrorMessage', () => {
  const t: MergeErrorStrings = {
    errorTooFew: 'pick two',
    errorNotMergeable: 'guests only',
    errorNameRequired: 'name needed',
    errorGeneric: 'something went wrong',
  };

  it('maps each RPC error prefix', () => {
    expect(mergeErrorMessage(new Error('TOO_FEW: pick at least two people to merge'), t)).toBe(
      'pick two',
    );
    expect(
      mergeErrorMessage(
        new Error('NOT_MERGEABLE: every person must be a guest you share a group with'),
        t,
      ),
    ).toBe('guests only');
    expect(mergeErrorMessage(new Error('NAME_REQUIRED: the merged person needs a name'), t)).toBe(
      'name needed',
    );
  });

  it('falls back to generic for an unrecognised or infra error', () => {
    expect(mergeErrorMessage(new Error('NOT_SIGNED_IN'), t)).toBe('something went wrong');
    expect(mergeErrorMessage(new Error('Network request failed'), t)).toBe('something went wrong');
  });

  it('handles a non-Error thrown value', () => {
    expect(mergeErrorMessage('boom', t)).toBe('something went wrong');
    expect(mergeErrorMessage(null, t)).toBe('something went wrong');
  });
});
