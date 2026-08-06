/**
 * Browsing the phone's address book to add somebody to a group.
 *
 * The address book never leaves the device — `ContactPicker` reads it, searches
 * it and shows it locally, and only the one person tapped is sent anywhere.
 * There is deliberately no "which of my contacts already use Baaki" here: that
 * feature requires uploading the whole book, and it turns an address book into
 * a membership oracle for anybody who later reaches the server (ADR-006).
 *
 * A person in Baaki always belongs to a group, because a debt is between people
 * *about something*. So picking a contact asks the one question that has to be
 * answered — which group — rather than inventing a floating "friend" that owes
 * nobody anything.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  Divider,
  IconButton,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { addGhostMember, fetchGroups } from '@/data/api';
import { groupLabel } from '@/data/types';

export default function ContactsScreen(): React.JSX.Element {
  const theme = useTheme();
  const queryClient = useQueryClient();

  const [picked, setPicked] = useState<PickedContact | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });

  const add = useMutation({
    mutationFn: async ({ groupId, contact }: { groupId: string; contact: PickedContact }) =>
      addGhostMember(groupId, contact.name, { email: contact.email, phone: contact.phone }),
    onSuccess: async (_id, { groupId, contact }) => {
      setAdded(contact.name);
      setPicked(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['members', groupId] });
      await queryClient.invalidateQueries({ queryKey: ['people', 'balances'] });
    },
    onError: (caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    },
  });

  return (
    <Screen>
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">From your contacts</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {picked ? (
          <ChooseGroup
            contact={picked}
            groups={groups.data ?? []}
            busy={add.isPending}
            error={error}
            onCancel={() => {
              setPicked(null);
              setError(null);
            }}
            onChoose={(groupId) => add.mutate({ groupId, contact: picked })}
          />
        ) : (
          <>
            {added ? (
              <Card style={{ backgroundColor: theme.color.brandSoft }}>
                <Text variant="caption" tone="brand">
                  {added} added. Pick somebody else, or go back.
                </Text>
              </Card>
            ) : null}
            <ContactPicker onPick={setPicked} />
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
  contact,
  groups,
  busy,
  error,
  onCancel,
  onChoose,
}: {
  contact: PickedContact;
  groups: readonly { id: string; name: string | null; cover_emoji: string | null }[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onChoose: (groupId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: theme.spacing.xxxl, gap: theme.spacing.lg }}
      showsVerticalScrollIndicator={false}
    >
      <Card style={{ gap: theme.spacing.xs }}>
        <Row style={{ gap: theme.spacing.md }}>
          <Avatar name={contact.name} size={44} />
          <View style={{ flex: 1 }}>
            <Text variant="subheading">{contact.name}</Text>
            <Text variant="micro" tone="faint">
              {contact.email ?? contact.phone ?? 'No address'}
            </Text>
          </View>
        </Row>
      </Card>

      <SectionHeader title="Add to which group?" />

      {groups.length === 0 ? (
        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            You have no groups yet. A person belongs to a group in Baaki, because a debt is always
            about something — a trip, a flat, a dinner.
          </Text>
          <Button
            label="Start a group"
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
                  <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />
                }
              />
              {index < groups.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </Card>
      )}

      {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
      {error ? (
        <Text variant="caption" tone="negative">
          {error}
        </Text>
      ) : null}

      <Text variant="micro" tone="faint">
        They do not need the app. Their share is recorded under their name, and if they join later
        with this email or number they claim everything already sitting there.
      </Text>

      <Button label="Pick somebody else" variant="ghost" onPress={onCancel} />
    </ScrollView>
  );
}
