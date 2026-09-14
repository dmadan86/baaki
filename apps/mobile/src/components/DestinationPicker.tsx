/**
 * Where an expense lands: the one picker both the voice review and the drafts
 * inbox open.
 *
 * It was written for the voice review — the screen you reach by speaking an
 * expense — and the drafts inbox grew a second, thinner one of its own: a flat
 * list of groups, no way to point a spend at a person. Two pickers for one
 * question is one too many, so this is the voice one lifted out whole, with the
 * few things that genuinely differ between the two screens handed in as props:
 * the pinned defaults (the inbox has none — a draft already *is* unassigned,
 * and "just me" is a personal-ledger write that screen has no path for), the
 * "new group" row's wording, and how a group with no name of its own is
 * labelled.
 *
 * Groups and People are their own tab, because a flat list of every group then
 * every person grew long enough to bury one under the other. A group is one
 * place, so it is chosen and the sheet closes; people are a set — an expense can
 * be with several at once — so they are ticked and confirmed, and the parent
 * decides whether they already share a group or need a fresh one.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, TextInput, View } from 'react-native';

import { Button, Card, Divider, iconSize, Row, SegmentedTabs, Text, useTheme } from '@waves/ui';

import { groupLabel, GroupType, type GroupRow } from '@/data/types';
import { matchesAssignGroupQuery } from '@/lib/captureAssign';
import {
  initialDestinationTab,
  initialPickedPeople,
  type DestinationPersonChoice,
  type DestinationSelectionSeed,
} from '@/lib/destinationPickerState';
import type { UiStrings } from '@/i18n';

/** A person this expense can be pointed at: an existing 1:1 contact, surfaced by
 *  name, whose own group is reused rather than a second one being made. */
export interface PersonChoice extends DestinationPersonChoice {
  personKey: string;
}

/** A single-tap choice: one place, chosen, sheet closed. People are not here —
 *  they are a set, and arrive through `onResolvePeople` once confirmed. */
export type DestinationChoice =
  | { kind: 'unassigned' }
  | { kind: 'me' }
  | { kind: 'create' }
  | { kind: 'existing'; groupId: string };

/** Which row reads back as chosen. `none` is a picker opened on nothing yet. */
export type DestinationSelection = DestinationSelectionSeed;

/** One Ionicon per group type, the fallback when a group has no cover emoji —
 * echoing the new-group picker and the dashboard's category glyphs. */
export const GROUP_TYPE_ICON: Record<GroupType, React.ComponentProps<typeof Ionicons>['name']> = {
  [GroupType.Trip]: 'airplane',
  [GroupType.Home]: 'home',
  [GroupType.Couple]: 'heart',
  [GroupType.Event]: 'sparkles',
  [GroupType.Friends]: 'people-circle',
  [GroupType.Other]: 'people-outline',
};

type PickerRow = {
  key: string;
  label: string;
  // A row wears either the group's own cover emoji or, lacking one, an Ionicon
  // — the inbox and "new group" rows only ever use an icon.
  icon: React.ComponentProps<typeof Ionicons>['name'];
  emoji?: string | null;
  selected: boolean;
  onPress: () => void;
};

/** Past this many groups the Groups tab earns a search field; a short list is
 *  faster to eyeball than to type through. */
const GROUP_SEARCH_THRESHOLD = 6;

export function DestinationPicker({
  selection,
  groups,
  people,
  t,
  eyebrow = null,
  pinned = ['unassigned', 'me'],
  createRow = null,
  emptyGroups,
  labelFor = (group) => groupLabel(group),
  onChoose,
  onResolvePeople,
}: {
  /** Which row carries the check — the destination as it stands. */
  selection: DestinationSelection;
  groups: readonly GroupRow[];
  people: readonly PersonChoice[];
  t: UiStrings;
  /** The small caps line above the list ("SAVE TO"). Null where the sheet
   *  already carries a heading of its own and a second one would only repeat it. */
  eyebrow?: string | null;
  /** Which of the two non-group defaults stay pinned above the tabs. Empty on a
   *  screen where neither is a destination it can write to. */
  pinned?: readonly ('unassigned' | 'me')[];
  /** The "start a new group" row, when the calling screen offers one. */
  createRow?: { label: string } | null;
  /** What the Groups tab says when there are none. */
  emptyGroups?: string;
  /** How a group is named — the inbox resolves a nameless group to its members,
   *  which needs data only that screen holds. */
  labelFor?: (group: GroupRow) => string;
  onChoose: (choice: DestinationChoice) => void;
  /** The People-tab selection, confirmed. The parent decides whether these
   *  people already share a group (assign to it) or need a new one. */
  onResolvePeople: (names: string[]) => void;
}) {
  const theme = useTheme();
  // Open on whichever tab the current destination lives in, so the choice reads
  // back: the People tab for a people destination, and also for an existing group
  // that is really a 1:1 contact (its id is one the People tab represents);
  // otherwise Groups. Re-seeded on each open by the remount key at the call site.
  const [tab, setTab] = useState<'groups' | 'people'>(() =>
    initialDestinationTab(selection, people),
  );
  // People are chosen as a set and confirmed — a group is one place, but an
  // expense can be with several people at once. Seeded from a people destination
  // or from an existing 1:1 group, so the running selection reads back when the
  // sheet reopens.
  const [picked, setPicked] = useState<string[]>(() => initialPickedPeople(selection, people));
  // One box for both jobs, the way WhatsApp's new-group search is: it filters the
  // contacts you already have and, for a name nobody matches, adds a new person.
  const [query, setQuery] = useState('');
  // The Groups tab's own filter, separate from the People one so switching tabs
  // never carries a half-typed name across into the other list.
  const [groupQuery, setGroupQuery] = useState('');

  const isPicked = (name: string): boolean =>
    picked.some((entry) => entry.toLowerCase() === name.toLowerCase());
  const togglePicked = (name: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPicked((current) =>
      current.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())
        ? current.filter((entry) => entry.toLowerCase() !== trimmed.toLowerCase())
        : [...current, trimmed],
    );
  };
  const addTyped = (): void => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (!isPicked(trimmed)) togglePicked(trimmed);
    setQuery('');
  };

  // Pinned defaults above the tabs: the capture inbox (a Save with no destination
  // lands here) and "Just me" (a private personal expense). Neither is a group
  // nor a person, so both stay in view whichever tab is open.
  const pinnedRows: PickerRow[] = [];
  if (pinned.includes('unassigned')) {
    pinnedRows.push({
      key: 'unassigned',
      label: t.captures.unassigned,
      // The inbox row wears the dashboard's captures glyph, so "Unassigned" here
      // and the captures card on Home read as the same place.
      icon: 'file-tray-full-outline',
      selected: selection.kind === 'unassigned',
      onPress: () => onChoose({ kind: 'unassigned' }),
    });
  }
  if (pinned.includes('me')) {
    pinnedRows.push({
      key: 'me',
      label: t.voice.justMe,
      icon: 'person-circle-outline',
      selected: selection.kind === 'me',
      onPress: () => onChoose({ kind: 'me' }),
    });
  }

  const groupRows: PickerRow[] = [];
  // Driven by the calling screen, not the current destination, so the "new
  // group" row stays offered after the reader switches to the inbox or a group.
  if (createRow) {
    groupRows.push({
      key: 'create',
      label: createRow.label,
      icon: 'add-circle-outline',
      selected: selection.kind === 'create',
      onPress: () => onChoose({ kind: 'create' }),
    });
  }
  // Newest group first: the one you just made is the one you are most likely
  // saving into, so it sits at the top of the list rather than lost in creation
  // order. Every row carries its own cover emoji (or a type glyph as a fallback)
  // so a trip, a home and an event are told apart at a glance instead of a
  // column of identical people icons.
  // A person's 1:1 group is their row on the People tab, not a group in its own
  // right — showing it in both tabs lists the same conversation twice. So the
  // groups the People tab already represents are dropped here.
  const personGroupIds = new Set(people.map((person) => person.groupId));
  const sorted = [...groups]
    .filter((group) => !personGroupIds.has(group.id))
    .sort((a, b) => {
      // Newest first by creation time; when two groups share a timestamp (made
      // in the same request), fall back to id so the order is stable across
      // renders rather than flipping on every re-sort.
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  // Whether the filter is offered is decided by how many groups there are, not
  // by how many survive the filter — otherwise typing past the last match would
  // take the field away with the rows.
  const showGroupSearch = sorted.length > GROUP_SEARCH_THRESHOLD;
  const visibleGroups = showGroupSearch
    ? sorted.filter((group) => matchesAssignGroupQuery(labelFor(group), groupQuery))
    : sorted;
  for (const group of visibleGroups) {
    groupRows.push({
      key: group.id,
      label: labelFor(group),
      icon: GROUP_TYPE_ICON[group.type] ?? 'people-outline',
      emoji: group.cover_emoji,
      selected: selection.kind === 'existing' && selection.groupId === group.id,
      onPress: () => onChoose({ kind: 'existing', groupId: group.id }),
    });
  }

  // Existing contacts, filtered by the search box. Picked names still tick even
  // when the filter would hide them, so the running selection never disappears.
  const q = query.trim().toLowerCase();
  const contacts = people.filter(
    (person) => q.length === 0 || person.name.toLowerCase().includes(q),
  );
  // A typed name that is not already an existing contact — offered as an "add"
  // row so a brand-new person can join the selection without leaving the search.
  const typedIsNew =
    query.trim().length > 0 && !people.some((person) => person.name.toLowerCase() === q);

  /** The rounded search field both tabs wear, so filtering groups and filtering
   *  people are visibly the same gesture. The People one does a second job — a
   *  name nobody matches is added rather than searched for — which is what the
   *  submit handler and the trailing "+" are; the Groups one passes neither. */
  const searchField = (
    value: string,
    onChangeText: (next: string) => void,
    placeholder: string,
    onSubmit?: () => void,
    trailing?: React.ReactNode,
  ): React.JSX.Element => (
    <Row
      style={{
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.xs,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.color.border,
        backgroundColor: theme.color.surface,
        alignItems: 'center',
      }}
    >
      <Ionicons name="search" size={iconSize.md} color={theme.color.textFaint} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.color.textFaint}
        accessibilityLabel={placeholder}
        onSubmitEditing={onSubmit}
        returnKeyType="done"
        autoCorrect={false}
        style={{ flex: 1, fontSize: 15, color: theme.color.text, paddingVertical: 6 }}
      />
      {trailing}
    </Row>
  );

  const renderRow = (row: PickerRow, showDivider: boolean): React.JSX.Element => (
    <View key={row.key}>
      <Pressable
        onPress={row.onPress}
        accessibilityRole="button"
        accessibilityState={{ selected: row.selected }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: row.selected ? theme.color.brandSoft : theme.color.surfaceMuted,
          }}
        >
          {row.emoji ? (
            <Text style={{ fontSize: 18 }}>{row.emoji}</Text>
          ) : (
            <Ionicons
              name={row.icon}
              size={iconSize.md}
              color={row.selected ? theme.color.brand : theme.color.textMuted}
            />
          )}
        </View>
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: row.selected ? theme.color.brand : theme.color.text,
            fontWeight: row.selected ? '600' : '400',
          }}
        >
          {row.label}
        </Text>
        <Ionicons
          name={row.selected ? 'checkmark-circle' : 'ellipse-outline'}
          size={iconSize.md}
          color={row.selected ? theme.color.brand : theme.color.border}
        />
      </Pressable>
      {showDivider ? <Divider /> : null}
    </View>
  );

  return (
    <View style={{ gap: theme.spacing.lg }}>
      {eyebrow ? (
        <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
          {eyebrow.toUpperCase()}
        </Text>
      ) : null}

      {/* The defaults, pinned above the tabs — as chips, not as list rows.
          They were rows in a card of their own, which gave one shortcut the
          same weight and nearly the same height as the entire list of groups
          below it: a 36pt disc, a full row's padding, a card, and a large gap
          on each side, for a single word. A chip says the same thing in a
          third of the room and reads as what it is — a shortcut past the list,
          rather than the first entry in it. The 44pt floor is kept, so the
          smaller drawing costs nothing in reach. */}
      {pinnedRows.length > 0 ? (
        <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
          {pinnedRows.map((row) => (
            <Pressable
              key={row.key}
              onPress={row.onPress}
              accessibilityRole="button"
              accessibilityState={{ selected: row.selected }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.xs,
                minHeight: 44,
                paddingHorizontal: theme.spacing.md,
                borderRadius: theme.radius.pill,
                borderWidth: 1,
                borderColor: row.selected ? theme.color.brand : theme.color.border,
                backgroundColor: row.selected ? theme.color.brandSoft : 'transparent',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              {/* The tick replaces the glyph when chosen rather than joining it:
                  a chip has room for one mark, and which one it is *is* the
                  state (#191 — never colour alone). */}
              <Ionicons
                name={row.selected ? 'checkmark-circle' : row.icon}
                size={iconSize.md}
                color={row.selected ? theme.color.brand : theme.color.textMuted}
              />
              <Text
                numberOfLines={1}
                style={{
                  color: row.selected ? theme.color.brand : theme.color.text,
                  fontWeight: row.selected ? '600' : '500',
                }}
              >
                {row.label}
              </Text>
            </Pressable>
          ))}
        </Row>
      ) : null}

      {/* Groups and People are their own tab: a flat list of every group then
          every person grew long enough to bury one under the other. */}
      <SegmentedTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'groups', label: t.voice.groupsTab },
          { value: 'people', label: t.voice.peopleTab },
        ]}
      />

      {tab === 'groups' ? (
        <View style={{ gap: theme.spacing.md }}>
          {showGroupSearch ? searchField(groupQuery, setGroupQuery, t.captures.assignSearch) : null}
          {groupRows.length > 0 ? (
            <Card padded={false} flat style={{ overflow: 'hidden' }}>
              {groupRows.map((row, index) => renderRow(row, index < groupRows.length - 1))}
            </Card>
          ) : null}
          {/* Said below the card, not instead of it: "new group" is a row in that
              card, so a search that matches no group still leaves one row
              standing and the list would otherwise look like a hit. And a filter
              that matched nothing is not an empty shelf — say which it is, or a
              person retypes a name that was never going to land. */}
          {visibleGroups.length === 0 ? (
            <Text tone="muted" align="center" style={{ paddingVertical: theme.spacing.lg }}>
              {groupQuery.trim() ? t.captures.assignNoMatch : (emptyGroups ?? t.voice.noGroups)}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: theme.spacing.md }}>
          {/* Search + add, kept at the top so the keyboard never hides it. Filters
              existing contacts; a name nobody matches is added as a new person. */}
          {searchField(
            query,
            setQuery,
            t.voice.searchPeople,
            addTyped,
            query.trim().length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.voice.addPerson}
                onPress={addTyped}
                hitSlop={8}
                style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
              >
                <Ionicons name="add-circle" size={iconSize.lg} color={theme.color.brand} />
              </Pressable>
            ) : null,
          )}

          {/* The running selection as removable chips, so several people read at a
              glance and any one comes back off with a tap. */}
          {picked.length > 0 ? (
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}
              accessibilityLabel={t.voice.peopleTab}
            >
              {picked.map((name) => (
                <Pressable
                  key={name}
                  accessibilityRole="button"
                  accessibilityLabel={name}
                  onPress={() => togglePicked(name)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingLeft: theme.spacing.md,
                    paddingRight: theme.spacing.sm,
                    paddingVertical: 6,
                    borderRadius: theme.radius.pill,
                    backgroundColor: theme.color.brand,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text
                    variant="caption"
                    numberOfLines={1}
                    style={{ color: theme.color.onBrand, fontWeight: '600', maxWidth: 160 }}
                  >
                    {name}
                  </Text>
                  <Ionicons name="close" size={iconSize.sm} color={theme.color.onBrand} />
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* The contacts (filtered), each a toggle, plus an "add" row for a typed
              name that is nobody you already know. */}
          {contacts.length > 0 || typedIsNew ? (
            <Card padded={false} flat style={{ overflow: 'hidden' }}>
              {contacts.map((person, index) => {
                const on = isPicked(person.name);
                return (
                  <View key={person.groupId}>
                    <Pressable
                      onPress={() => togglePicked(person.name)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={person.name}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.md,
                        paddingVertical: theme.spacing.md,
                        paddingHorizontal: theme.spacing.lg,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: on ? theme.color.brandSoft : theme.color.surfaceMuted,
                        }}
                      >
                        <Ionicons
                          name="person-outline"
                          size={iconSize.md}
                          color={on ? theme.color.brand : theme.color.textMuted}
                        />
                      </View>
                      <Text
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          color: on ? theme.color.brand : theme.color.text,
                          fontWeight: on ? '600' : '400',
                        }}
                      >
                        {person.name}
                      </Text>
                      <Ionicons
                        name={on ? 'checkmark-circle' : 'ellipse-outline'}
                        size={iconSize.md}
                        color={on ? theme.color.brand : theme.color.border}
                      />
                    </Pressable>
                    {index < contacts.length - 1 || typedIsNew ? <Divider /> : null}
                  </View>
                );
              })}
              {typedIsNew ? (
                <Pressable
                  onPress={addTyped}
                  accessibilityRole="button"
                  accessibilityLabel={t.voice.addPerson}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingVertical: theme.spacing.md,
                    paddingHorizontal: theme.spacing.lg,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.color.surfaceMuted,
                    }}
                  >
                    <Ionicons
                      name="person-add-outline"
                      size={iconSize.md}
                      color={theme.color.brand}
                    />
                  </View>
                  <Text numberOfLines={1} style={{ flex: 1, color: theme.color.brand }}>
                    {t.voice.addNamed.replace('{name}', query.trim())}
                  </Text>
                </Pressable>
              ) : null}
            </Card>
          ) : (
            <Text tone="muted" align="center" style={{ paddingVertical: theme.spacing.lg }}>
              {t.voice.noPeople}
            </Text>
          )}

          {/* One confirm: the parent decides whether the picked people already
              share a group (assign to it) or need a fresh one. */}
          <Button
            label={picked.length > 0 ? t.voice.confirmPeople : t.voice.selectPeople}
            onPress={() => onResolvePeople(picked)}
            disabled={picked.length === 0}
          />
        </View>
      )}
    </View>
  );
}
