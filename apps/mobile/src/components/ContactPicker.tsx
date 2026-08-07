/**
 * Picking somebody out of the phone's contacts.
 *
 * The address book never leaves the device. Contacts are read, searched and
 * displayed locally; only the one person you tap is sent anywhere, and only as
 * the name and address needed to invite them.
 *
 * This is worth being deliberate about, because the usual version of this
 * feature uploads the whole book to find "who else already uses Baaki". That
 * turns an address book into a membership oracle — it tells the server, and
 * anyone who later reaches the server, which of your contacts use the app.
 * Baaki has no such endpoint and this component does not want one: an invite
 * link works whether or not the person has ever heard of us (ADR-006).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync } from 'expo-contacts';
import { AppState, FlatList, Linking, Pressable, TextInput, View } from 'react-native';

import { Avatar, Button, Card, EmptyState, Row, Text, useTheme } from '@baaki/ui';

export interface PickedContact {
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

interface ContactPickerProps {
  onPick: (contact: PickedContact) => void;
  /** Already in the group — shown greyed rather than hidden, so it is obvious why. */
  existing?: ReadonlySet<string>;
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

export function ContactPicker({ onPick, existing }: ContactPickerProps): React.JSX.Element {
  const theme = useTheme();
  const [access, setAccess] = useState<Access>('asking');
  const [contacts, setContacts] = useState<PickedContact[]>([]);
  const [query, setQuery] = useState('');
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

  return (
    <View style={{ gap: theme.spacing.md, flex: 1 }}>
      <Card style={{ gap: theme.spacing.xs }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          accessibilityLabel="Search contacts"
          placeholder="Search contacts"
          placeholderTextColor={theme.color.textFaint}
          style={{ fontSize: 16, color: theme.color.text, paddingVertical: theme.spacing.sm }}
        />
      </Card>

      <Text variant="micro" tone="faint">
        Only the person you pick is sent to Baaki. Your contacts stay on this phone.
      </Text>

      {matches.length === 0 ? (
        <EmptyState
          title="Nobody here"
          body={
            query ? 'No contact matches that.' : 'None of your contacts has an email or number.'
          }
        />
      ) : (
        <FlatList
          data={matches}
          keyExtractor={(contact, index) => `${contact.email ?? contact.phone}-${index}`}
          renderItem={({ item }) => {
            const already = Boolean(
              (item.email && existing?.has(item.email)) ||
              (item.phone && existing?.has(item.phone)),
            );
            return (
              <Pressable
                onPress={() => !already && onPick(item)}
                accessibilityRole="button"
                accessibilityLabel={already ? `${item.name}, already added` : `Add ${item.name}`}
                style={{ opacity: already ? 0.45 : 1, paddingVertical: theme.spacing.sm }}
              >
                <Row style={{ gap: theme.spacing.md }}>
                  <Avatar name={item.name} size={40} />
                  <View style={{ flex: 1 }}>
                    <Text variant="body">{item.name}</Text>
                    <Text variant="micro" tone="faint">
                      {already ? 'Already in this group' : (item.email ?? item.phone ?? '')}
                    </Text>
                  </View>
                </Row>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
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
