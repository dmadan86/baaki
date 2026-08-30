/**
 * Merge same-person guests into one, on the Friends screen.
 *
 * A guest (ghost) appears once per group, because a name is no proof that the
 * "person1" in one group is the "person1" in another (see the
 * `baaki_people_i_owe` migration). This screen is where the one thing that *is*
 * proof — a person saying "these are the same" — gets recorded. The merge is
 * per-viewer and never rewrites the ledger; each group keeps its own guest and
 * its own balance, and only the Friends aggregation folds them into one name.
 *
 * It is presented as permanent: there is no un-merge, and the screen says so in
 * as many words before the button. Only guests can be picked — a real person is
 * already one identity by their account and must never be folded under a made-up
 * name, which the RPC also enforces.
 *
 * Assigning a device contact only *names* the merged person. It never creates a
 * new guest and never asks which group to add anyone to — the people being
 * merged are already in their groups. If the contact's name matches a guest on
 * the list, that guest is ticked; either way the contact's name becomes the
 * merged name and is held so the invite step below can offer it.
 *
 * After the merge, the person can be invited to the groups they now span. There
 * is no targeted send in this app — invites are one durable join link per group
 * (see `group/[id]/invite`) — so "invite them" here is a sheet that shares that
 * same link for each of the merged person's groups.
 */
import { useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Share,
  TextInput,
  View,
} from 'react-native';

import {
  Avatar,
  Button,
  Callout,
  Card,
  directionalIcon,
  Divider,
  EmptyState,
  IconButton,
  iconSize,
  ListRow,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import {
  ensureGroupJoinToken,
  fetchPeopleBalances,
  fetchPersonGroupBalances,
  groupJoinLink,
  mergeGhosts,
  type PersonBalanceRow,
} from '@/data/api';
import {
  canMerge,
  defaultMergeName,
  isMergeable,
  memberIdsForMerge,
  mergeErrorMessage,
} from '@/data/mergePeople';
import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { PeopleSkeleton } from '@/components/Skeletons';
import { friendlyError } from '@/lib/errors';
import { useSync } from '@/sync';
import { fill, plural, useStrings } from '@/i18n';

/** One group the merged person belongs to, for the post-merge invite sheet. */
interface InviteGroup {
  readonly id: string;
  readonly name: string | null;
  readonly emoji: string | null;
}

export default function MergePeopleScreen() {
  const theme = useTheme();
  // This screen renders under the persistent bottom nav (like friends/contacts),
  // so it needs the tab-bar clearance — the plain screen inset left the Merge
  // button hidden behind the bar, unreachable by scrolling.
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const { flush } = useSync();

  // People pre-picked on the Friends tab (its multiselect merge) arrive as a
  // comma-joined, encoded list of person_keys, plus the name to pre-fill. They
  // seed the selection and name here so this screen opens on the confirm step
  // rather than an empty pick.
  const params = useLocalSearchParams<{ keys?: string; name?: string }>();
  const initialKeys = useMemo(
    () =>
      new Set(
        (typeof params.keys === 'string' ? params.keys : '')
          .split(',')
          // useLocalSearchParams already URL-decodes params, so the keys arrive
          // decoded — decoding again would corrupt any key containing a %.
          .filter((key) => key.length > 0),
      ),
    [params.keys],
  );

  const people = useQuery({ queryKey: ['people', 'balances'], queryFn: fetchPeopleBalances });

  // One selectable row per guest. A guest unsettled in two currencies is two
  // balance rows but one person, so collapse by `person_key`; the first row
  // carries the member id and name the rest of the screen needs.
  const guests = useMemo(() => {
    const byKey = new Map<string, PersonBalanceRow>();
    for (const row of people.data ?? []) {
      if (!isMergeable(row)) continue;
      if (!byKey.has(row.person_key)) byKey.set(row.person_key, row);
    }
    return [...byKey.values()];
  }, [people.data]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initialKeys));
  const [name, setName] = useState(() =>
    decodeURIComponent(typeof params.name === 'string' ? params.name : ''),
  );
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The device contact assigned to name the merge (if any). Held only for its
  // name and to show the "assigned" state — it is never turned into a guest.
  const [pickedContact, setPickedContact] = useState<PickedContact | null>(null);
  const [pickingContact, setPickingContact] = useState(false);

  // The post-merge invite step: the merged person's name and the groups they
  // span, or null while the sheet is closed.
  const [inviteFor, setInviteFor] = useState<{ name: string; groups: InviteGroup[] } | null>(null);
  const [shareBusyId, setShareBusyId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  // Groups snapshot taken the instant before the merge writes — memberships do
  // not change, and the pre-merge person_keys resolve cleanly (a merged key may
  // not), so the invite prompt can list them without another round-trip.
  const pendingInviteGroups = useRef<InviteGroup[]>([]);

  const selectedRows = guests.filter((row) => selected.has(row.person_key));

  const toggle = (personKey: string): void => {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(personKey)) next.delete(personKey);
      else next.add(personKey);
      // Keep the name in step with the pick until the person types their own.
      if (!nameTouched) {
        setName(defaultMergeName(guests.filter((row) => next.has(row.person_key))));
      }
      return next;
    });
  };

  /**
   * A contact was picked. It only names the merge: if its name matches somebody
   * already on this list, that is exactly the recognition this screen is built
   * on — tick them, the same as tapping their row would. Either way the contact
   * becomes the merged name and is held for the invite step. No guest is
   * created, and no group is chosen — the merge is over the people already here.
   */
  const onPickContact = (chosen: readonly PickedContact[]): void => {
    const contact = chosen[0];
    if (!contact) return;
    const needle = contact.name.trim().toLowerCase();
    const matches = guests.filter((row) => row.display_name.trim().toLowerCase() === needle);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of matches) next.add(row.person_key);
      return next;
    });
    setPickedContact(contact);
    // Assigning a contact is naming the merged person: the contact's name wins,
    // and it stops auto-tracking the picks from here on.
    setNameTouched(true);
    setName(contact.name);
    setError(null);
    setPickingContact(false);
  };

  const ready = canMerge(selectedRows) && name.trim().length > 0;
  const nothingToMergeYet = guests.length === 0;

  /** The groups the currently-selected guests span, deduped by group id. */
  const gatherInviteGroups = async (): Promise<InviteGroup[]> => {
    const rows = (
      await Promise.all([...selected].map((key) => fetchPersonGroupBalances(key)))
    ).flat();
    const byId = new Map<string, InviteGroup>();
    for (const row of rows) {
      if (!byId.has(row.group_id)) {
        byId.set(row.group_id, { id: row.group_id, name: row.group_name, emoji: row.cover_emoji });
      }
    }
    return [...byId.values()];
  };

  const merge = useMutation({
    mutationFn: () => mergeGhosts(memberIdsForMerge(selectedRows), name.trim()),
    onSuccess: async () => {
      // The merge is written server-side by the RPC; pull it into the mirror so
      // the now-local Friends list (ADR-005) folds it without waiting for the
      // next background sync. The invalidate keeps this screen's own list fresh.
      await queryClient.invalidateQueries({ queryKey: ['people', 'balances'] });
      void flush();
      const groups = pendingInviteGroups.current;
      // Nothing to invite into (no groups resolved) → this screen is done.
      if (groups.length === 0) {
        router.back();
        return;
      }
      // Ask before sharing anything. Skip closes the screen; Invite opens the
      // per-group share sheet.
      Alert.alert(
        fill(t.mergePeople.invitePromptTitle, { name: name.trim() }),
        t.mergePeople.invitePromptBody,
        [
          { text: t.mergePeople.invitePromptSkip, style: 'cancel', onPress: () => router.back() },
          { text: t.people.invite, onPress: () => setInviteFor({ name: name.trim(), groups }) },
        ],
      );
    },
    onError: (caught) => setError(mergeErrorMessage(caught, t.mergePeople)),
  });

  // Merging is permanent, so the "this can't be undone" warning is a dialog on
  // tap — the person confirms it deliberately — rather than a line they may
  // skim past. Only the confirm proceeds to the write.
  const confirmMerge = (): void => {
    if (!ready || merge.isPending) return;
    Alert.alert(t.mergePeople.warningTitle, t.mergePeople.warningBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.mergePeople.cta,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            // Snapshot the groups before the write, from the pre-merge keys.
            try {
              pendingInviteGroups.current = await gatherInviteGroups();
            } catch {
              pendingInviteGroups.current = [];
            }
            merge.mutate();
          })();
        },
      },
    ]);
  };

  const dismissInvite = (): void => {
    setInviteFor(null);
    router.back();
  };

  /** Share one group's durable join link through the OS share sheet. */
  const shareGroupInvite = async (group: InviteGroup): Promise<void> => {
    setShareBusyId(group.id);
    setInviteError(null);
    try {
      const token = await ensureGroupJoinToken(group.id);
      void flush();
      const label = group.name ?? t.captures.group;
      const message = t.people.shareMessage
        .replace('{group}', label)
        .replace('{link}', groupJoinLink(token));
      await Share.share({ message });
    } catch (caught) {
      setInviteError(friendlyError(caught, t.couldNotSave, 'merge.shareInvite'));
    } finally {
      setShareBusyId(null);
    }
  };

  return (
    <Screen>
      {/* On edge-to-edge Android the resize inset does not always lift the
          content above the keyboard, so the name field's own button can end up
          behind it and the screen reads as "won't scroll to the end". The
          avoider (padding on iOS, resize on Android) keeps the button reachable
          while the keyboard is open. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.mergePeople.title}</Text>
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
          {people.isLoading ? (
            <PeopleSkeleton />
          ) : people.isError ? (
            <EmptyState
              title={t.loadError}
              body={t.loadErrorBody}
              action={
                <Button label={t.retry} variant="secondary" onPress={() => people.refetch()} />
              }
            />
          ) : nothingToMergeYet ? (
            <EmptyState title={t.mergePeople.title} body={t.mergePeople.empty} />
          ) : (
            <>
              {/* The one thing this screen decides: the name the merged person
                  carries on Friends. Editable inline — a plain underlined field
                  with a pencil so it reads as "tap to change." */}
              <View style={{ gap: theme.spacing.xs }}>
                <Text variant="caption" tone="muted">
                  {t.mergePeople.nameLabel}
                </Text>
                <Row
                  style={{
                    alignItems: 'center',
                    gap: theme.spacing.sm,
                    borderBottomWidth: 1,
                    borderBottomColor: theme.color.border,
                  }}
                >
                  <TextInput
                    value={name}
                    onChangeText={(value) => {
                      setNameTouched(true);
                      setName(value);
                    }}
                    editable={selectedRows.length > 0}
                    accessibilityLabel={t.mergePeople.nameLabel}
                    placeholder={t.mergePeople.namePlaceholder}
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      flex: 1,
                      fontSize: 22,
                      fontWeight: '800',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.xs,
                    }}
                  />
                  <Ionicons name="pencil" size={iconSize.md} color={theme.color.textFaint} />
                </Row>
              </View>

              {/* Only the people actually being merged — not the whole roster.
                  Each is removable; the button below assigns a contact name. */}
              <View style={{ gap: theme.spacing.sm }}>
                <Text variant="caption" tone="muted">
                  {selectedRows.length > 0
                    ? plural(locale, selectedRows.length, t.mergePeople.peopleHeader)
                    : t.mergePeople.needTwo}
                </Text>
                {selectedRows.length > 0 ? (
                  <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                    {selectedRows.map((row, index) => (
                      <View key={row.person_key}>
                        <MergeMemberRow
                          name={row.display_name}
                          subtitle={
                            row.group_count === 1
                              ? t.tabs.inOneGroup
                              : plural(locale, row.group_count, t.tabs.acrossGroups)
                          }
                          removeLabel={fill(t.pickers.removeName, { name: row.display_name })}
                          onRemove={() => toggle(row.person_key)}
                        />
                        {index < selectedRows.length - 1 ? <Divider /> : null}
                      </View>
                    ))}
                  </Card>
                ) : null}
              </View>

              {/* Give the merged person a real identity: assign them a device
                  contact. A contact whose name matches a guest ticks it; either
                  way the contact's name becomes the merged name (see
                  onPickContact). No guest is created and no group is chosen. */}
              <Button
                label={
                  pickedContact
                    ? fill(t.mergePeople.assignedTo, { name: pickedContact.name })
                    : t.mergePeople.addPerson
                }
                variant="secondary"
                fullWidth
                disabled={merge.isPending}
                onPress={() => setPickingContact(true)}
                icon={
                  <MaterialCommunityIcons
                    name={pickedContact ? 'account-check-outline' : 'book-account-outline'}
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                }
              />

              {error ? <Callout tone="negative">{error}</Callout> : null}

              {/* The irreversibility is confirmed in a dialog on tap rather than
                  shouted inline — one clear "are you sure, this can't be undone"
                  before anything is written. */}
              <Button
                label={t.mergePeople.cta}
                size="lg"
                fullWidth
                disabled={!ready || merge.isPending}
                onPress={confirmMerge}
              />
              {merge.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Picking a device contact to name the merge. Mounted only while open,
          for the same reason add-person's own contact modal is — a React Native
          Modal keeps its children mounted across a close, so without this gate
          the picker would reopen showing the last pick still ticked. */}
      <Modal
        visible={pickingContact}
        animationType="slide"
        onRequestClose={() => setPickingContact(false)}
      >
        <Screen edges={['top', 'bottom']} inModal>
          <View
            style={{
              flex: 1,
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.md,
              gap: theme.spacing.lg,
            }}
          >
            <Row style={{ paddingTop: theme.spacing.md }}>
              <IconButton label={t.common.close} onPress={() => setPickingContact(false)}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text variant="heading">{t.tabs.fromContacts}</Text>
              </View>
              <View style={{ width: 44 }} />
            </Row>
            <ContactPicker single onConfirm={onPickContact} confirmVerb={t.misc.continueWith} />
          </View>
        </Screen>
      </Modal>

      {/* After the merge: share a durable join link for each group the merged
          person spans. There is no targeted send in this app — each group has
          one link (see group/[id]/invite) — so inviting them to "all their
          groups" is one Share per group here. */}
      <Modal visible={inviteFor !== null} animationType="slide" onRequestClose={dismissInvite}>
        <Screen edges={['top', 'bottom']} inModal>
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.xl,
              gap: theme.spacing.lg,
            }}
            showsVerticalScrollIndicator={false}
          >
            <Row style={{ paddingTop: theme.spacing.md }}>
              <IconButton label={t.common.close} onPress={dismissInvite}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text variant="heading">{t.mergePeople.inviteSheetTitle}</Text>
              </View>
              <View style={{ width: 44 }} />
            </Row>

            <Text variant="caption" tone="muted">
              {fill(t.mergePeople.inviteSheetBody, { name: inviteFor?.name ?? '' })}
            </Text>

            {inviteFor ? (
              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {inviteFor.groups.map((group, index) => (
                  <View key={group.id}>
                    <ListRow
                      title={group.name ?? t.captures.group}
                      leading={
                        <Avatar
                          name={group.name ?? t.captures.group}
                          emoji={group.emoji ?? undefined}
                          size={40}
                        />
                      }
                      onPress={shareBusyId ? undefined : () => void shareGroupInvite(group)}
                      trailing={
                        shareBusyId === group.id ? (
                          <ActivityIndicator color={theme.color.brand} />
                        ) : (
                          <Ionicons
                            name="share-outline"
                            size={iconSize.md}
                            color={theme.color.brand}
                            accessibilityLabel={t.mergePeople.inviteShare}
                          />
                        )
                      }
                    />
                    {index < inviteFor.groups.length - 1 ? <Divider /> : null}
                  </View>
                ))}
              </Card>
            ) : null}

            {inviteError ? <Callout tone="negative">{inviteError}</Callout> : null}

            <Button label={t.common.done} size="lg" fullWidth onPress={dismissInvite} />
          </ScrollView>
        </Screen>
      </Modal>
    </Screen>
  );
}

/**
 * One person in the merge selection: their name, where their balance sits, and
 * a remove control. No avatar — the identity being built is the name at the top,
 * so the rows stay a compact, glanceable list rather than a stack of circles.
 * Removing is the only edit here — there is no "unpick to unmerged," only "not
 * part of this merge," so it reads as a delete, not a toggle.
 */
function MergeMemberRow({
  name,
  subtitle,
  removeLabel,
  onRemove,
}: {
  name: string;
  subtitle: string;
  removeLabel: string;
  onRemove: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Row style={{ paddingVertical: theme.spacing.sm, alignItems: 'center', minHeight: 44 }}>
      <View style={{ flex: 1 }}>
        <Text variant="subheading" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <IconButton label={removeLabel} onPress={onRemove}>
        <Ionicons name="close-circle" size={iconSize.xl} color={theme.color.textFaint} />
      </IconButton>
    </Row>
  );
}
