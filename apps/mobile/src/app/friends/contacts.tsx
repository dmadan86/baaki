/**
 * Browsing the phone's address book to add somebody to a group.
 *
 * The address book never leaves the device — `ContactPicker` reads it, searches
 * it and shows it locally, and only the people ticked are sent anywhere.
 * There is deliberately no "which of my contacts already use Baaki" here: that
 * feature requires uploading the whole book, and it turns an address book into
 * a membership oracle for anybody who later reaches the server (ADR-006).
 *
 * A person in Baaki always belongs to a group, because a debt is between people
 * *about something*. So picking contacts asks the one question that has to be
 * answered — which group — rather than inventing floating "friends" that owe
 * nobody anything. The whole lot goes into one group: picking six people for a
 * trip and then answering "which group?" six times is the same answer six
 * times.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import {
  Avatar,
  AvatarStack,
  Button,
  Callout,
  Card,
  directionalIcon,
  Divider,
  IconButton,
  iconSize,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { fill, plural, useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';

import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { addGhostMember, fetchGroups } from '@/data/api';
import { groupLabel } from '@/data/types';

export default function ContactsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();

  const [picked, setPicked] = useState<readonly PickedContact[]>([]);
  const [added, setAdded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });

  /**
   * Everybody picked, into the one group, one call each.
   *
   * A failure part-way leaves the earlier ones added, and says whose name did
   * not make it. Adding five people is five separate acts, not a transaction:
   * throwing away four good ones because the fifth had a number the server
   * would not take is a worse answer than telling you about the fifth.
   */
  const add = useMutation({
    mutationFn: async ({
      groupId,
      contacts,
    }: {
      groupId: string;
      contacts: readonly PickedContact[];
    }) => {
      const failed: string[] = [];
      for (const contact of contacts) {
        try {
          await addGhostMember(groupId, contact.name, {
            email: contact.email,
            phone: contact.phone,
          });
        } catch (caught) {
          failed.push(contact.name);
          // Report each real failure for its side effect (the raw server message
          // goes to Sentry); its return is discarded — the user is not shown a
          // transport error, but whose names did not make it, below.
          friendlyError(caught, t.misc.couldNotAddGeneric, 'contacts.add');
        }
      }
      // A partial failure is a normal outcome, not an exception: the names that
      // did not make it ride back in the result, so nothing raw is thrown and
      // onError is left for a genuine transport failure of the whole call.
      return { added: contacts.length - failed.length, failed };
    },
    onSuccess: async ({ added, failed }, { groupId }) => {
      // Only announce a count when at least one landed; on a total failure the
      // error below carries the whole story.
      setAdded(added > 0 ? added : null);
      setPicked([]);
      setError(failed.length > 0 ? fill(t.misc.couldNotAdd, { names: failed.join(', ') }) : null);
      await queryClient.invalidateQueries({ queryKey: ['members', groupId] });
      await queryClient.invalidateQueries({ queryKey: ['people', 'balances'] });
    },
    onError: (caught: unknown) => {
      // Reached only when the whole operation fails unexpectedly — a raw
      // transport or server error — so friendlyError with the generic fallback
      // is exactly right here (per-contact failures are handled in the loop).
      setError(friendlyError(caught, t.misc.couldNotAddGeneric, 'contacts.add'));
    },
  });

  return (
    // The picker anchors a button to the bottom of the screen, so this one has
    // to hold the bottom inset too. Without it the button lands under the
    // navigation bar — invisible on a phone with three buttons rather than a
    // gesture pill, which is the case an emulator does not show you.
    <Screen edges={['top', 'bottom']}>
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.md,
          gap: theme.spacing.lg,
        }}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.misc.fromYourContacts}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {picked.length > 0 ? (
          <ChooseGroup
            contacts={picked}
            groups={groups.data ?? []}
            busy={add.isPending}
            error={error}
            onCancel={() => {
              setPicked([]);
              setError(null);
            }}
            onChoose={(groupId) => add.mutate({ groupId, contacts: picked })}
          />
        ) : (
          <>
            {added !== null ? (
              <Card style={{ backgroundColor: theme.color.brandSoft }}>
                <Row style={{ gap: theme.spacing.sm }}>
                  <Ionicons name="checkmark-circle" size={iconSize.lg} color={theme.color.brand} />
                  <Text variant="caption" tone="brand" style={{ flex: 1 }}>
                    {fill(t.misc.contactsAdded, {
                      count: plural(locale, added, t.misc.peopleCount),
                    })}
                  </Text>
                </Row>
              </Card>
            ) : null}
            <ContactPicker onConfirm={setPicked} confirmVerb={t.misc.continueWith} />
          </>
        )}
      </View>
    </Screen>
  );
}

/**
 * Which group this person joins.
 *
 * Groups only — no "add without a group" — because a member with no group has
 * nothing to owe or be owed, and would sit in the app looking like a mistake.
 */
function ChooseGroup({
  contacts,
  groups,
  busy,
  error,
  onCancel,
  onChoose,
}: {
  contacts: readonly PickedContact[];
  groups: readonly { id: string; name: string | null; cover_emoji: string | null }[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onChoose: (groupId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const only = contacts.length === 1 ? contacts[0] : undefined;

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: clearance, gap: theme.spacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <Card style={{ gap: theme.spacing.xs }}>
        <Row style={{ gap: theme.spacing.md }}>
          {only ? (
            <Avatar name={only.name} size={44} />
          ) : (
            <AvatarStack names={contacts.map((contact) => contact.name)} size={36} />
          )}
          <View style={{ flex: 1 }}>
            <Text variant="subheading" numberOfLines={1}>
              {only ? only.name : plural(locale, contacts.length, t.misc.peopleCount)}
            </Text>
            <Text variant="micro" tone="muted" numberOfLines={2}>
              {only
                ? (only.email ?? only.phone ?? t.misc.noAddress)
                : contacts.map((contact) => contact.name).join(', ')}
            </Text>
          </View>
        </Row>
      </Card>

      <SectionHeader title={only ? t.misc.addToWhichGroup : t.misc.addThemAllToWhichGroup} />

      {groups.length === 0 ? (
        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.extras.noGroupsYet}
          </Text>
          <Button
            label={t.misc.startAGroup}
            variant="secondary"
            onPress={() => router.push('/new-group')}
          />
        </Card>
      ) : (
        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          {groups.map((group, index) => (
            <View key={group.id}>
              <ListRow
                title={groupLabel(group)}
                leading={
                  <Avatar
                    name={groupLabel(group)}
                    emoji={group.cover_emoji ?? undefined}
                    size={40}
                  />
                }
                onPress={busy ? undefined : () => onChoose(group.id)}
                trailing={
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.md}
                    color={theme.color.textFaint}
                  />
                }
              />
              {index < groups.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </Card>
      )}

      {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
      {error ? <Callout tone="negative">{error}</Callout> : null}

      <Text variant="micro" tone="muted">
        {t.extras.ghostShareNote}
      </Text>

      <Button label={t.misc.pickDifferentPeople} variant="ghost" onPress={onCancel} />
    </ScrollView>
  );
}
