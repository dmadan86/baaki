/**
 * The picker can open on a group that is really a person.
 *
 * One-to-one groups are hidden from the Groups tab because the People tab is
 * their row. If the current destination is one of those groups, the picker must
 * still read back the choice; otherwise the selected rider, traveller or
 * financer disappears and Confirm is disabled until the person is picked again.
 */

import { describe, expect, it } from 'vitest';

import {
  initialDestinationTab,
  initialPickedPeople,
  type DestinationPersonChoice,
} from '../src/lib/destinationPickerState';

const people: (DestinationPersonChoice & { personKey: string })[] = [
  { personKey: 'user-key', name: 'User', groupId: 'user' },
  { personKey: 'rider-key', name: 'Rider', groupId: 'rider' },
  { personKey: 'traveller-key', name: 'Traveller', groupId: 'traveller' },
  { personKey: 'financer-key', name: 'Financer', groupId: 'financer' },
];

describe('DestinationPicker initial people selection', () => {
  it('opens existing one-to-one destinations on the People tab with the person picked', () => {
    for (const person of people) {
      const selection = { kind: 'existing' as const, groupId: person.groupId };

      expect(initialDestinationTab(selection, people)).toBe('people');
      expect(initialPickedPeople(selection, people)).toEqual([person.name]);
    }
  });

  it('keeps ordinary existing groups on the Groups tab without inventing people', () => {
    const selection = { kind: 'existing' as const, groupId: 'goa-trip' };

    expect(initialDestinationTab(selection, people)).toBe('groups');
    expect(initialPickedPeople(selection, people)).toEqual([]);
  });

  it('preserves an explicit multi-person draft selection', () => {
    const selection = { kind: 'people' as const, names: ['Rider', 'Traveller'] };

    expect(initialDestinationTab(selection, people)).toBe('people');
    expect(initialPickedPeople(selection, people)).toEqual(['Rider', 'Traveller']);
  });
});
