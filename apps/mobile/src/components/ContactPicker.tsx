/**
 * Picking people out of the phone's contacts.
 *
 * The address book never leaves the device. Contacts are read, searched and
 * displayed locally; only the people you tick are sent anywhere, and only as
 * the name and address needed to invite them.
 *
 * This is worth being deliberate about, because the usual version of this
 * feature uploads the whole book to find "who else already uses Baaki". That
 * turns an address book into a membership oracle — it tells the server, and
 * anyone who later reaches the server, which of your contacts use the app.
 * Baaki has no such endpoint and this component does not want one: an invite
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

import { Avatar, Button, Card, EmptyState, Row, Text, useTheme } from '@baaki/ui';

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
  /** The verb on the confirm button. The count and noun are added here. */
  confirmVerb?: string;
  /** Disables confirming while the caller is still writing the last lot away. */
  busy?: boolean;
}

/**
 * `denied` is the person's answer. `unavailable` is ours — the address book
 * could not be read for a reason that has nothing to do with them.
 *
 * These used to be one state, and the whole feature died of it: in SDK 57 the
 * old `Contacts.getContactsAsync` throws on every call, so a phone that had
 * just granted permission was told "Baaki cannot see your contacts" and offered
 * a settings screen where the switch was already on. A catch that turns every
 * failure into the same sentence does not just lose the reason — it prints a
 * confident lie.
 */
type Access = 'asking' | 'granted' | 'denied' | 'unavailable';

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
  confirmVerb = 'Add',
  busy = false,
}: ContactPickerProps): React.JSX.Element {
  const theme = useTheme();
  const [access, setAccess] = useState<Access>('asking');
  const [contacts, setContacts] = useState<PickedContact[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlyMap<string, PickedContact>>(new Map());
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
      if (!cancelled.current) setAccess('unavailable');
      return;
    }
    if (cancelled.current) return;
    if (!granted) {
      setAccess('denied');
      return;
    }

    let rows: Awaited<ReturnType<typeof Contact.getAllDetails<typeof FIELDS>>>;
    try {
      rows = await Contact.getAllDetails(FIELDS);
    } catch {
      if (!cancelled.current) setAccess('unavailable');
      return;
    }
    if (cancelled.current) return;

    setContacts(
      rows
        .map((row) => ({
          name: (row.fullName ?? [row.givenName, row.familyName].filter(Boolean).join(' ')).trim(),
          email: row.emails?.[0]?.address?.trim().toLowerCase() ?? null,
          phone: normalisePhone(row.phones?.[0]?.number ?? null),
        }))
        // Somebody with neither an email nor a number cannot be invited, so
        // showing them would only be an invitation to tap and be refused.
        .filter((contact) => contact.name && (contact.email || contact.phone))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAccess('granted');
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
   * Baaki and starting it again was the missing step.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && access === 'denied') void load();
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

  if (access === 'asking') {
    return (
      <Card>
        <Text variant="caption" tone="muted">
          Looking through your contacts…
        </Text>
      </Card>
    );
  }

  if (access === 'denied') {
    return (
      <Card style={{ gap: theme.spacing.sm }}>
        <Text variant="caption" tone="muted">
          Baaki cannot see your contacts. You can still add people by typing a name, an email or a
          number — nothing about a group needs your address book.
        </Text>
        {/* `Contacts.presentFormAsync` used to be here, which opens a form for
            creating a *new* contact — not the permission screen the label
            promises. This is the one that goes where it says. */}
        <Button
          label="Open settings"
          variant="ghost"
          onPress={() => void Linking.openSettings().catch(() => undefined)}
        />
      </Card>
    );
  }

  if (access === 'unavailable') {
    return (
      <Card style={{ gap: theme.spacing.sm }}>
        <Text variant="caption" tone="muted">
          Baaki could not read the address book on this phone. Nothing is wrong with your
          permissions — add people by typing a name, an email or a number instead.
        </Text>
        <Button label="Try again" variant="ghost" onPress={() => void load()} />
      </Card>
    );
  }

  const chosen = [...picked.values()];

  return (
    <View style={{ gap: theme.spacing.md, flex: 1 }}>
      <View
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
        <Ionicons name="search" size={18} color={theme.color.textFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          accessibilityLabel="Search contacts"
          // The phone's own contacts app puts the count here rather than the
          // word "search", and it answers the first question somebody has when
          // they open a list this long: is it all of them?
          placeholder={`${contacts.length} contacts`}
          placeholderTextColor={theme.color.textFaint}
          style={{ flex: 1, fontSize: 16, color: theme.color.text, paddingVertical: 0 }}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={18} color={theme.color.textFaint} />
          </Pressable>
        ) : null}
      </View>

      {chosen.length > 0 ? <PickedStrip chosen={chosen} onRemove={toggle} /> : null}

      {matches.length === 0 ? (
        <EmptyState
          title="Nobody here"
          body={
            query ? 'No contact matches that.' : 'None of your contacts has an email or number.'
          }
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
              stickyHeaderIndices={sections.sticky}
              // Headings and people are different shapes; telling the list so
              // lets it recycle each against its own kind instead of throwing
              // away a row every time a letter goes by.
              getItemType={(entry) => (isHeading(entry) ? 'heading' : 'person')}
              keyExtractor={(entry, index) =>
                isHeading(entry) ? `letter-${entry.letter}` : `${keyOf(entry)}-${index}`
              }
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
                    selected={picked.has(key)}
                    onPress={() => toggle(key, item)}
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

      <Text variant="micro" tone="faint">
        Only the people you pick are sent to Baaki. Your contacts stay on this phone.
      </Text>

      <Button
        label={
          chosen.length === 0
            ? 'Nobody picked yet'
            : `${confirmVerb} ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}`
        }
        fullWidth
        disabled={chosen.length === 0 || busy}
        onPress={() => onConfirm(chosen)}
      />
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
  onPress,
}: {
  contact: PickedContact;
  already: boolean;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const inset = theme.spacing.lg + 40 + theme.spacing.md;

  return (
    <Pressable
      onPress={already ? undefined : onPress}
      disabled={already}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: already }}
      accessibilityLabel={already ? `${contact.name}, already added` : contact.name}
      style={({ pressed }) => ({
        opacity: already ? 0.45 : 1,
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
          <Text variant="micro" tone="faint" numberOfLines={1}>
            {already ? 'Already in this group' : (contact.email ?? contact.phone ?? '')}
          </Text>
        </View>
        <Ionicons
          name={selected ? 'checkmark-circle' : 'ellipse-outline'}
          size={24}
          color={selected ? theme.color.brand : theme.color.border}
        />
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
          accessibilityLabel={`Remove ${contact.name}`}
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
              <Ionicons name="close" size={10} color={theme.color.surface} />
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
    const letter = shown[index];
    if (letter === undefined || letter === active) return;
    setActive(letter);
    onSeek(letter);
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
      accessibilityLabel="Jump to a letter"
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
 * A contact card writes a number however the owner typed it. Keep only digits
 * and a leading plus; a number with no country code is returned as-is and the
 * server refuses it, rather than this guessing +91 for somebody's friend
 * abroad — a trip is exactly when foreign numbers turn up.
 */
function normalisePhone(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9+]/g, '');
  return cleaned.length >= 8 ? cleaned : null;
}
