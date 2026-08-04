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

import { useAddGhostMember, useGroup, useGroupLedger } from '@/data/hooks';
import { displayName, isGhost, vpaOf } from '@/data/types';
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
  const [error, setError] = useState<string | null>(null);

  const currency = group.data?.default_currency ?? 'INR';
  const ghosts = (members.data ?? []).filter(isGhost);

  const add = (): void => {
    const name = ghostName.trim();
    if (!name) return;
    setError(null);
    addGhost.mutate(name, {
      onSuccess: () => setGhostName(''),
      onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
    });
  };

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
              {group.data?.name}
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
            Add someone by name
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
              disabled={!ghostName.trim() || addGhost.isPending}
              onPress={add}
            />
          </Row>
          <Text variant="micro" tone="faint">
            They do not need the app to be part of the split. When they join later they can claim
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
