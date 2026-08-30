import { useState, type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, ScrollView, TextInput, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ChipRow,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  Toggle,
  useTheme,
  useTabBarClearance,
} from '@waves/ui';

import { GroupPhoto } from '@/components/GroupPhoto';
import { type PickedContact } from '@/components/ContactPicker';
import { friendlyError } from '@/lib/errors';
import { pickGroupPhoto } from '@/lib/image';
import { requestContacts } from '@/lib/contactPickerBridge';
import { isPhoneCountryError } from '@/lib/phone';
import { CountryRow } from '@/components/CountryPicker';
import { CoverEmojiPicker } from '@/components/CoverEmojiPicker';
import { InfoDisclosure } from '@/components/InfoDisclosure';
import { TripDates } from '@/components/TripDates';
import { photoGateParam, photoGateStatus, photoTapAction } from '@/lib/groupPhotoGate';
import { canUploadGroupPhoto, removeGroupPhoto, uploadGroupPhoto } from '@/data/api';
import {
  useAddGhostMember,
  useDeleteGroup,
  useGroup,
  useGroupLedger,
  useLeaveGroup,
  useUpdateGroup,
} from '@/data/hooks';
import { fill, plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useFavorites } from '@/lib/favorites';
import { displayName, groupLabel, GroupType, isGhost, vpaOf } from '@/data/types';

// Same chip icons the create screen wears, so changing a group's kind looks
// like the same control that first set it.
const iconFor =
  (name: keyof typeof Ionicons.glyphMap) =>
  // eslint-disable-next-line react/display-name
  (color: string): ReactNode => <Ionicons name={name} size={iconSize.base} color={color} />;

export default function GroupSettingsScreen() {
  const theme = useTheme();
  // This screen renders under the persistent bottom nav, so it must pad for the
  // bar, not just the system inset — with the plain inset the last row (Leave
  // group, below Archive) sat behind the bar and could not be reached.
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const updateGroup = useUpdateGroup(groupId);
  const leaveGroup = useLeaveGroup(groupId);
  const deleteGroup = useDeleteGroup(groupId);
  const { isFavorite, toggle: toggleFavorite } = useFavorites();
  const addGhost = useAddGhostMember(groupId);

  // A name is enough to start splitting with someone (ADR-006). Adding by name
  // or from the phone's contacts both live here; the members screen keeps the
  // extra email/phone address field for the case that needs it.
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addingContacts, setAddingContacts] = useState(false);
  const addMember = (): void => {
    // The button disables while pending, but the keyboard's "done"
    // (onSubmitEditing) can still fire — guard so a second tap can't queue the
    // same person twice.
    if (addGhost.isPending) return;
    const person = newName.trim();
    if (!person) return;
    setAddError(null);
    addGhost.mutate(
      { name: person },
      {
        // Only clear the field if it still holds what we submitted, so a name
        // typed for the next person isn't wiped when this add lands.
        onSuccess: () => setNewName((current) => (current.trim() === person ? '' : current)),
        onError: (caught) =>
          setAddError(friendlyError(caught, t.misc.couldNotAddGeneric, 'groupSettings.addGhost')),
      },
    );
  };

  /**
   * Several people ticked out of the phone's contacts, one call each — the same
   * add path the members screen uses (the server takes one member per request,
   * so batching would only hide which of them failed). A failure part-way does
   * not undo the ones already in: the honest report is which names did not make
   * it, keeping the first refusal's words so the message can say why.
   */
  const addPicked = async (people: readonly PickedContact[]): Promise<void> => {
    setAddError(null);
    setAddingContacts(true);
    const failed: string[] = [];
    let reason: string | null = null;
    for (const person of people) {
      try {
        await addGhost.mutateAsync({
          name: person.name,
          email: person.email,
          phone: person.phone,
        });
      } catch (caught) {
        failed.push(person.name);
        const message = isPhoneCountryError(caught)
          ? t.people.phoneNeedsCountryCode
          : friendlyError(caught, t.misc.tryAgainMoment, 'groupSettings.addPicked');
        if (!reason) reason = message;
      }
    }
    setAddingContacts(false);
    if (failed.length === 0) return;
    setAddError(fill(t.misc.couldNotAddSome, { reason: reason ?? '' }));
  };

  // Addresses already in the group, so the picker greys them out rather than
  // letting somebody add the same person twice. The server would collapse it
  // anyway — this just makes the reason visible.
  const alreadyAdded = new Set(
    (members.data ?? []).flatMap((member) =>
      [member.invite_email, member.invite_phone].filter((value): value is string => Boolean(value)),
    ),
  );

  // Opens the address book on its own screen rather than unfolding it inline —
  // a thousand-name list needs the whole height (ADR-006: no book is uploaded).
  // The ticked people come back through the bridge into `addPicked`.
  const openContactPicker = (): void => {
    requestContacts({
      initial: [],
      existing: alreadyAdded,
      onPicked: (people) => void addPicked(people),
    });
    router.push('/contact-picker');
  };

  const [name, setName] = useState(group.data?.name ?? '');
  // Seed the name field once the group query resolves (and re-seed if the
  // loaded group changes) — synced in render, the app's idiom for following a
  // value until the user edits it, rather than a setState-in-effect.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (group.data && seededId !== group.data.id) {
    setSeededId(group.data.id);
    setName(group.data.name ?? '');
  }
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // A group photo is a paid feature; the cover emoji is free. The group may
  // carry a photo if anyone in it is paid (or it holds a pass) — a server-side
  // question, since one member cannot read another's subscription.
  const photoGate = useQuery({
    queryKey: ['photoGate', groupId],
    queryFn: () => canUploadGroupPhoto(photoGateParam(groupId)),
    enabled: groupId.length > 0,
  });
  const photoStatus = photoGateStatus(photoGate.data, photoGate.isLoading);

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
      setStatus(friendlyError(caught, t.couldNotSave, 'groupSettings.changePhoto'));
    } finally {
      setUploading(false);
    }
  };

  // Tapping the photo: pick when allowed, otherwise point at the upgrade screen.
  // Removing an existing photo is never gated — a group that loses its paying
  // member can always fall back to an icon.
  const onPhotoPress = (): void => {
    const action = photoTapAction(photoStatus);
    if (action === 'pick') void changePhoto();
    else if (action === 'showLockedHint') router.push('/settings/upgrade');
  };

  const dropPhoto = async (): Promise<void> => {
    setStatus(null);
    try {
      await removeGroupPhoto(groupId, group.data?.photo_path ?? null);
      await group.refetch();
    } catch (caught) {
      setStatus(friendlyError(caught, t.couldNotSave, 'groupSettings.dropPhoto'));
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
  const currency = group.data.default_currency;

  // Deleting a group is an admin power (like changing roles). A non-admin never
  // sees the button; the RPC refuses it regardless (NOT_ADMIN).
  const isAdmin = (members.data ?? []).some(
    (member) => member.profile_id === profile?.id && member.role === 'admin',
  );

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

  // Delete removes the group for everyone (A49), so it is gated harder than
  // archive: the WHOLE group must be square first (not just my own balance), and
  // it asks before doing something there is no undo for. The server re-checks
  // both admin and settled — this is the courteous front of that boundary.
  const confirmDelete = (): void => {
    if (!ledger.groupSettled) {
      Alert.alert(t.group.settleFirst, t.group.settleAllFirstBody);
      return;
    }
    Alert.alert(t.group.deleteQuestion, t.group.deleteBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.group.delete,
        style: 'destructive',
        onPress: () => {
          if (deleteGroup.isPending) return;
          deleteGroup.mutate(undefined, {
            onSuccess: () => router.replace('/'),
            onError: (caught) => {
              // The two coded refusals carry a `code` (set in api.deleteGroup);
              // show their localized line directly. Anything else is unknown and
              // goes through friendlyError, which never echoes raw backend text.
              const code = (caught as { code?: string } | null)?.code;
              const body =
                code === 'NOT_SETTLED'
                  ? t.group.settleAllFirstBody
                  : code === 'NOT_ADMIN'
                    ? t.group.deleteAdminOnly
                    : friendlyError(caught, t.misc.tryAgainMoment, 'groupSettings.delete');
              Alert.alert(t.group.deleteGroup, body);
            },
          });
        },
      },
    ]);
  };

  return (
    <Screen>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Ionicons name="settings-outline" size={iconSize.md} color={theme.color.brand} />
            <Text variant="heading">{t.group.settings}</Text>
          </Row>
          <Text variant="micro" tone="muted">
            {groupLabel(group.data, members.data ?? [])}
          </Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ gap: theme.spacing.lg }}>
            <GroupPhoto
              photoPath={group.data.photo_path}
              emoji={group.data.cover_emoji}
              size={72}
              busy={uploading}
              onPress={onPhotoPress}
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

        {/* The kind of group. Only changes the label, cover default and trip
            affordances — nothing already recorded moves. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.extras.whatKindOfGroup}
          </Text>
          <ChipRow<GroupType>
            // The column is NOT NULL DEFAULT 'other' on the server, so a missing
            // value here only means a mirror row that predates this field syncing
            // — fall back to that same default so the assigned chip always lights.
            value={group.data.type ?? GroupType.Other}
            onChange={(type) =>
              updateGroup.mutate({ type }, { onSuccess: () => setStatus(t.account.saved) })
            }
            options={[
              { value: GroupType.Trip, label: t.extras.typeTrip, icon: iconFor('airplane') },
              { value: GroupType.Home, label: t.extras.typeHome, icon: iconFor('home') },
              { value: GroupType.Couple, label: t.extras.typeCouple, icon: iconFor('heart') },
              { value: GroupType.Event, label: t.extras.typeEvent, icon: iconFor('sparkles') },
              {
                value: GroupType.Friends,
                label: t.extras.typeFriends,
                icon: iconFor('people-circle'),
              },
              { value: GroupType.Other, label: t.extras.typeOther, icon: iconFor('people') },
            ]}
          />
        </View>

        {/* Decides which payment rails the settle screen offers, and what a new
            expense starts in. Nothing already recorded changes. */}
        <CountryRow
          countryCode={group.data.country_code}
          onChange={(country_code) =>
            updateGroup.mutate({ country_code }, { onSuccess: () => setStatus(t.account.saved) })
          }
        />

        {/* Trip dates and their nudges only mean anything on a trip, so the
            section appears only for that type and disappears the moment the
            group is changed to another kind. Nothing recorded is touched — the
            stored dates simply stop being shown until it is a trip again. */}
        {(group.data.type ?? GroupType.Other) === GroupType.Trip ? (
          <TripDates
            group={group.data}
            locale={locale}
            onChange={(patch) =>
              updateGroup.mutate(patch, { onSuccess: () => setStatus(t.account.saved) })
            }
          />
        ) : null}

        {/* ADR-009: simplification is presentation only — the pairwise ledger
            underneath is untouched, so this is safe to toggle at any time. */}
        <Card>
          <InfoDisclosure
            title={t.group.simplifyDebts}
            info={t.group.simplifyDebtsBody}
            right={
              <Toggle
                value={group.data.simplify_debts}
                onValueChange={(value) => updateGroup.mutate({ simplify_debts: value })}
                accessibilityLabel={t.group.simplifyDebts}
              />
            }
          />
        </Card>

        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={plural(locale, members.data?.length ?? 0, t.memberCount)} />

          {/* The roster in the settings screen itself, so seeing who is in the
              group no longer costs a tap through to the members screen. Each row
              still opens the person; the members screen keeps the extra
              email/phone add field. */}
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {(members.data ?? []).map((member, index) => (
              <View key={member.id}>
                <ListRow
                  title={displayName(member, profile?.id)}
                  subtitle={isGhost(member) ? t.notJoinedYet : (vpaOf(member) ?? t.misc.noUpiYet)}
                  leading={<Avatar name={displayName(member)} ghost={isGhost(member)} />}
                  onPress={() => router.push(`/group/${groupId}/member/${member.id}`)}
                  trailing={
                    <Row style={{ gap: theme.spacing.sm }}>
                      {member.role === 'admin' && !isGhost(member) ? (
                        <Badge label={t.people.admin} tone="brand" />
                      ) : null}
                      <MoneyText
                        amount={ledger.balances.get(member.id) ?? 0n}
                        currency={currency}
                        locale={locale}
                        mode="balance"
                      />
                    </Row>
                  }
                />
                {index < (members.data?.length ?? 0) - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>

          {/* Add a member before the share row — the common case (someone with a
              name, not a link) shouldn't require the invite flow. */}
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="muted">
              {t.people.addSomeone}
            </Text>
            <Row style={{ gap: theme.spacing.sm }}>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder={t.people.namePlaceholder}
                placeholderTextColor={theme.color.textFaint}
                accessibilityLabel={t.common.name}
                onSubmitEditing={addMember}
                // Both add flows drive the one `addGhost` mutation and the one
                // `addError`; gate each on the other so a name typed mid-batch
                // cannot race the contacts loop and clobber its result.
                editable={!addGhost.isPending && !addingContacts}
                returnKeyType="done"
                style={{
                  flex: 1,
                  fontSize: 17,
                  fontWeight: '600',
                  color: theme.color.text,
                  paddingVertical: theme.spacing.sm,
                }}
              />
              <Button
                label={t.add}
                size="sm"
                variant="secondary"
                disabled={!newName.trim() || addGhost.isPending || addingContacts}
                onPress={addMember}
              />
            </Row>

            {/* The fuller add — the same address-book picker the members screen
                and new-group flow open, so adding somebody already in your phone
                no longer means retyping their name here. */}
            <Button
              label={t.people.browseContacts}
              variant="ghost"
              disabled={addingContacts || addGhost.isPending}
              onPress={openContactPicker}
            />
            {addingContacts ? <ActivityIndicator color={theme.color.brand} /> : null}
            {addError ? <Callout tone="negative">{addError}</Callout> : null}
          </Card>

          {/* Share a link for anyone who should join themselves. */}
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            <ListRow
              title={t.group.invitePeople}
              subtitle={t.group.invitePeopleHint}
              leading={
                <Ionicons name="share-outline" size={iconSize.xl} color={theme.color.textMuted} />
              }
              onPress={() => router.push(`/group/${groupId}/invite`)}
              trailing={
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={iconSize.md}
                  color={theme.color.textFaint}
                />
              }
            />
          </Card>

          {/* Make another group from this one, and star it so it sits at the top
              of the "start from a group" list. Both live here because both are
              about this group as a template, not about its ledger. */}
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            <ListRow
              title={t.clone.duplicateTitle}
              subtitle={t.clone.duplicateHint}
              leading={
                <Ionicons name="copy-outline" size={iconSize.xl} color={theme.color.textMuted} />
              }
              onPress={() => router.push(`/new-group?from=${groupId}`)}
              trailing={
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={iconSize.md}
                  color={theme.color.textFaint}
                />
              }
            />
            <ListRow
              title={t.clone.favoriteTitle}
              subtitle={t.clone.favoriteHint}
              leading={
                <Ionicons
                  name={isFavorite(groupId) ? 'star' : 'star-outline'}
                  size={iconSize.xl}
                  color={isFavorite(groupId) ? theme.color.brand : theme.color.textMuted}
                />
              }
              onPress={() => toggleFavorite(groupId)}
              trailing={
                <Toggle
                  value={isFavorite(groupId)}
                  onValueChange={() => toggleFavorite(groupId)}
                  accessibilityLabel={t.clone.favoriteTitle}
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
          <Button label={t.group.archiveGroup} variant="ghostDanger" fullWidth onPress={archive} />
          <Button label={t.group.leaveGroup} variant="ghostDanger" fullWidth onPress={leave} />
          {/* Deleting drops the group for everyone, so it is an admin-only power
              and sits below leave/archive as the most final of the three. */}
          {isAdmin ? (
            <Button
              label={t.group.deleteGroup}
              variant="ghostDanger"
              fullWidth
              disabled={deleteGroup.isPending}
              onPress={confirmDelete}
            />
          ) : null}
          {!settled ? (
            <Text variant="micro" tone="muted" align="center">
              {t.group.leaveWhenZero}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
