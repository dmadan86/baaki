import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, ScrollView, TextInput, View } from 'react-native';

import {
  Button,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
  Toggle,
  useTheme,
} from '@baaki/ui';

import { GroupPhoto } from '@/components/GroupPhoto';
import { pickGroupPhoto } from '@/lib/image';
import { CountryRow } from '@/components/CountryPicker';
import { CoverEmojiPicker } from '@/components/CoverEmojiPicker';
import { TripDates } from '@/components/TripDates';
import { removeGroupPhoto, uploadGroupPhoto } from '@/data/api';
import { useGroup, useGroupLedger, useLeaveGroup, useUpdateGroup } from '@/data/hooks';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { groupLabel } from '@/data/types';

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
      setStatus(t.group.photoUpdated);
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
        <EmptyState title={t.group.notFound} body={t.group.notFoundArchived} />
      </Screen>
    );
  }

  const settled = ledger.myBalance === 0n;

  const leave = (): void => {
    if (!settled) {
      Alert.alert(t.group.settleFirst, t.group.settleFirstBody);
      return;
    }
    Alert.alert(t.group.leaveQuestion, t.group.leaveBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.group.leave,
        style: 'destructive',
        onPress: () => {
          if (!ledger.myMemberId) return;
          leaveGroup.mutate(ledger.myMemberId, { onSuccess: () => router.replace('/') });
        },
      },
    ]);
  };

  const archive = (): void => {
    Alert.alert(t.group.archiveQuestion, t.group.archiveBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.group.archive,
        onPress: () =>
          updateGroup.mutate(
            { archived_at: new Date().toISOString() },
            { onSuccess: () => router.replace('/') },
          ),
      },
    ]);
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
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.group.settings}</Text>
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
                {t.group.nameOptional}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                accessibilityLabel={t.group.groupName}
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

          {/* The cover is set two ways from here: the photo by tapping the
              picture above, and the icon by the picker — which now opens a wide,
              scrollable set instead of a fixed nine crammed into the card. */}
          <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
            <Button
              label={t.group.saveName}
              size="sm"
              variant="secondary"
              // Clearing the field is a real choice: the group goes back to
              // being named after the people in it.
              disabled={name.trim() === (group.data.name ?? '')}
              onPress={() =>
                updateGroup.mutate(
                  { name: name.trim() || null },
                  { onSuccess: () => setStatus(t.account.saved) },
                )
              }
            />
            <CoverEmojiPicker
              value={group.data.cover_emoji}
              onChange={(emoji) => updateGroup.mutate({ cover_emoji: emoji })}
            />
            {group.data.photo_path ? (
              <Button
                label={t.group.removePhoto}
                size="sm"
                variant="ghost"
                onPress={() => void dropPhoto()}
              />
            ) : null}
          </Row>
        </Card>

        {/* Decides which payment rails the settle screen offers, and what a new
            expense starts in. Nothing already recorded changes. */}
        <CountryRow
          countryCode={group.data.country_code}
          onChange={(country_code) =>
            updateGroup.mutate({ country_code }, { onSuccess: () => setStatus(t.account.saved) })
          }
        />

        <TripDates
          group={group.data}
          locale={locale}
          onChange={(patch) =>
            updateGroup.mutate(patch, { onSuccess: () => setStatus(t.account.saved) })
          }
        />

        {/* ADR-009: simplification is presentation only — the pairwise ledger
            underneath is untouched, so this is safe to toggle at any time. */}
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">{t.group.simplifyDebts}</Text>
              <Text variant="caption" tone="muted">
                {t.group.simplifyDebtsBody}
              </Text>
            </View>
            <Toggle
              value={group.data.simplify_debts}
              onValueChange={(value) => updateGroup.mutate({ simplify_debts: value })}
              accessibilityLabel={t.group.simplifyDebts}
            />
          </Row>
        </Card>

        <View>
          <SectionHeader title={t.members} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            <ListRow
              title={plural(locale, members.data?.length ?? 0, t.memberCount)}
              subtitle={t.group.membersHint}
              leading={<Ionicons name="people-outline" size={22} color={theme.color.textMuted} />}
              onPress={() => router.push(`/group/${groupId}/members`)}
              trailing={
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={18}
                  color={theme.color.textFaint}
                />
              }
            />
            <View style={{ height: 1, backgroundColor: theme.color.border }} />
            <ListRow
              title={t.group.invitePeople}
              subtitle={t.group.invitePeopleHint}
              leading={<Ionicons name="share-outline" size={22} color={theme.color.textMuted} />}
              onPress={() => router.push(`/group/${groupId}/invite`)}
              trailing={
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={18}
                  color={theme.color.textFaint}
                />
              }
            />
          </Card>
        </View>

        <View>
          <SectionHeader title={t.group.bringThingsIn} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            <ListRow
              title={t.group.importMessages}
              subtitle={t.group.importMessagesHint}
              leading={
                <Ionicons name="chatbox-ellipses-outline" size={22} color={theme.color.textMuted} />
              }
              onPress={() => router.push(`/group/${groupId}/import/sms`)}
              trailing={
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={18}
                  color={theme.color.textFaint}
                />
              }
            />
            <View style={{ height: 1, backgroundColor: theme.color.border }} />
            <ListRow
              title={t.group.importSplitwise}
              subtitle={t.group.importSplitwiseHint}
              leading={
                <Ionicons name="document-text-outline" size={22} color={theme.color.textMuted} />
              }
              onPress={() => router.push(`/group/${groupId}/import/csv`)}
              trailing={
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={18}
                  color={theme.color.textFaint}
                />
              }
            />
          </Card>
        </View>

        {status ? (
          <Text variant="caption" tone="positive">
            {status}
          </Text>
        ) : null}

        <View style={{ gap: theme.spacing.md }}>
          <Button label={t.group.archiveGroup} variant="ghost" fullWidth onPress={archive} />
          <Button label={t.group.leaveGroup} variant="ghost" fullWidth onPress={leave} />
          {!settled ? (
            <Text variant="micro" tone="faint" align="center">
              {t.group.leaveWhenZero}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
