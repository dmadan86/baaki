import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { ContactPicker } from '@/components/ContactPicker';
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

  const addPicked = (picked: {
    name: string;
    email: string | null;
    phone: string | null;
  }): void => {
    setError(null);
    addGhost.mutate(
      { name: picked.name, email: picked.email, phone: picked.phone },
      {
        onSuccess: () => setBrowsing(false),
        onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
      },
    );
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
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
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
            <View style={{ height: 320 }}>
              <ContactPicker onPick={addPicked} existing={alreadyAdded} />
            </View>
          ) : null}
          <Text variant="micro" tone="faint">
            A name alone is enough — nobody needs the app, or an email, to be part of the split. An
            address just means you can send them the link. When they join later they can claim
            everything already recorded under their name.
          </Text>
          {addGhost.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}
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
