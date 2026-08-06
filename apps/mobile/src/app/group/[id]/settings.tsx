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

import { GroupPhoto, pickGroupPhoto } from '@/components/GroupPhoto';
import { TripDates } from '@/components/TripDates';
import { removeGroupPhoto, uploadGroupPhoto } from '@/data/api';
import { useGroup, useGroupLedger, useLeaveGroup, useUpdateGroup } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { groupLabel } from '@/data/types';

const EMOJI = ['🏖️', '🏠', '💜', '🎉', '✈️', '🍽️', '⛰️', '🎓', '👥'];

export default function GroupSettingsScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const updateGroup = useUpdateGroup(groupId);
  const leaveGroup = useLeaveGroup(groupId);

  const [name, setName] = useState(group.data?.name ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const changePhoto = async (): Promise<void> => {
    const picked = await pickGroupPhoto();
    if (!picked) return;
    setStatus(null);
    setUploading(true);
    try {
      await uploadGroupPhoto({ groupId, base64: picked.base64, mimeType: picked.mimeType });
      await group.refetch();
      setStatus('Photo updated');
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUploading(false);
    }
  };

  const dropPhoto = async (): Promise<void> => {
    setStatus(null);
    try {
      await removeGroupPhoto(groupId, group.data?.photo_path ?? null);
      await group.refetch();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    }
  };

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
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ gap: theme.spacing.lg }}>
            <GroupPhoto
              photoPath={group.data.photo_path}
              emoji={group.data.cover_emoji}
              size={72}
              busy={uploading}
              onPress={() => void changePhoto()}
            />
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                Name (optional)
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                accessibilityLabel="Group name"
                placeholder={groupLabel(null, members.data ?? [], profile?.id)}
                placeholderTextColor={theme.color.textFaint}
                style={{
                  fontSize: 20,
                  fontWeight: '700',
                  color: theme.color.text,
                  paddingVertical: theme.spacing.sm,
                }}
              />
            </View>
          </Row>

          <Row style={{ gap: theme.spacing.sm }}>
            <Button
              label="Save name"
              size="sm"
              variant="secondary"
              // Clearing the field is a real choice: the group goes back to
              // being named after the people in it.
              disabled={name.trim() === (group.data.name ?? '')}
              onPress={() =>
                updateGroup.mutate(
                  { name: name.trim() || null },
                  { onSuccess: () => setStatus('Saved') },
                )
              }
            />
            {group.data.photo_path ? (
              <Button
                label="Remove photo"
                size="sm"
                variant="ghost"
                onPress={() => void dropPhoto()}
              />
            ) : null}
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

        <TripDates
          group={group.data}
          locale={locale}
          onChange={(patch) => updateGroup.mutate(patch, { onSuccess: () => setStatus('Saved') })}
        />

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

        <View>
          <SectionHeader title="Bring things in" />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            <ListRow
              title="Import from messages"
              subtitle="Paste bank messages — read on this phone, confirmed by you"
              leading={
                <Ionicons name="chatbox-ellipses-outline" size={22} color={theme.color.textMuted} />
              }
              onPress={() => router.push(`/group/${groupId}/import/sms`)}
              trailing={<Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />}
            />
            <View style={{ height: 1, backgroundColor: theme.color.border }} />
            <ListRow
              title="Import a Splitwise export"
              subtitle="Bring an old group's history across"
              leading={
                <Ionicons name="document-text-outline" size={22} color={theme.color.textMuted} />
              }
              onPress={() => router.push(`/group/${groupId}/import/csv`)}
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
