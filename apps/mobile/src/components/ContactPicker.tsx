/**
 * Picking people out of the phone's contacts.
 *
 * The address book never leaves the device. Contacts are read, searched and
 * displayed locally; only the people you tick are sent anywhere, and only as
 * the name and address needed to invite them.
 *
 * This is worth being deliberate about, because the usual version of this
 * feature uploads the whole book to find "who else already uses Waves". That
 * turns an address book into a membership oracle — it tells the server, and
 * anyone who later reaches the server, which of your contacts use the app.
 * Waves has no such endpoint and this component does not want one: an invite
 * link works whether or not the person has ever heard of us (ADR-006).
 *
 * The shape is the phone's own contacts app, because that is the list everyone
 * here has already learned: a search field that says how many there are,
 * letter sections that stick to the top as you scroll, and an index rail down
 * the side to throw yourself at a letter. A thousand contacts is not a list you
 * scroll — it is a list you aim at.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync } from 'expo-contacts';
import {
  AppState,
  Linking,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import {
  Avatar,
  Button,
  directionalIcon,
  EmptyState,
  iconSize,
  Row,
  Text,
  useTheme,
} from '@waves/ui';

import { plural, useStrings } from '@/i18n';
import { normaliseContactPhone } from '@/lib/phone';
import { SkeletonList } from '@/components/Skeletons';

export interface PickedContact {
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

interface ContactPickerProps {
  /** Called with everyone ticked, once, when the confirm button is pressed. */
  onConfirm: (contacts: readonly PickedContact[]) => void;
  /** Already in the group — shown greyed rather than hidden, so it is obvious why. */
  existing?: ReadonlySet<string>;
  /** Already chosen elsewhere on the screen — opens ticked and in the strip, so
   *  the picker reflects who is already selected rather than starting blank. */
  initialSelected?: readonly PickedContact[];
  /** The verb on the confirm button. The count and noun are added here. */
  confirmVerb?: string;
  /** Disables confirming while the caller is still writing the last lot away. */
  busy?: boolean;
  /**
   * Pick exactly one. A tap confirms that person there and then — no ticking, no
   * strip, no confirm button — because a one-to-one IOU has room for a single
   * name and asking someone to tick one then press a button is a step invented
   * for a list that only ever wanted one answer.
   */
  single?: boolean;
}

/**
 * `denied` is the person's answer. `unavailable` is ours — the address book
 * could not be read for a reason that has nothing to do with them.
 *
 * These used to be one state, and the whole feature died of it: in SDK 57 the
 * old `Contacts.getContactsAsync` throws on every call, so a phone that had
 * just granted permission was told "Waves cannot see your contacts" and offered
 * a settings screen where the switch was already on. A catch that turns every
 * failure into the same sentence does not just lose the reason — it prints a
 * confident lie.
 */
enum Access {
  Asking = 'asking',
  Granted = 'granted',
  Denied = 'denied',
  Unavailable = 'unavailable',
}

/**
 * Only these. Asking for less than the platform offers is the cheapest privacy
 * measure there is — the name to show, and the one address needed to invite.
 */
const FIELDS = [
  ContactField.FULL_NAME,
  ContactField.GIVEN_NAME,
  ContactField.FAMILY_NAME,
  ContactField.EMAILS,
  ContactField.PHONES,
] as const;

/** A letter heading, or somebody. One flat array so the list can recycle both. */
type Entry = { readonly letter: string } | PickedContact;

const isHeading = (entry: Entry): entry is { readonly letter: string } => 'letter' in entry;

const ROW_HEIGHT = 64;
const HEADING_HEIGHT = 38;
const RAIL_WIDTH = 24;
const RAIL_LETTER_HEIGHT = 15;
const STRIP_HEIGHT = 62;

export function ContactPicker({
  onConfirm,
  existing,
  initialSelected,
  confirmVerb,
  busy = false,
  single = false,
}: ContactPickerProps): React.JSX.Element {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const [access, setAccess] = useState<Access>(Access.Asking);
  const [contacts, setContacts] = useState<PickedContact[]>([]);
  const [query, setQuery] = useState('');
  // Seeded from whoever is already chosen, so opening the picker shows them
  // ticked and in the strip rather than an empty selection.
  const [picked, setPicked] = useState<ReadonlyMap<string, PickedContact>>(
    () => new Map((initialSelected ?? []).map((contact) => [keyOf(contact), contact])),
  );
  const cancelled = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    let granted: boolean;
    try {
      const current = await getPermissionsAsync();
      granted =
        current.granted || (current.canAskAgain && (await requestPermissionsAsync()).granted);
    } catch {
      // Permission itself could not be asked: no contacts module on this
      // platform (web) or an OS that refused the question.
      if (!cancelled.current) setAccess(Access.Unavailable);
      return;
    }
    if (cancelled.current) return;
    if (!granted) {
      setAccess(Access.Denied);
      return;
    }

    let rows: Awaited<ReturnType<typeof Contact.getAllDetails<typeof FIELDS>>>;
    try {
      rows = await Contact.getAllDetails(FIELDS);
    } catch {
      if (!cancelled.current) setAccess(Access.Unavailable);
      return;
    }
    if (cancelled.current) return;

    const unique = new Map<string, PickedContact>();
    for (const contact of rows
      .map((row) => ({
        name: (row.fullName ?? [row.givenName, row.familyName].filter(Boolean).join(' ')).trim(),
        email: row.emails?.[0]?.address?.trim().toLowerCase() ?? null,
        phone: normalisePhone(row.phones?.[0]?.number ?? null),
      }))
      // Somebody with neither an email nor a number cannot be invited, so
      // showing them would only be an invitation to tap and be refused.
      .filter((contact) => contact.name && (contact.email || contact.phone))) {
      unique.set(keyOf(contact), contact);
    }
    setContacts([...unique.values()].sort((a, b) => a.name.localeCompare(b.name)));
    setAccess(Access.Granted);
  }, []);

  // Read on a tick rather than in the effect body: the React Compiler counts a
  // synchronous call that can setState as a cascading render, and reading an
  // address book is exactly the "talk to a platform API" case a timer suits.
  useEffect(() => {
    cancelled.current = false;
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      cancelled.current = true;
    };
  }, [load]);

  /**
   * "Open settings" sends somebody out of the app to grant access. Without
   * this, they came back to the same refusal and had to guess that killing
   * Waves and starting it again was the missing step.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && access === Access.Denied) void load();
    });
    return () => subscription.remove();
  }, [access, load]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter(
      (contact) =>
        contact.name.toLowerCase().includes(needle) ||
        contact.email?.includes(needle) ||
        contact.phone?.includes(needle),
    );
  }, [contacts, query]);

  /**
   * The flat list, the indices that stick, and where each letter starts.
   *
   * All three come out of one pass because they have to agree: a rail that
   * jumps to a stale index scrolls to the wrong person, and that is the kind of
   * wrong that only shows up on somebody else's address book.
   */
  const sections = useMemo(() => {
    const entries: Entry[] = [];
    const sticky: number[] = [];
    const starts = new Map<string, number>();
    let current: string | null = null;

    for (const contact of matches) {
      const letter = bucketOf(contact.name);
      if (letter !== current) {
        current = letter;
        starts.set(letter, entries.length);
        sticky.push(entries.length);
        entries.push({ letter });
      }
      entries.push(contact);
    }
    return { entries, sticky, starts, letters: [...starts.keys()] };
  }, [matches]);

  const listRef = useRef<FlashListRef<Entry>>(null);
  // Tapping the search row (the magnifier or its padding, not just the input's
  // own text) should put the caret in the field — a bare Ionicons is inert, so
  // the icon looked tappable but did nothing.
  const searchRef = useRef<TextInput>(null);

  /**
   * Back to the top whenever the search changes. Without this the list keeps
   * the offset it had before, so typing two letters leaves you looking at the
   * middle of four results with the first one scrolled off — it reads as
   * "nothing matched" when in fact the match is above you.
   */
  useEffect(() => {
    if (sections.entries.length > 0) {
      void listRef.current?.scrollToIndex({ index: 0, animated: false });
    }
  }, [query, sections.entries.length]);

  const toggle = useCallback((key: string, contact: PickedContact) => {
    setPicked((previous) => {
      const next = new Map(previous);
      if (next.has(key)) next.delete(key);
      else next.set(key, contact);
      return next;
    });
  }, []);

  if (access === Access.Asking) {
    // Reading a full address book is a real wait, so this is the shape of the
    // list that is coming — rows of a face and a name — not a line of text.
    // No trailing block: a contact row ends in a tick, not an amount.
    return <SkeletonList rows={6} trailing={false} />;
  }

  if (access === Access.Denied) {
    // A refusal is a state, not a dead end: a friendly medallion, what it means,
    // and the one button that fixes it. `Linking.openSettings` opens the app's
    // own settings page where the contacts switch lives — a prominent primary
    // action, not a buried ghost link — and the AppState listener reloads on the
    // way back. (`Contacts.presentFormAsync` used to sit here, which opens a
    // *new-contact* form, not the permission screen the label promises.)
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <EmptyState
          icon={<Ionicons name="people-outline" size={iconSize.xxl} color={theme.color.brand} />}
          title={t.pickers.contactsDeniedTitle}
          body={t.pickers.contactsDenied}
          action={
            <Button
              label={t.pickers.openSettings}
              onPress={() => void Linking.openSettings().catch(() => undefined)}
            />
          }
        />
      </View>
    );
  }

  if (access === Access.Unavailable) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <EmptyState
          icon={<Ionicons name="book-outline" size={iconSize.xxl} color={theme.color.brand} />}
          title={t.pickers.contactsUnavailableTitle}
          body={t.pickers.contactsUnavailable}
          action={
            <Button label={t.pickers.tryAgain} variant="secondary" onPress={() => void load()} />
          }
        />
      </View>
    );
  }

  const chosen = [...picked.values()];

  return (
    <View style={{ gap: theme.spacing.md, flex: 1 }}>
      <Pressable
        onPress={() => searchRef.current?.focus()}
        // Purely a tap target that forwards focus to the field. Kept out of the
        // accessibility tree (accessible={false}, no role/label) so it can't
        // absorb the TextInput and clear button under it — on iOS VoiceOver an
        // accessible wrapper groups its descendants and they stop being reachable
        // on their own. The role lives on the TextInput instead.
        accessible={false}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          height: 44,
          paddingHorizontal: theme.spacing.lg,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.color.surfaceMuted,
        }}
      >
        <Ionicons name="search" size={iconSize.md} color={theme.color.textFaint} />
        <TextInput
          ref={searchRef}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          accessibilityRole="search"
          accessibilityLabel={t.pickers.searchContacts}
          // The phone's own contacts app puts the count here rather than the
          // word "search", and it answers the first question somebody has when
          // they open a list this long: is it all of them?
          placeholder={plural(locale, contacts.length, t.pickers.contactCount)}
          placeholderTextColor={theme.color.textFaint}
          style={{ flex: 1, fontSize: 16, color: theme.color.text, paddingVertical: 0 }}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel={t.pickers.clearSearch}
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={iconSize.md} color={theme.color.textFaint} />
          </Pressable>
        ) : null}
      </Pressable>

      {!single && chosen.length > 0 ? <PickedStrip chosen={chosen} onRemove={toggle} /> : null}

      {matches.length === 0 ? (
        <EmptyState
          icon={
            <Ionicons
              name={query ? 'search-outline' : 'people-outline'}
              size={iconSize.xxl}
              color={theme.color.brand}
            />
          }
          title={t.pickers.nobodyHere}
          body={query ? t.pickers.noContactMatches : t.pickers.noneHasEmailOrNumber}
        />
      ) : (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View
            style={{
              flex: 1,
              borderRadius: theme.radius.md,
              backgroundColor: theme.color.surface,
              overflow: 'hidden',
            }}
          >
            <FlashList
              ref={listRef}
              data={sections.entries}
              extraData={picked}
              // The picker lives inside the members screen's own ScrollView. On
              // Android a parent ScrollView swallows a nested list's vertical
              // drag unless the inner list claims it — without this the contact
              // list simply will not scroll.
              nestedScrollEnabled
              stickyHeaderIndices={sections.sticky}
              // Headings and people are different shapes; telling the list so
              // lets it recycle each against its own kind instead of throwing
              // away a row every time a letter goes by.
              getItemType={(entry) => (isHeading(entry) ? 'heading' : 'person')}
              keyExtractor={(entry) => (isHeading(entry) ? `letter-${entry.letter}` : keyOf(entry))}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                if (isHeading(item)) return <Heading letter={item.letter} />;
                const key = keyOf(item);
                const already = Boolean(
                  (item.email && existing?.has(item.email)) ||
                  (item.phone && existing?.has(item.phone)),
                );
                return (
                  <ContactRow
                    contact={item}
                    already={already}
                    single={single}
                    // Single-pick confirms on the tap, so `busy` has no button to
                    // disable — it has to lock the rows themselves, or a second
                    // tap fires a second confirm while the first is still writing.
                    disabled={single && busy}
                    selected={single ? false : picked.has(key)}
                    onPress={() => (single ? onConfirm([item]) : toggle(key, item))}
                  />
                );
              }}
            />
          </View>

          {/* Only worth a rail when there is more than one letter to aim at. */}
          {sections.letters.length > 1 ? (
            <IndexRail
              letters={sections.letters}
              onSeek={(letter) => {
                const index = sections.starts.get(letter);
                if (index !== undefined) {
                  void listRef.current?.scrollToIndex({ index, animated: false });
                }
              }}
            />
          ) : null}
        </View>
      )}

      <Text variant="micro" tone="muted">
        {t.pickers.onlyPickedAreSent}
      </Text>

      {/* Single-pick confirms on the tap itself, so there is no set to send and
          no button to send it — the row is the action. */}
      {single ? null : (
        <Button
          label={
            chosen.length === 0
              ? t.pickers.nobodyPickedYet
              : `${confirmVerb ?? t.add} ${plural(locale, chosen.length, t.pickers.personCount)}`
          }
          fullWidth
          disabled={chosen.length === 0 || busy}
          onPress={() => onConfirm(chosen)}
        />
      )}
    </View>
  );
}

/**
 * The letter heading. A filled square rather than the app's usual pill, because
 * a pill in this design system means "you can tap this" and a heading is not
 * something you tap — you tap the rail on the right.
 */
function Heading({ letter }: { letter: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        height: HEADING_HEIGHT,
        justifyContent: 'center',
        paddingHorizontal: theme.spacing.lg,
        // Opaque: a sticky heading floats over the rows sliding under it.
        backgroundColor: theme.color.surface,
      }}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.color.brand,
        }}
      >
        <Text variant="caption" tone="onBrand">
          {letter}
        </Text>
      </View>
    </View>
  );
}

function ContactRow({
  contact,
  already,
  selected,
  single = false,
  disabled = false,
  onPress,
}: {
  contact: PickedContact;
  already: boolean;
  selected: boolean;
  single?: boolean;
  /** Locked for a reason other than membership (a single-pick write in flight). */
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const inset = theme.spacing.lg + 40 + theme.spacing.md;
  // `already` is one reason a row is inert (and the only one that renames the
  // subtitle); `disabled` is the other. Both dim and deafen the row the same way.
  const locked = already || disabled;

  return (
    <Pressable
      onPress={locked ? undefined : onPress}
      disabled={locked}
      // Single-pick is a choose-one list, so each row is a radio button that
      // acts on the tap; multi keeps the checkbox it fills and unfills.
      accessibilityRole={single ? 'button' : 'checkbox'}
      accessibilityState={single ? { disabled: locked } : { checked: selected, disabled: locked }}
      accessibilityLabel={
        already ? t.pickers.alreadyAddedName.replace('{name}', contact.name) : contact.name
      }
      style={({ pressed }) => ({
        opacity: locked ? 0.45 : 1,
        backgroundColor: pressed ? theme.color.surfaceMuted : theme.color.surface,
      })}
    >
      <Row
        style={{
          height: ROW_HEIGHT,
          paddingHorizontal: theme.spacing.lg,
          gap: theme.spacing.md,
        }}
      >
        <Avatar name={contact.name} size={40} />
        <View style={{ flex: 1 }}>
          <Text variant="body" numberOfLines={1}>
            {contact.name}
          </Text>
          <Text variant="micro" tone="muted" numberOfLines={1}>
            {already ? t.pickers.alreadyInGroup : (contact.email ?? contact.phone ?? '')}
          </Text>
        </View>
        {single ? (
          <Ionicons
            name={directionalIcon('chevron-forward')}
            size={iconSize.lg}
            color={theme.color.textFaint}
          />
        ) : (
          <Ionicons
            name={selected ? 'checkmark-circle' : 'ellipse-outline'}
            size={iconSize.xxl}
            color={selected ? theme.color.brand : theme.color.border}
          />
        )}
      </Row>
      {/* Inset past the avatar, so the rule reads as separating names rather
          than boxing every row. */}
      <View style={{ height: 1, marginLeft: inset, backgroundColor: theme.color.border }} />
    </Pressable>
  );
}

/**
 * Who is ticked, at the top, as faces.
 *
 * The count on the button says how many; this says who. Without it, ticking
 * somebody four hundred rows ago is an act of faith — you cannot scroll back to
 * check without losing your place.
 */
function PickedStrip({
  chosen,
  onRemove,
}: {
  chosen: readonly PickedContact[];
  onRemove: (key: string, contact: PickedContact) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      // A horizontal ScrollView is still a flex child of the column above it,
      // and without this it takes every spare pixel and pushes the list off the
      // bottom of the screen. It grew to half the screen for two faces.
      style={{ height: STRIP_HEIGHT, flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{ gap: theme.spacing.md, paddingRight: theme.spacing.lg }}
    >
      {chosen.map((contact) => (
        <Pressable
          key={keyOf(contact)}
          onPress={() => onRemove(keyOf(contact), contact)}
          accessibilityRole="button"
          accessibilityLabel={t.pickers.removeName.replace('{name}', contact.name)}
          style={{ width: 56, alignItems: 'center', gap: 2 }}
        >
          <View>
            <Avatar name={contact.name} size={40} />
            <View
              style={{
                position: 'absolute',
                right: -2,
                top: -2,
                width: 18,
                height: 18,
                borderRadius: 9,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.color.text,
                borderWidth: 1.5,
                borderColor: theme.color.bg,
              }}
            >
              <Ionicons name="close" size={iconSize.micro} color={theme.color.surface} />
            </View>
          </View>
          {/* Full width and centred, or Android measures the label against the
              text rather than the tile and clips it mid-word with no ellipsis
              to say it did. */}
          <Text
            variant="micro"
            tone="muted"
            numberOfLines={1}
            style={{ width: '100%', textAlign: 'center' }}
          >
            {contact.name.split(/\s+/)[0]}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * The index rail.
 *
 * Hand-written, because every published React Native alphabet-index component
 * stopped being maintained years ago and would have to be patched onto a modern
 * list anyway. It is forty lines: letters laid out in a column, a drag mapped
 * back to whichever one it is over.
 *
 * The letters come from the data rather than a hard-coded A–Z, so a book full
 * of Tamil or Devanagari names gets a rail that matches it. When there are more
 * letters than fit, it takes every nth — the rail is for aiming, not for
 * reading, and a squashed complete alphabet is worse at aiming than a sparse
 * one.
 */
function IndexRail({
  letters,
  onSeek,
}: {
  letters: readonly string[];
  onSeek: (letter: string) => void;
}): React.JSX.Element {
  const { t } = useStrings();
  const [height, setHeight] = useState(0);
  const [active, setActive] = useState<string | null>(null);

  const shown = useMemo(() => {
    const room = Math.max(1, Math.floor(height / RAIL_LETTER_HEIGHT));
    if (height === 0 || letters.length <= room) return letters;
    const stride = Math.ceil(letters.length / room);
    return letters.filter((_, index) => index % stride === 0);
  }, [letters, height]);

  /**
   * Which letter the finger is over.
   *
   * Measured against the block of letters, not the rail: the letters are
   * centred in a rail as tall as the list, so dividing the rail's height by the
   * letter count would put every hit target somewhere the letter is not.
   */
  const seekAt = (y: number): void => {
    if (shown.length === 0) return;
    const top = Math.max(0, (height - shown.length * RAIL_LETTER_HEIGHT) / 2);
    const index = Math.min(
      shown.length - 1,
      Math.max(0, Math.floor((y - top) / RAIL_LETTER_HEIGHT)),
    );
    seekToIndex(index);
  };

  const seekToIndex = (index: number): void => {
    const letter = shown[index];
    if (letter === undefined || letter === active) return;
    setActive(letter);
    onSeek(letter);
  };

  const seekByStep = (step: -1 | 1): void => {
    if (shown.length === 0) return;
    const current = active ? shown.indexOf(active) : -1;
    const next = Math.min(shown.length - 1, Math.max(0, current + step));
    seekToIndex(next);
  };

  return (
    <View
      onLayout={(event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height)}
      // The rail is one control, not a column of buttons: a finger dragged down
      // it should sweep through letters the way it does on the phone's own
      // contacts app, so it claims the gesture rather than passing taps down.
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(event) => seekAt(event.nativeEvent.locationY)}
      onResponderMove={(event) => seekAt(event.nativeEvent.locationY)}
      onResponderRelease={() => setActive(null)}
      onResponderTerminate={() => setActive(null)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t.pickers.jumpToLetter}
      accessibilityValue={active ? { text: active } : undefined}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'increment') seekByStep(1);
        if (event.nativeEvent.actionName === 'decrement') seekByStep(-1);
      }}
      style={{
        width: RAIL_WIDTH,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* The letters take no touches of their own. A touch reports `locationY`
          against whatever element it landed on, so while each glyph was its own
          target every drag read as a few points from the top of a 15pt letter —
          the rail answered "#" wherever you put your finger. */}
      <View pointerEvents="none" style={{ alignItems: 'center' }}>
        {shown.map((letter) => (
          <Text
            key={letter}
            variant="micro"
            tone={letter === active ? 'brand' : 'faint'}
            style={{ height: RAIL_LETTER_HEIGHT, lineHeight: RAIL_LETTER_HEIGHT }}
          >
            {letter}
          </Text>
        ))}
      </View>
    </View>
  );
}

/**
 * Which heading somebody files under.
 *
 * Anything that is not a letter — a number, an emoji, a name starting with a
 * bracket — goes under `#`, the way every address book does it. Scripts without
 * upper case simply come back unchanged, which is the right answer: Tamil sorts
 * under Tamil.
 */
function bucketOf(name: string): string {
  const first = name.trim().charAt(0);
  if (!first) return '#';
  const upper = first.toLocaleUpperCase();
  return /\p{Letter}/u.test(upper) ? upper : '#';
}

/**
 * Identity for selection. The address first, because that is what actually
 * distinguishes two people called Amma in a family's address book; the name
 * only carries the difference when neither has one, which the loader has
 * already ruled out.
 */
function keyOf(contact: PickedContact): string {
  return `${contact.email ?? ''}|${contact.phone ?? ''}|${contact.name}`;
}

/**
 * A contact card writes a number however the owner typed it.
 *
 * A bare local number is read in the device's own region — the WhatsApp-style
 * default every messaging app on the phone already uses — so the address the
 * picker shows matches the E.164 the server keeps, and a contact already in the
 * group greys out instead of looking new. This is best-effort and never throws:
 * if there is no region to read it in, or the result is not a valid number, the
 * cleaned digits are kept so the person is still invitable (the add path
 * normalises once more, with the group's region, before anything is queued).
 */
function normalisePhone(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9+]/g, '');
  if (cleaned.length < 8) return null;
  try {
    return normaliseContactPhone(cleaned) ?? cleaned;
  } catch {
    return cleaned;
  }
}
