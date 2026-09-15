import { Fragment, useState, type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Platform, ScrollView, TextInput, View } from 'react-native';

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

import { type CurrencyCode } from '@waves/core';

import { GroupPhoto } from '@/components/GroupPhoto';
import { type PickedContact } from '@/components/ContactPicker';
import { offerFromOtherGroups } from '@/lib/addFromAnotherGroup';
import { requestAddFromAnotherGroup } from '@/lib/addFromAnotherGroupBridge';
import { addSomeoneRoutes, type AddSomeoneRoute } from '@/lib/addSomeoneRoutes';
import { friendlyError } from '@/lib/errors';
import { groupDeleteWarning, orderDebtsForWarning } from '@/lib/groupDeleteWarning';
import { GROUP_DESCRIPTION_MAX, normaliseGroupDescription } from '@/lib/groupDescription';
import { pickGroupPhoto } from '@/lib/image';
import { requestContacts } from '@/lib/contactPickerBridge';
import { router } from '@/lib/navigation';
import { isPhoneCountryError } from '@/lib/phone';
import { CountryRow } from '@/components/CountryPicker';
import { GroupCoverSheet } from '@/components/CoverEmojiPicker';
import { InfoDisclosure } from '@/components/InfoDisclosure';
import { TripDates } from '@/components/TripDates';
import { SettlesInRow, TripRatesCard } from '@/components/TripRates';
import { photoGateParam, photoGateStatus } from '@/lib/groupPhotoGate';
import { canEditSettlementCurrency } from '@/lib/currencyChoices';
import { canUploadGroupPhoto, removeGroupPhoto, uploadGroupPhoto } from '@/data/api';
import {
  useAddGhostMember,
  useDeleteGroup,
  useGroup,
  useGroupFxRates,
  useGroupLedger,
  useGroups,
  useLeaveGroup,
  useUpdateGroup,
} from '@/data/hooks';
import { useKnownContacts } from '@/data/knownContacts';
import { fill, plural, useStrings } from '@/i18n';
import { useViewerId } from '@/lib/auth';
import { useFavorites } from '@/lib/favorites';
import { useBlockedUsers } from '@/data/blocked';
import { useDialog } from '@/lib/dialog';
import { type DialogRow } from '@/lib/dialogQueue';
import {
  displayName,
  groupLabel,
  GroupType,
  isBlockedMember,
  isGhost,
  isViewer,
  payableAt,
} from '@/data/types';

// Same chip icons the create screen wears, so changing a group's kind looks
// like the same control that first set it.
const iconFor =
  (name: keyof typeof Ionicons.glyphMap) =>
  // eslint-disable-next-line react/display-name
  (color: string): ReactNode => <Ionicons name={name} size={iconSize.base} color={color} />;

/**
 * The round mark on one of the three exit rows, and the whole of how they are
 * told apart at a glance.
 *
 * One shape, three weights, in the order the consequence grows: `quiet` is the
 * brand chip every ordinary row in the app wears, because archiving is an
 * ordinary, reversible thing; `soft` is the same chip in the negative colour,
 * for the act that ends your own membership; `loud` fills with that colour and
 * cuts the glyph out of it in the card's own surface, for the one act that
 * cannot be taken back. Red is spent sparingly on purpose — if it were on all
 * three it would distinguish none of them.
 */
function ExitChip({
  icon,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tone: 'quiet' | 'soft' | 'loud';
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: theme.radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor:
          tone === 'quiet'
            ? theme.color.brandSoft
            : tone === 'soft'
              ? theme.color.negativeSoft
              : theme.color.negative,
      }}
    >
      <Ionicons
        name={icon}
        size={iconSize.lg}
        // On the filled chip the glyph is cut from the card behind it — white
        // on the light red, near-black on the dark one — which clears the 3:1
        // a graphic needs in both schemes where white alone would not.
        color={
          tone === 'quiet'
            ? theme.color.brand
            : tone === 'soft'
              ? theme.color.negative
              : theme.color.surface
        }
      />
    </View>
  );
}

export default function GroupSettingsScreen() {
  const theme = useTheme();
  // This screen renders under the persistent bottom nav, so it must pad for the
  // bar, not just the system inset — with the plain inset the last of the exit
  // rows sat behind the bar and could not be reached.
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { confirm, notify } = useDialog();
  // Why the group is still here. It sits under the delete row rather than
  // fading, because a refused delete leaves the screen looking exactly as it
  // did and a line that is gone in three seconds is a tap that did nothing.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const tripRates = useGroupFxRates(groupId);

  // Identity for "which member am I", from the session rather than the profile:
  // the session is on the device at launch, the profile is a fetch that lands
  // later, and in the gap `profile?.id` is undefined — which `isViewer` refuses
  // to match, but only if it is given the right thing to compare. See
  // `lib/auth.useViewerId`.
  const viewerId = useViewerId();

  const { group, members, expenses } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, viewerId);
  const updateGroup = useUpdateGroup(groupId);
  const leaveGroup = useLeaveGroup(groupId);
  const deleteGroup = useDeleteGroup(groupId);
  const { isFavorite, toggle: toggleFavorite } = useFavorites();
  const { blockedIds } = useBlockedUsers();
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

  /**
   * The ways in, named: what each row of the "add someone" section offers and
   * where it leads. The list itself is decided in `lib/addSomeoneRoutes` so it
   * can be read — and tested — without a renderer.
   *
   * `addressBook` is the device question, not the permission one. Web has no
   * `expo-contacts` at all, so that row would be a door into an apology and is
   * dropped; a phone that *can* be asked keeps the row whatever the answer
   * turns out to be, because the answer is the picker's to get.
   */
  /**
   * Follow one of them.
   *
   * The contacts row leaves its intent with the bridge before navigating,
   * because the picker is a pushed route and cannot hand a value back the way
   * an inline callback could; the ticked people come back through `addPicked`.
   * It also means the OS permission sheet is never raised cold — it is asked on
   * the way into the screen this row has just opened, and a refusal is answered
   * there, leaving every other way in this section exactly as it was.
   *
   * The address book is read on the device and stays on it: only the people
   * ticked are sent anywhere, and only as the name and address needed to invite
   * them (ADR-006).
   */
  const openRoute = (route: AddSomeoneRoute): void => {
    if (route.key === 'contacts') {
      requestContacts({
        initial: [],
        existing: alreadyAdded,
        onPicked: (people) => void addPicked(people),
      });
    }
    // Same shape, same reason: the picker is a pushed route and cannot hand a
    // value back, so the intent is left with the bridge before navigating and
    // the ticked people arrive through `addPicked` like every other way in.
    if (route.key === 'fromAnotherGroup') {
      requestAddFromAnotherGroup({ groupId, onPicked: (people) => void addPicked(people) });
    }
    router.push(route.href as never);
  };

  /**
   * The other route in from `lib/addFromAnotherGroup`: the people already in
   * your other groups — the same five friends, a new trip. `addSomeoneRoutes`
   * (PR #784) names this gap and deliberately returns no row for it because
   * nothing built it yet; this is that flow, wired in ahead of that screen's
   * merge (see the header comment on `lib/addFromAnotherGroup` for the full
   * shape and the identity/consent decisions behind it).
   *
   * Whether the row is worth drawing at all is decided the same way that
   * module decides everything else — run the real selection, not a proxy
   * like "is in more than one group", since a lone other group made up of
   * real-account members alone (nobody to copy) must not offer a door that
   * opens onto an empty list.
   */
  const { membersByGroup } = useKnownContacts();
  const otherGroups = useGroups();
  const sourceGroups = (otherGroups.data ?? []).map((sourceGroup) => {
    const raw = membersByGroup.get(sourceGroup.id) ?? [];
    return {
      groupId: sourceGroup.id,
      groupLabel: groupLabel(sourceGroup, raw, viewerId),
      members: raw.map((member) => ({
        memberId: member.id,
        profileId: member.profile_id,
        name: displayName(member, viewerId),
        email: member.invite_email ?? null,
        phone: member.invite_phone ?? null,
        leftAt: member.left_at,
      })),
    };
  });
  const fromAnotherGroupOffer = offerFromOtherGroups({
    currentGroupId: groupId,
    viewerProfileId: viewerId,
    groups: sourceGroups,
  });

  // Leaves its intent with the bridge, same as the contacts row — the ticked
  // people come back through the very same `addPicked`, so a batch from
  // another group fails and reports exactly the way a batch from contacts
  // already does (see `addPicked` above).
  const routes = addSomeoneRoutes({
    groupId,
    t,
    addressBook: Platform.OS !== 'web',
    otherGroupPeople: fromAnotherGroupOffer.length > 0,
  });

  const [name, setName] = useState(group.data?.name ?? '');
  // Seed the name field once the group query resolves (and re-seed if the
  // loaded group changes) — synced in render, the app's idiom for following a
  // value until the user edits it, rather than a setState-in-effect.
  const [seededId, setSeededId] = useState<string | null>(null);
  // The name last handed to the server, so a rename is not sent twice while the
  // group query is still catching up (see `commitName`). Cleared alongside the
  // field whenever a different group is loaded into this screen.
  const [sentName, setSentName] = useState<string | null>(null);
  // The description follows the name exactly: same seeding, same
  // commit-on-blur, same guard against the double trigger. It is the other half
  // of what the group says about itself, so it is edited the same way rather
  // than acquiring a Save button of its own.
  const [description, setDescription] = useState(group.data?.description ?? '');
  // `undefined` is "nothing sent yet", and it has to be distinguishable from
  // the `null` a cleared description normalises to — otherwise the very first
  // clear would compare equal to "nothing sent" and be swallowed, and the
  // description would be unclearable. The name field gets away with a plain
  // null here only because its empty value is '' rather than null.
  const [sentDescription, setSentDescription] = useState<string | null | undefined>(undefined);
  if (group.data && seededId !== group.data.id) {
    setSeededId(group.data.id);
    setName(group.data.name ?? '');
    setSentName(null);
    setDescription(group.data.description ?? '');
    setSentDescription(undefined);
  }
  const [status, setStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // Whether the name is being edited (the rule under it lights up) and whether
  // the cover sheet is open. Both are about the identity row at the top.
  const [naming, setNaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);

  /**
   * Save the name, if it has actually changed.
   *
   * There used to be a Save button beside the field, which asked for a tap to
   * confirm a change the person had already made and then sat disabled for the
   * rest of the screen's life. Committing on blur and on "done" is the same
   * act with one fewer control. The first guard compares against what the group
   * already carries rather than against emptiness, because clearing the field
   * is a real choice: the group goes back to being named after the people in
   * it, and that is a change worth sending.
   *
   * The second guard is about the two triggers overlapping. Pressing "done"
   * both submits and blurs, so this runs twice in a row, and the second run
   * still sees the old name on `group.data` because the mutation has not come
   * back yet — without `sentName` the same rename would be queued twice.
   */
  const commitName = (): void => {
    const next = name.trim();
    if (next === (group.data?.name ?? '') || next === sentName) return;
    setSentName(next);
    updateGroup.mutate({ name: next || null }, { onSuccess: () => setStatus(t.account.saved) });
  };

  /**
   * Save the description, on the same two triggers and with the same two
   * guards as the name above.
   *
   * The comparison is against the normalised form on both sides, not against
   * the raw field: a description that differs from the stored one only by the
   * whitespace somebody left at the end is not a change, and queueing it would
   * put a mutation on the wire and a "Saved" on the screen for nothing.
   */
  const commitDescription = (): void => {
    const next = normaliseGroupDescription(description);
    if (next === (group.data?.description ?? null) || next === sentDescription) return;
    setSentDescription(next);
    updateGroup.mutate({ description: next }, { onSuccess: () => setStatus(t.account.saved) });
  };

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
    (member) => isViewer(member, viewerId) && member.role === 'admin',
  );
  const canChangeCurrency = canEditSettlementCurrency(
    isAdmin,
    expenses.data?.length ?? 0,
    tripRates.data?.length ?? 0,
  );

  const leave = async (): Promise<void> => {
    // A refusal, not a failure — it explains why the tap did nothing, so it
    // keeps its dialog rather than fading past as a toast.
    if (!settled) {
      await notify({ title: t.group.settleFirst, body: t.group.settleFirstBody });
      return;
    }
    const ok = await confirm({
      title: t.group.leaveQuestion,
      body: t.group.leaveBody,
      confirmLabel: t.group.leave,
      tone: 'danger',
    });
    if (!ok || !ledger.myMemberId) return;
    leaveGroup.mutate(ledger.myMemberId, { onSuccess: () => router.replace('/') });
  };

  // Archiving puts a group away; it does not throw anything out, and it can be
  // undone from the archive. So it asks in the ordinary voice — no warning mark,
  // no red door — which is the difference the native alert could not draw.
  const archive = async (): Promise<void> => {
    const ok = await confirm({
      title: t.group.archiveQuestion,
      body: t.group.archiveBody,
      confirmLabel: t.group.archive,
    });
    if (ok) {
      updateGroup.mutate(
        { archived_at: new Date().toISOString() },
        { onSuccess: () => router.replace('/') },
      );
    }
  };

  // An archived group can now be opened, so this screen has to offer the way
  // back. Before, the only Unarchive in the app was on the archive shelf in
  // settings, because a group there was the one place you could reach it from;
  // arriving here instead — from a balance on the Friends list, say — and being
  // offered "Archive" on a group that is already archived would be a control
  // that does nothing you can see. No confirmation: putting something back is
  // not a decision that wants a second thought, and it stays on the screen so
  // the row simply flips.
  const archived = Boolean(group.data?.archived_at);
  const unarchive = (): void => {
    updateGroup.mutate({ archived_at: null });
  };

  /**
   * The open debts — "Asha owes Ravi", and ₹500 beside it — for the delete
   * warning. Read off the same `transfers` the who-pays-whom screen shows, so
   * the amounts in the warning are the amounts the group has been looking at,
   * and across every currency rather than only the group default.
   *
   * The money is handed over as money rather than formatted into the sentence.
   * The native alert could be told nothing but strings, so four real debts
   * arrived as one paragraph; a row keeps the name and the amount apart, and
   * `MoneyText` then draws the amount the way every other amount in this app is
   * drawn, with the spoken label it carries everywhere else.
   *
   * Names are the plain member names, never "You": the line has to read the
   * same to whoever is holding the phone, and "You owes Ravi" is not a
   * sentence in any of the four languages. A blocked person keeps the ghost
   * they wear everywhere else (A62) — the block is about not seeing a name all
   * day, and a warning is not the place to hand it back.
   */
  const outstandingDebts = (): DialogRow[] => {
    const nameFor = (memberId: string): string => {
      const member = (members.data ?? []).find((row) => row.id === memberId);
      // The label for a member with no name of their own is passed in rather
      // than left to the default, which is the English word: this dialog is the
      // last thing somebody reads before destroying a record, and half of it
      // arriving in another language is not the moment for it.
      return member ? displayName(member, undefined, blockedIds, t.misc.someone) : t.misc.someone;
    };
    return orderDebtsForWarning(ledger.transfers, currency).map((transfer) => ({
      // Two members and a currency are exactly one debt in `transfers`, so this
      // is stable across a re-render and unique within the list.
      key: `${transfer.from}:${transfer.to}:${transfer.currency}`,
      label: fill(t.group.deleteOwesWho, {
        from: nameFor(transfer.from),
        to: nameFor(transfer.to),
      }),
      amount: { minor: transfer.amount, currency: transfer.currency as CurrencyCode },
    }));
  };

  // Delete removes the group for everyone (A49), immediately and with no undo,
  // so the confirmation is written to be read rather than tapped through.
  //
  // It used to refuse outright unless the whole group was square. That rule is
  // gone — a group whose balances will never reach zero (the trip nobody
  // settled, the group created by mistake) could otherwise never be deleted by
  // anybody, including the person who created it. What replaces it is honesty:
  // when balances are open, the dialog names them and says plainly that
  // deleting throws that record away for every member, not only for the admin
  // tapping. This is the dialog the whole replacement was for: it is the one
  // place in the app where the consequence of a tap is a list of real people
  // and real money, and the native alert rendered it as a wall of prose.
  const confirmDelete = async (): Promise<void> => {
    const debts = ledger.groupSettled ? [] : outstandingDebts();
    // Enough rows to make the loss concrete without turning the dialog into a
    // ledger; the rest are counted, since the point is the size of what goes.
    const warning = groupDeleteWarning({
      groupSettled: ledger.groupSettled,
      debts,
      locale,
      text: t.group,
    });

    const ok = await confirm({
      title: t.group.deleteQuestion,
      body: warning.body,
      rows: warning.rows,
      moreRows: warning.moreRows,
      note: warning.note,
      // "Delete anyway" when there is something to lose, so the button itself
      // admits what the rows above it just showed.
      confirmLabel: ledger.groupSettled ? t.group.delete : t.group.deleteAnyway,
      tone: 'danger',
    });
    if (!ok || deleteGroup.isPending) return;
    setDeleteError(null);

    deleteGroup.mutate(undefined, {
      onSuccess: () => router.replace('/'),
      onError: (caught) => {
        // The one coded refusal left carries a `code` (set in api.deleteGroup);
        // show its localized line directly. Anything else is unknown and goes
        // through friendlyError, which never echoes raw backend text.
        //
        // Neither a second dialog nor a toast: stacking a dialog on the one just
        // dismissed is how somebody taps through a sentence without reading it,
        // and a toast that fades leaves a screen that looks untouched with no
        // explanation on it. It stays under the row that was refused.
        const code = (caught as { code?: string } | null)?.code;
        setDeleteError(
          code === 'NOT_ADMIN'
            ? t.group.deleteAdminOnly
            : friendlyError(caught, t.misc.tryAgainMoment, 'groupSettings.delete'),
        );
      },
    });
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
        {/* The group's identity, as one thing rather than three controls.
            A group *is* its mark and its name — that is the pair every list
            in the app shows — so they sit on one line: the mark on the left,
            tappable, opening every way of changing it; the name written
            straight into the row beside it, over a rule that lights up while
            it is being edited. The three loose buttons that used to sit under
            this card (Save name, Choose an icon, Remove photo) are gone: the
            first asked for a tap to confirm a change already made, and the
            other two are ways of changing the mark, which is what the mark
            itself is for. This is the same row the new-group screen opens
            with, so naming a group and renaming one look like one control. */}
        <Card>
          <Row style={{ gap: theme.spacing.lg }}>
            <GroupPhoto
              photoPath={group.data.photo_path}
              emoji={group.data.cover_emoji}
              size={64}
              busy={uploading}
              // The mark is the one door to the cover now, so it has to say so:
              // its default label offers a photo, which is only one of the three
              // things behind it and the one a free group cannot take.
              accessibilityLabel={t.group.changeCover}
              onPress={() => setCoverOpen(true)}
            />
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {t.group.nameOptional}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                onFocus={() => setNaming(true)}
                // The name commits itself: on the keyboard's "done" and again
                // when the field loses focus, so leaving the screen never
                // silently drops what was typed.
                onBlur={() => {
                  setNaming(false);
                  commitName();
                }}
                onSubmitEditing={commitName}
                returnKeyType="done"
                accessibilityLabel={t.group.groupName}
                placeholder={groupLabel(null, members.data ?? [], viewerId)}
                placeholderTextColor={theme.color.textFaint}
                style={{
                  fontSize: 20,
                  fontWeight: '700',
                  color: theme.color.text,
                  paddingVertical: theme.spacing.sm,
                  borderBottomWidth: 1.5,
                  borderBottomColor: naming ? theme.color.brand : theme.color.border,
                }}
              />
            </View>
          </Row>

          {/* What the group is for, under what it is called — the same pair, in
              the same card, that the create screen opens with. It sits across
              the full width rather than beside the mark: a sentence needs the
              room, and the mark belongs to the name. */}
          <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.lg }}>
            <Text variant="caption" tone="muted">
              {t.group.descriptionOptional}
            </Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              onFocus={() => setDescribing(true)}
              onBlur={() => {
                setDescribing(false);
                commitDescription();
              }}
              accessibilityLabel={t.group.groupDescription}
              placeholder={t.group.descriptionPlaceholder}
              placeholderTextColor={theme.color.textFaint}
              maxLength={GROUP_DESCRIPTION_MAX}
              // Multiline, so there is no "done" key to submit on — blur is the
              // only commit here, which is why `returnKeyType` is not set the
              // way the name's is. A return inside a description is a line
              // break, not a save.
              multiline
              style={{
                fontSize: 15,
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
                minHeight: 48,
                textAlignVertical: 'top',
                borderBottomWidth: 1.5,
                borderBottomColor: describing ? theme.color.brand : theme.color.border,
              }}
            />
          </View>
        </Card>

        {/* Opened by the mark above and nothing else, so there is one door to
            the cover rather than a button per way through it. */}
        <GroupCoverSheet
          visible={coverOpen}
          onClose={() => setCoverOpen(false)}
          value={group.data.cover_emoji}
          // Says "Saved" like every other setting on this screen. The mark is
          // drawn, so a changed cover has no words of its own to confirm it.
          onChange={(emoji) =>
            updateGroup.mutate(
              { cover_emoji: emoji },
              { onSuccess: () => setStatus(t.account.saved) },
            )
          }
          hasPhoto={Boolean(group.data.photo_path)}
          photoStatus={photoStatus}
          onPickPhoto={() => void changePhoto()}
          onRemovePhoto={() => void dropPhoto()}
          onUpgrade={() => router.push('/settings/upgrade')}
        />

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

        {/* What the group counts in, and what it converts foreign bills with.
            Only an admin can choose it. It also stops being a control once
            anything depends on it: either entries counted in it, or pinned rates
            whose stored ratios all convert into it. Trip rates themselves can
            be re-pinned at any time, because a bill keeps the rate it was saved
            with (ADR-003). */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.fx.section} />
          <SettlesInRow
            currency={currency}
            locked={!canChangeCurrency}
            onChange={(default_currency) =>
              updateGroup.mutate(
                { default_currency },
                { onSuccess: () => setStatus(t.account.saved) },
              )
            }
          />
        </View>
        <TripRatesCard groupId={groupId} groupCurrency={currency} canEdit={isAdmin} />

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
                  title={displayName(member, viewerId, blockedIds, t.misc.someone)}
                  subtitle={
                    isGhost(member)
                      ? t.notJoinedYet
                      : // A handle carries a name, an address or a phone number,
                        // so a blocked person's is masked here exactly as it is
                        // on the members screen — this roster was showing the
                        // real name and the real handle of somebody the reader
                        // had asked never to see again.
                        isBlockedMember(member, blockedIds)
                        ? t.misc.noUpiYet
                        : // The rail pair, not the legacy UPI column alone.
                          (payableAt(member)?.handle ?? t.misc.noUpiYet)
                  }
                  leading={
                    <Avatar
                      name={displayName(member, null, blockedIds, t.misc.someone)}
                      ghost={isGhost(member) || isBlockedMember(member, blockedIds)}
                    />
                  }
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

          {/* The ways in, each one named.

              This section used to ask you to guess. A text field with nothing
              over it but the words "Add someone", a ghost button under it
              reading "Browse my contacts", and — four rows further down the
              page, in a card of its own — the invite link. Three different ways
              of getting a person into the group, and none of the three said
              where that person was coming from before you pressed it; the one
              most people actually want (send a link, they join themselves) did
              not look like part of adding anybody at all.

              So the doors come first, as rows with a mark, a name and a line
              saying what the tap does, ordered by how often each is the right
              answer rather than alphabetically. Typing a name follows under a
              rule, as the fallback it is — the same shape the members screen
              settled on, drawn in this screen's own row idiom.

              `ListRow` rather than a `DetailRow`: these are entries you *open*,
              each with a name and a subtitle, not facts about the group with a
              value on the right. That is the row this screen already wears for
              duplicate, favourite and the three ways out, so the section reads
              as part of the page instead of introducing a fourth kind of row.

              Missing, and worth saying out loud: the people already in your
              other groups — the same friends, a new trip — which is very likely
              the commonest reason this section is opened. No flow exists for it
              yet, and a row leading nowhere is worse than no row, so none is
              drawn (see `lib/addSomeoneRoutes`). */}
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {t.people.addSomeone}
            </Text>

            {/* The hairline belongs to the gap, not to the row: drawn by the
                row itself it would leave a stray line under the last one. Keyed
                off the position in the list that was actually returned, so a
                row that is absent (no address book) takes its divider with it
                rather than leaving a line with nothing on one side of it. */}
            <View>
              {routes.map((route, index) => (
                <Fragment key={route.key}>
                  {index > 0 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                  <ListRow
                    title={route.title}
                    subtitle={route.hint}
                    // The name alone says a place, not an act. A reader hears
                    // both halves — "From your contacts, pick names out of this
                    // phone's address book" — which is the whole point of the
                    // rewrite and would be lost to a label of just the title.
                    accessibilityLabel={route.spoken}
                    leading={
                      <Ionicons
                        name={route.icon}
                        size={iconSize.xl}
                        color={theme.color.textMuted}
                      />
                    }
                    onPress={() => openRoute(route)}
                    trailing={
                      <Ionicons
                        // Content, not layout: RN mirrors the row in RTL but
                        // leaves the glyph pointing whichever way it was drawn.
                        name={directionalIcon('chevron-forward')}
                        size={iconSize.md}
                        color={theme.color.textFaint}
                      />
                    }
                  />
                </Fragment>
              ))}
            </View>

            {/* A rule with the alternative written into it, so the field below
                reads as the other way rather than as the only way — the same
                divider, and the same string, the members screen uses. */}
            <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
              <Text variant="micro" tone="faint">
                {t.people.orByName}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
            </Row>

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

            {/* Every way in is a row above; what is left at the foot of the
                card is the one spinner and the one error line, because all of
                them drive the same mutation and beside-the-button would mean
                three of each. */}
            {addingContacts ? <ActivityIndicator color={theme.color.brand} /> : null}
            {addError ? <Callout tone="negative">{addError}</Callout> : null}
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
              // The row *is* the switch beside it — same handler, same state.
              // Guarded, the row would refuse a fast on-off while the Switch on
              // its right accepted it, and the star would disagree with itself.
              repeatable
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

        {/* The three ways out.
            They used to be three identical red pill buttons stacked in a
            column, which said the wrong thing twice over: that the three acts
            weigh the same, and that all three are dangerous. They are not.
            Archiving is reversible and touches nobody but your own list;
            leaving affects only you and leaves the group standing; deleting
            takes the whole thing away from everyone, at once, with no undo.
            So each is a row with its own mark and one line saying whose it is,
            and the weight climbs across them: a brand mark and plain ink for
            archive, a red mark and a red title for leave, and — alone on its
            own card, ringed in red — the delete. Delete standing apart is the
            same grammar the account screen's danger zone uses; a section that
            ends things announces itself by being set off, not by a heading. */}
        <View style={{ gap: theme.spacing.xl }}>
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {/* One row, both directions. The mark stays the same either way: an
                undo arrow would read better and points left, which is the wrong
                way round in Arabic and is not in the mirror table — a
                directional glyph for a reversible action is not worth a
                wrong-facing arrow. The title says which way this row goes. */}
            <ListRow
              title={archived ? t.group.unarchive : t.group.archiveGroup}
              subtitle={archived ? t.group.unarchiveHint : t.group.archiveHint}
              leading={<ExitChip icon="archive-outline" tone="quiet" />}
              onPress={archived ? unarchive : () => void archive()}
            />
            <View style={{ height: 1, backgroundColor: theme.color.border }} />
            <ListRow
              title={t.group.leaveGroup}
              subtitle={t.group.leaveHint}
              destructive
              // Not `exit-outline`: that glyph is an arrow through a door, and
              // an arrow drawn to the right still points right in a mirrored
              // layout. Taking yourself off the list is direction-free.
              leading={<ExitChip icon="person-remove-outline" tone="soft" />}
              onPress={() => void leave()}
            />
          </Card>

          {/* Deleting drops the group for everyone, so it is an admin-only
              power (the RPC refuses it regardless) and stands alone. */}
          {isAdmin ? (
            <View style={{ gap: theme.spacing.sm }}>
              <Card
                padded={false}
                style={{
                  paddingHorizontal: theme.spacing.lg,
                  borderWidth: 1,
                  borderColor: theme.color.negative,
                  opacity: deleteGroup.isPending ? 0.45 : 1,
                }}
              >
                <ListRow
                  title={t.group.deleteGroup}
                  subtitle={t.group.deleteHint}
                  destructive
                  leading={<ExitChip icon="trash-outline" tone="loud" />}
                  onPress={deleteGroup.isPending ? undefined : () => void confirmDelete()}
                />
              </Card>
              {/* An admin looking at an unsettled group should know what the
                  row costs before they tap it, not only in the alert after. */}
              {!ledger.groupSettled ? (
                <Callout tone="negative">{t.group.deleteUnsettledHint}</Callout>
              ) : null}
              {deleteError !== null ? <Callout tone="negative">{deleteError}</Callout> : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
