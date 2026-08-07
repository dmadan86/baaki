import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  directionalIcon,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { useAddGhostMember, useGroup, useGroupLedger } from '@/data/hooks';
import { displayName, groupLabel, isGhost, vpaOf } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function MembersScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const addGhost = useAddGhostMember(groupId);

  const [ghostName, setGhostName] = useState('');
  const [ghostContact, setGhostContact] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currency = group.data?.default_currency ?? 'INR';
  const ghosts = (members.data ?? []).filter(isGhost);

  /**
   * One field for the address, whichever kind it is. Asking somebody to first
   * declare "email or phone?" and then type it is a question the text itself
   * already answers.
   */
  const contactOf = (value: string): { email?: string; phone?: string } => {
    const trimmed = value.trim();
    if (!trimmed) return {};
    return trimmed.includes('@') ? { email: trimmed } : { phone: trimmed };
  };

  const add = (): void => {
    const name = ghostName.trim();
    const contact = contactOf(ghostContact);
    if (!name && !contact.email && !contact.phone) return;
    setError(null);
    addGhost.mutate(
      { name, ...contact },
      {
        onSuccess: () => {
          setGhostName('');
          setGhostContact('');
        },
        onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
      },
    );
  };

  /**
   * Several people at once, one call each — the server takes one member per
   * request and batching them here would only hide which of them failed.
   *
   * They are added in sequence rather than in parallel because a batch of
   * simultaneous writes to the same group races the balance triggers for no
   * benefit; nobody picks contacts fast enough for the wait to show.
   *
   * A failure part-way does not undo the ones already in. Adding somebody is
   * not a transaction — it is five separate acts — so the honest report is
   * which names did not make it, not a rollback nobody asked for.
   */
  const addPicked = async (people: readonly PickedContact[]): Promise<void> => {
    setError(null);
    setAdding(true);
    const failed: string[] = [];
    let last = '';
    for (const person of people) {
      try {
        await addGhost.mutateAsync({
          name: person.name,
          email: person.email,
          phone: person.phone,
        });
      } catch (caught) {
        failed.push(person.name);
        last = caught instanceof Error ? caught.message : String(caught);
      }
    }
    setAdding(false);
    if (failed.length === 0) {
      setBrowsing(false);
      return;
    }
    setError(`Could not add ${failed.join(', ')}: ${last}`);
  };

  // Contacts already used, so the picker can grey them out instead of letting
  // somebody add the same person twice. The server would collapse it anyway —
  // this just makes the reason visible.
  const alreadyAdded = new Set(
    (members.data ?? []).flatMap((member) =>
      [member.invite_email, member.invite_phone].filter((value): value is string => Boolean(value)),
    ),
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.members}</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <IconButton label="Invite" onPress={() => router.push(`/group/${groupId}/invite`)}>
            <Ionicons name="share-outline" size={18} color={theme.color.brand} />
          </IconButton>
        </Row>

        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          {(members.data ?? []).map((member, index) => (
            <View key={member.id}>
              <ListRow
                title={displayName(member, profile?.id)}
                subtitle={isGhost(member) ? t.notJoinedYet : (vpaOf(member) ?? 'no UPI ID yet')}
                leading={<Avatar name={displayName(member)} ghost={isGhost(member)} />}
                onPress={() => router.push(`/group/${groupId}/member/${member.id}`)}
                trailing={
                  <MoneyText
                    amount={ledger.balances.get(member.id) ?? 0n}
                    currency={currency}
                    locale={locale}
                    mode="balance"
                  />
                }
              />
              {index < (members.data?.length ?? 0) - 1 ? (
                <View style={{ height: 1, backgroundColor: theme.color.border }} />
              ) : null}
            </View>
          ))}
        </Card>

        {/* ADR-006: a name is enough to start splitting with someone. */}
        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            Add someone
          </Text>
          <Row>
            <TextInput
              value={ghostName}
              onChangeText={setGhostName}
              placeholder="Rahul"
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel="Name"
              onSubmitEditing={add}
              style={{
                flex: 1,
                fontSize: 17,
                fontWeight: '600',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
            <Button
              label="Add"
              size="sm"
              variant="secondary"
              disabled={(!ghostName.trim() && !ghostContact.trim()) || addGhost.isPending}
              onPress={add}
            />
          </Row>

          <TextInput
            value={ghostContact}
            onChangeText={setGhostContact}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="Email or phone, if you want to send them the link"
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel="Email or phone number"
            onSubmitEditing={add}
            style={{
              fontSize: 15,
              color: theme.color.text,
              paddingVertical: theme.spacing.sm,
            }}
          />

          <Button
            label={browsing ? 'Hide contacts' : 'Browse my contacts'}
            variant="ghost"
            onPress={() => setBrowsing((open) => !open)}
          />

          {browsing ? (
            // Tall enough that the letter rail has something to aim at — a
            // 320pt window turns a thousand contacts back into a peephole.
            <View style={{ height: 480 }}>
              <ContactPicker
                onConfirm={(people) => void addPicked(people)}
                existing={alreadyAdded}
                busy={adding}
              />
            </View>
          ) : null}
          <Text variant="micro" tone="faint">
            A name alone is enough — nobody needs the app, or an email, to be part of the split. An
            address just means you can send them the link. When they join later they can claim
            everything already recorded under their name.
          </Text>
          {addGhost.isPending || adding ? <ActivityIndicator color={theme.color.brand} /> : null}
          {error ? (
            <Text variant="caption" tone="negative">
              {error}
            </Text>
          ) : null}
        </Card>

        {ghosts.length > 0 ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <Badge label={`${ghosts.length} yet to join`} />
            <Text
              variant="caption"
              tone="brand"
              onPress={() => router.push(`/group/${groupId}/invite`)}
            >
              Send an invite link
            </Text>
          </Row>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
