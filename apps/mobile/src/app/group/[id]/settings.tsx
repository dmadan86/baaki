import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, ScrollView, Switch, TextInput, View } from 'react-native';

import {
  Button,
  Card,
  EmptyState,
  IconButton,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { useGroup, useGroupLedger, useLeaveGroup, useUpdateGroup } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

const EMOJI = ['🏖️', '🏠', '💜', '🎉', '✈️', '🍽️', '⛰️', '🎓', '👥'];

export default function GroupSettingsScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const updateGroup = useUpdateGroup(groupId);
  const leaveGroup = useLeaveGroup(groupId);

  const [name, setName] = useState(group.data?.name ?? '');
  const [status, setStatus] = useState<string | null>(null);

  if (!group.data) {
    return (
      <Screen>
        <EmptyState title="Group not found" body="It may have been archived." />
      </Screen>
    );
  }

  const settled = ledger.myBalance === 0n;

  const leave = (): void => {
    if (!settled) {
      Alert.alert(
        'Settle up first',
        'You still have a balance in this group. Leaving now would strand it — settle up, then leave.',
      );
      return;
    }
    Alert.alert('Leave this group?', 'Your past expenses stay in the group history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          if (!ledger.myMemberId) return;
          leaveGroup.mutate(ledger.myMemberId, { onSuccess: () => router.replace('/') });
        },
      },
    ]);
  };

  const archive = (): void => {
    Alert.alert(
      'Archive this group?',
      'It disappears from your list but nothing is deleted, and anyone can unarchive it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          onPress: () =>
            updateGroup.mutate(
              { archived_at: new Date().toISOString() },
              { onSuccess: () => router.replace('/') },
            ),
        },
      ],
    );
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
            <Text variant="heading">Group settings</Text>
            <Text variant="micro" tone="muted">
              {group.data.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <Text variant="caption" tone="muted">
            Name
          </Text>
          <Row>
            <TextInput
              value={name}
              onChangeText={setName}
              accessibilityLabel="Group name"
              style={{
                flex: 1,
                fontSize: 20,
                fontWeight: '700',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
            <Button
              label="Save"
              size="sm"
              variant="secondary"
              disabled={!name.trim() || name.trim() === group.data.name}
              onPress={() =>
                updateGroup.mutate({ name: name.trim() }, { onSuccess: () => setStatus('Saved') })
              }
            />
          </Row>

          <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {EMOJI.map((option) => (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ selected: group.data?.cover_emoji === option }}
                accessibilityLabel={`Icon ${option}`}
                onPress={() => updateGroup.mutate({ cover_emoji: option })}
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: theme.radius.pill,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor:
                    group.data?.cover_emoji === option
                      ? theme.color.brandSoft
                      : theme.color.surfaceMuted,
                }}
              >
                <Text variant="subheading">{option}</Text>
              </Pressable>
            ))}
          </Row>
        </Card>

        {/* ADR-009: simplification is presentation only — the pairwise ledger
            underneath is untouched, so this is safe to toggle at any time. */}
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">Simplify debts</Text>
              <Text variant="caption" tone="muted">
                Suggest the fewest payments that settle the group. The real who-owes-whom ledger is
                never rewritten.
              </Text>
            </View>
            <Switch
              value={group.data.simplify_debts}
              onValueChange={(value) => updateGroup.mutate({ simplify_debts: value })}
              trackColor={{ true: theme.color.brand, false: theme.color.border }}
              accessibilityLabel="Simplify debts"
            />
          </Row>
        </Card>

        <View>
          <SectionHeader title={t.members} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            <ListRow
              title={`${members.data?.length ?? 0} ${t.members}`}
              subtitle="Add people, rename, set UPI IDs"
              leading={<Ionicons name="people-outline" size={22} color={theme.color.textMuted} />}
              onPress={() => router.push(`/group/${groupId}/members`)}
              trailing={<Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />}
            />
            <View style={{ height: 1, backgroundColor: theme.color.border }} />
            <ListRow
              title="Invite people"
              subtitle="Share a link — no install needed to join"
              leading={<Ionicons name="share-outline" size={22} color={theme.color.textMuted} />}
              onPress={() => router.push(`/group/${groupId}/invite`)}
              trailing={<Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />}
            />
          </Card>
        </View>

        {status ? (
          <Text variant="caption" tone="positive">
            {status}
          </Text>
        ) : null}

        <View style={{ gap: theme.spacing.md }}>
          <Button label="Archive group" variant="ghost" fullWidth onPress={archive} />
          <Button label="Leave group" variant="ghost" fullWidth onPress={leave} />
          {!settled ? (
            <Text variant="micro" tone="faint" align="center">
              You can leave once your balance here is zero.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
