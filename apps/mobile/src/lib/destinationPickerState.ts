/**
 * Pure state seeding for the destination picker.
 *
 * The picker itself imports React Native, so these rules live here where they can
 * be tested as ordinary TypeScript. The interesting case is a 1:1 group: it is
 * an existing group in storage, but the UI represents it as a person.
 */

export interface DestinationPersonChoice {
  name: string;
  groupId: string;
}

export type DestinationSelectionSeed =
  | { kind: 'none' }
  | { kind: 'unassigned' }
  | { kind: 'me' }
  | { kind: 'create' }
  | { kind: 'existing'; groupId: string }
  | { kind: 'people'; names: readonly string[] };

export function initialDestinationTab(
  selection: DestinationSelectionSeed,
  people: readonly DestinationPersonChoice[],
): 'groups' | 'people' {
  return selection.kind === 'people' ||
    (selection.kind === 'existing' && people.some((person) => person.groupId === selection.groupId))
    ? 'people'
    : 'groups';
}

export function initialPickedPeople(
  selection: DestinationSelectionSeed,
  people: readonly DestinationPersonChoice[],
): string[] {
  if (selection.kind === 'people') return [...selection.names];
  if (selection.kind !== 'existing') return [];

  const person = people.find((candidate) => candidate.groupId === selection.groupId);
  return person ? [person.name] : [];
}
