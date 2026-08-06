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

import { useEffect, useMemo, useState } from 'react';
import * as Contacts from 'expo-contacts';
import { FlatList, Pressable, TextInput, View } from 'react-native';

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

type Permission = 'asking' | 'granted' | 'denied';

export function ContactPicker({ onPick, existing }: ContactPickerProps): React.JSX.Element {
  const theme = useTheme();
  const [permission, setPermission] = useState<Permission>('asking');
  const [contacts, setContacts] = useState<PickedContact[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // expo-contacts has no web implementation and throws rather than
      // no-opping there, which would otherwise leave this stuck on "looking
      // through your contacts…" forever with nothing said about why.
      let data: Awaited<ReturnType<typeof Contacts.getContactsAsync>>['data'];
      try {
        const { status } = await Contacts.requestPermissionsAsync();
        if (cancelled) return;
        if (status !== 'granted') {
          setPermission('denied');
          return;
        }

        // Only these three fields. Asking for less than the platform offers is
        // the cheapest privacy measure there is.
        ({ data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.Name, Contacts.Fields.Emails, Contacts.Fields.PhoneNumbers],
        }));
      } catch {
        if (!cancelled) setPermission('denied');
        return;
      }
      if (cancelled) return;

      setContacts(
        data
          .map((contact) => ({
            name: contact.name?.trim() ?? '',
            email: contact.emails?.[0]?.email?.trim().toLowerCase() ?? null,
            phone: normalisePhone(contact.phoneNumbers?.[0]?.number ?? null),
          }))
          // Somebody with neither an email nor a number cannot be invited, so
          // showing them would only be an invitation to tap and be refused.
          .filter((contact) => contact.name && (contact.email || contact.phone))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setPermission('granted');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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

  if (permission === 'asking') {
    return (
      <Card>
        <Text variant="caption" tone="muted">
          Looking through your contacts…
        </Text>
      </Card>
    );
  }

  if (permission === 'denied') {
    return (
      <Card style={{ gap: theme.spacing.sm }}>
        <Text variant="caption" tone="muted">
          Baaki cannot see your contacts. You can still add people by typing a name, an email or a
          number — nothing about a group needs your address book.
        </Text>
        <Button
          label="Open settings"
          variant="ghost"
          onPress={() => void Contacts.presentFormAsync(null, null).catch(() => undefined)}
        />
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
