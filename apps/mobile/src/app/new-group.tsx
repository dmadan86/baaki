import { useEffect, useRef, useState, type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  currencySymbol,
  guessGroupEmoji,
  guessGroupType,
  minorUnitExponent,
  minorUnitScale,
  MutationKind,
} from '@waves/core';
import {
  AmountField,
  Button,
  Callout,
  Card,
  ChipRow,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  Toggle,
  useTheme,
} from '@waves/ui';

import { DetailRow, DetailRows } from '@/components/DetailRows';
import { GroupPhoto } from '@/components/GroupPhoto';
import { friendlyError } from '@/lib/errors';
import { GROUP_DESCRIPTION_MAX, normaliseGroupDescription } from '@/lib/groupDescription';
import { router } from '@/lib/navigation';
import { isPhoneCountryError, normaliseContactPhone } from '@/lib/phone';
import { type PickedContact } from '@/components/ContactPicker';
import { CoverEmojiPicker } from '@/components/CoverEmojiPicker';
import { InfoDisclosure } from '@/components/InfoDisclosure';
import { TripDates, type TripDatesValue } from '@/components/TripDates';
import { requestContacts } from '@/lib/contactPickerBridge';
import { useCaptures, useCreateGroup, useGroup } from '@/data/hooks';
import { assignCaptureHref } from '@/lib/captureAssign';
import { useAuth, useViewerId } from '@/lib/auth';
import { useDefaultCurrency } from '@/lib/currency';
import { useGuestGuard } from '@/lib/guestGuard';
import { useSync } from '@/sync';
import { displayName, GroupType, isViewer } from '@/data/types';
import { deviceCountry, fill, useStrings } from '@/i18n';

/**
 * Where the icon comes from when the name has not said anything yet — which is
 * the state this screen opens in, and the state a group called "Alex and Sam"
 * stays in. The kind of group is a real answer to "what is this", so it is a
 * better fallback than one fixed emoji for everybody.
 */
const EMOJI_FOR_TYPE: Record<GroupType, string> = {
  [GroupType.Trip]: '✈️',
  [GroupType.Home]: '🏠',
  [GroupType.Couple]: '💜',
  [GroupType.Event]: '🎉',
  [GroupType.Friends]: '🧑‍🤝‍🧑',
  [GroupType.Other]: '👥',
};

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

/**
 * A chip icon renderer that takes the chip's resolved colour (selected/not).
 * Not a component — a render callback the Chip calls with its own ink colour, so
 * the display-name rule (which assumes a returned element means a component) does
 * not apply here.
 */
const iconFor =
  (name: keyof typeof Ionicons.glyphMap) =>
  // eslint-disable-next-line react/display-name
  (color: string): ReactNode => <Ionicons name={name} size={iconSize.base} color={color} />;

/**
 * Making a group, wearing the same clothes as the settings that edit one.
 *
 * The two screens used to look nothing alike, which made creating a group feel
 * like a different app from configuring it. So this is the settings screen's
 * cards — the name-and-icon card, the flagged country row, the trip-dates
 * editor, the simplify toggle — filled from local state instead of a saved
 * group. Nothing is written until Create is tapped, so backing out leaves no
 * half-made group behind; everything picked here is applied in one ordered
 * burst once the group exists.
 */
export default function NewGroupScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const createGroup = useCreateGroup();
  const { profile } = useAuth();
  // Identity for "which member am I", from the session rather than the profile:
  // the session is on the device at launch, the profile is a fetch that lands
  // later, and in the gap `profile?.id` is undefined — which `isViewer` refuses
  // to match, but only if it is given the right thing to compare. See
  // `lib/auth.useViewerId`.
  const viewerId = useViewerId();
  const currency = useDefaultCurrency();
  const guard = useGuestGuard();
  const { mutate } = useSync();

  // Cloning: `?from=<groupId>` opens this screen filled from an existing group.
  // The source is read straight from the local mirror (synchronous once
  // hydrated), so nothing here waits on the network — the seed lands as soon as
  // the group is on disk. Everything seeded stays editable, and the people are
  // seeded into the same removable chip list a fresh group uses, which is what
  // lets you drop someone before the group is made.
  // `?assignCaptureId=<id>` means this screen was opened from a capture's group
  // picker with no group to place it in yet: make the group here, then drop that
  // capture straight into it (below), completing the "create one and add this to
  // it" the picker promised rather than stranding the capture back in the inbox.
  const { from, assignCaptureId } = useLocalSearchParams<{
    from?: string;
    assignCaptureId?: string;
  }>();
  const cloning = Boolean(from);
  const source = useGroup(from ?? '');
  const captures = useCaptures();

  const [name, setName] = useState('');
  // A sentence about the group, under its name and in the same card, because it
  // is part of naming the thing rather than a setting about it. Optional, and
  // capped — see `groupDescription.ts` for why at that number.
  const [description, setDescription] = useState('');
  // The group cover is an emoji icon, chosen by tapping the avatar. Photos are
  // a paid feature edited from group settings, not part of creating one.
  const [iconOpen, setIconOpen] = useState(false);
  // Null until somebody picks a kind — until then it is read from the name, the
  // same bargain the icon strikes. So the screen never opens assuming a trip: a
  // group called "Goa" still becomes one, "Dinner" does not, and an untyped
  // name falls back to Other rather than dragging trip fields in behind it.
  const [pickedType, setPickedType] = useState<GroupType | null>(null);
  // Which attribute row of the settings card is unfolded, if any — one at a
  // time, so the card stays a short list until you open the one you want.
  //
  // These used to sit behind a "More options" disclosure, which hid four
  // already-answered facts behind a row that said nothing about any of them. A
  // group has a kind whether or not you open anything, so the screen now states
  // it — the same way the expense screen states who paid and how a bill was
  // split, as a stack of named facts with their values, each one a tap from
  // being changed. Nothing here is required; the point is that the screen reads
  // as already filled in rather than as a form still to be completed.
  const [openAttr, setOpenAttr] = useState<'kind' | 'dates' | 'budget' | null>(null);

  /**
   * Bring an unfolded row back into view.
   *
   * These rows open *in place*, near the foot of a scroll that already has a
   * pinned button under it — and the budget one raises a numeric keypad in the
   * same gesture that reveals the field. Android resizes the window for the
   * keyboard (`adjustResize`), which shrinks this scroll rather than moving it,
   * so the field that just appeared is left underneath the keypad with nothing
   * scrolling it back. Nobody can type into what they cannot see.
   *
   * Scrolling to the end rather than measuring the row: the only thing below
   * any of these is the simplify toggle, so the end *is* the unfolded row plus
   * one row of context, and it needs no layout maths that would go stale the
   * moment a row above it grows. The delay lets the unfolded content lay out
   * and the keyboard finish its own resize first — scrolling to an end that has
   * not happened yet scrolls nowhere.
   */
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    if (openAttr === null) return;
    const id = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 160);
    return () => clearTimeout(id);
  }, [openAttr]);
  const [ghostName, setGhostName] = useState('');
  // People to add on Create — a typed name carries no address, a contact carries
  // whatever the phone had. Same shape either way, so the create loop treats
  // them alike.
  const [ghosts, setGhosts] = useState<PickedContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Not asked on this screen — taken from the account country (which the user
  // sets on "Your account"), falling back to the phone's region. Decides the
  // group's currency and settle rails, both changeable later in group settings.
  const country: string | null = profile?.country_code ?? deviceCountry();
  // Null until somebody picks: the icon is otherwise read from the name, so an
  // untouched group still gets a sensible cover.
  const [pickedEmoji, setPickedEmoji] = useState<string | null>(null);
  // Null until toggled, so it can follow the group type's default until then.
  const [simplify, setSimplify] = useState<boolean | null>(null);
  // Optional starting budget for a trip, minor units. Zero is "not set".
  const [budget, setBudget] = useState<bigint>(0n);
  const [tripDates, setTripDates] = useState<TripDatesValue>(() => ({
    start_date: null,
    end_date: null,
    time_zone: deviceZone(),
    remind_daily: true,
    remind_morning_at: '09:00:00',
    remind_evening_at: '20:00:00',
  }));

  // Fill the form from the source group, once, the first render it is readable.
  const seeded = useRef(false);
  const sourceGroup = source.group.data;
  const sourceMembers = source.members.data;
  useEffect(() => {
    if (!cloning || seeded.current || !sourceGroup) return;
    seeded.current = true;
    const group = sourceGroup;
    const members = sourceMembers ?? [];
    let budgetMinor: bigint | null = null;
    if (group.budget_minor) {
      try {
        budgetMinor = BigInt(group.budget_minor);
      } catch {
        // A budget that will not parse is simply left unset.
      }
    }
    // The people become the same removable chips a fresh group builds up — minus
    // whoever is making the clone (they are the new group's creator) and anyone
    // who had left. Each carries whatever address the source row held, so the
    // ones already on Waves can be tapped on their shoulder when re-added.
    const seededGhosts: PickedContact[] = members
      .filter((member) => !member.left_at)
      .filter((member) => !isViewer(member, viewerId))
      .map((member) => ({
        name: displayName(member, viewerId),
        email: member.invite_email ?? null,
        phone: member.invite_phone ?? null,
      }));
    // Applied off the effect body, in a microtask: this is a one-time hydrate
    // from the local mirror, and putting the writes in a callback keeps the
    // React Compiler's no-synchronous-setState-in-effect rule satisfied (the
    // same shape GroupPhoto's signed-URL fetch uses).
    void Promise.resolve().then(() => {
      setName(group.name ? fill(t.clone.copyOf, { name: group.name }) : '');
      // The description comes across as-is. It describes what the group is for,
      // and a clone is for the same thing — it is the name that needs "copy of"
      // on it to tell the two apart, not the sentence explaining them both.
      setDescription(group.description ?? '');
      setPickedType(group.type);
      setPickedEmoji(group.cover_emoji ?? null);
      setSimplify(group.simplify_debts);
      if (budgetMinor !== null) setBudget(budgetMinor);
      if (group.start_date && group.end_date) {
        setTripDates((current) => ({
          ...current,
          start_date: group.start_date,
          end_date: group.end_date,
          time_zone: group.time_zone ?? current.time_zone,
          remind_daily: group.remind_daily ?? current.remind_daily,
          remind_morning_at: group.remind_morning_at ?? current.remind_morning_at,
          remind_evening_at: group.remind_evening_at ?? current.remind_evening_at,
        }));
      }
      setGhosts(seededGhosts);
    });
  }, [cloning, sourceGroup, sourceMembers, viewerId, t]);

  // The kind is a reading of the name, unless somebody has chosen one, and
  // Other when the name says nothing — never Trip by default, so the trip-only
  // dates and budget stay out of the way of a dinner or a flat.
  const type: GroupType =
    pickedType ?? (guessGroupType(name) as GroupType | null) ?? GroupType.Other;
  // The icon is a reading of the name, unless somebody has chosen one; it
  // changes under the caret as they type "Goa" and again if they change the
  // kind of group.
  const emoji = pickedEmoji ?? guessGroupEmoji(name) ?? EMOJI_FOR_TYPE[type];
  // Trips and events benefit most from simplification; a two-person group does
  // not. Follows the type until somebody says otherwise.
  const effectiveSimplify = simplify ?? (type === GroupType.Trip || type === GroupType.Event);

  // The kinds of group, one place — the chips inside the picker and the icon on
  // the collapsed pill both read from this.
  const typeOptions: { value: GroupType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { value: GroupType.Trip, label: t.extras.typeTrip, icon: 'airplane' },
    { value: GroupType.Home, label: t.extras.typeHome, icon: 'home' },
    { value: GroupType.Couple, label: t.extras.typeCouple, icon: 'heart' },
    { value: GroupType.Event, label: t.extras.typeEvent, icon: 'sparkles' },
    { value: GroupType.Friends, label: t.extras.typeFriends, icon: 'people-circle' },
    { value: GroupType.Other, label: t.extras.typeOther, icon: 'people' },
  ];
  const currentType = typeOptions.find((option) => option.value === type) ?? {
    value: type,
    label: t.extras.typeOther,
    icon: 'people' as const,
  };

  // A short "9 Jan" for the date pill; the full weekday form lives inside the
  // picker. Parsed at local noon so a date-only string never slips a day.
  const shortDate = (iso: string): string => {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1, 12).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
    });
  };
  const dateSummary =
    tripDates.start_date && tripDates.end_date
      ? `${shortDate(tripDates.start_date)} - ${shortDate(tripDates.end_date)}`
      : t.add;

  // The budget for its pill, minor units back to a plain major string with the
  // currency symbol — the same maths AmountField does, just for display.
  const budgetSummary = ((): string => {
    if (budget <= 0n) return t.add;
    const scale = minorUnitScale(currency);
    const exponent = minorUnitExponent(currency);
    const whole = (budget / scale).toString();
    const major =
      exponent === 0 ? whole : `${whole}.${(budget % scale).toString().padStart(exponent, '0')}`;
    return `${currencySymbol(currency)}${major}`;
  })();

  const submit = async (): Promise<void> => {
    // A guest gets one group and ten days (ADR-006 addendum). Past either, this
    // sends them to the upgrade screen instead of making a group the server
    // would refuse anyway.
    if (guard.blockAddGroup()) return;
    setError(null);
    try {
      const groupId = await createGroup.mutateAsync({
        // Blank is fine — the group gets labelled by who is in it instead.
        name: name.trim() || null,
        type,
        // Where the phone is, and what that country counts in. A group made in
        // Dubai defaulting to rupees is the small wrongness that makes an app
        // feel written for somewhere else.
        country,
        currency,
        emoji,
        // A group photo is not carried onto a clone: its storage object is
        // scoped to the source group's path, so a copied reference would only
        // render for viewers who are also in the source (emoji for everyone
        // else). The clone keeps the emoji; a photo is set later in settings,
        // where it is uploaded under this group's own path and paid-gated.
        simplify: effectiveSimplify,
      });

      // ADR-006: people who have not installed anything are still participants.
      // Queued behind the create in one ordered pipe, not sent as a direct RPC —
      // the create resolves once it is on disk, not once the server has seen it,
      // so a direct add would race a group the server does not know yet and fail
      // its membership check (NOT_A_MEMBER). Behind the create, each applies
      // after the group it belongs to exists.
      for (const ghost of ghosts) {
        await mutate(MutationKind.MemberAddGhost, groupId, {
          memberId: randomUUID(),
          name: ghost.name,
          email: ghost.email,
          // Read a bare local number in this group's region before queueing it —
          // the country chosen for the group above, else the account/device — so
          // the server is never handed an unroutable number to refuse.
          phone: normaliseContactPhone(ghost.phone, country),
        });
      }

      // The description rides behind the create as an ordinary group.update,
      // the same way the trip dates below do, rather than being added to
      // `waves_create_group`.
      //
      // That is deliberate and is the safer of the two shapes. `group.create`
      // is the one mutation in the app whose refusal takes something away: the
      // queue overlay is the only place a group exists until it syncs, so a
      // create the server will not accept ends with the person dropping it and
      // the group going with it. Giving the create a new argument gives it a new
      // way to be refused — by a server that has not yet learned the column, by
      // a length the client let through — for the sake of a field nobody needs
      // the group to have. Behind the create, the worst case is a description
      // that did not save on a group that did.
      //
      // Only sent when something was actually typed, so the ordinary path
      // (create a group, do not describe it) queues exactly what it did before.
      const trimmedDescription = normaliseGroupDescription(description);
      if (trimmedDescription) {
        await mutate(MutationKind.GroupUpdate, groupId, { description: trimmedDescription });
      }

      // Trip dates are not part of the create call, so they ride behind it as
      // an update on the same ordered queue — only when a trip was actually
      // given a start and end, since that is what turns the reminders on.
      if (type === GroupType.Trip && tripDates.start_date && tripDates.end_date) {
        await mutate(MutationKind.GroupUpdate, groupId, {
          start_date: tripDates.start_date,
          end_date: tripDates.end_date,
          time_zone: tripDates.time_zone,
          remind_daily: tripDates.remind_daily,
          remind_morning_at: tripDates.remind_morning_at,
          remind_evening_at: tripDates.remind_evening_at,
        });
      }

      // A starting budget, if one was typed. Same ordered queue behind the
      // create, so it lands once the group exists (like the dates). Zero means
      // "not set" — the planner shows no cap rather than a ₹0 ceiling.
      if (type === GroupType.Trip && budget > 0n) {
        await mutate(MutationKind.GroupBudgetSet, groupId, {
          amountMinor: budget.toString(),
          currency,
        });
      }

      // Made to hold a waiting capture: hand that capture to this group's
      // add-expense form instead of opening the group, so the person lands where
      // they were headed — placing the spend — with the new group already chosen.
      // Replace, not push, so backing out of the form does not return to this
      // half-made-group screen. Any trip nudge yields to this: assigning is the
      // errand they were on.
      if (assignCaptureId) {
        const capture = captures.data?.find((row) => row.id === assignCaptureId);
        if (capture) {
          router.replace(assignCaptureHref(capture, groupId));
          return;
        }
      }

      // A trip made without dates lands on its group with a one-time nudge to
      // plan it — dates turn on the daily reminders, a budget the cap. Only when
      // neither was set here, since the point of moving them off the create
      // screen is that most trips skip them there. Any other kind, or a trip
      // already dated, opens plain.
      const nudgeTrip = type === GroupType.Trip && !(tripDates.start_date && tripDates.end_date);
      router.replace(nudgeTrip ? `/group/${groupId}?welcome=trip` : `/group/${groupId}`);
    } catch (caught) {
      setError(
        isPhoneCountryError(caught)
          ? t.people.phoneNeedsCountryCode
          : friendlyError(caught, t.couldNotSave, 'newGroup.create'),
      );
    }
  };

  // The address first, because that is what tells two people of the same name
  // apart; the name only carries the difference when neither has an address.
  const keyOfGhost = (ghost: PickedContact): string =>
    `${ghost.email ?? ''}|${ghost.phone ?? ''}|${ghost.name}`;

  const addTypedGhost = (): void => {
    const name = ghostName.trim();
    if (!name) return;
    setGhosts((current) => [...current, { name, email: null, phone: null }]);
    setGhostName('');
  };

  // Ticked out of the phone's contacts. Merged rather than replaced — somebody
  // may have typed a name or picked already — and de-duplicated so the same
  // person picked twice is added once.
  const addContacts = (people: readonly PickedContact[]): void => {
    setGhosts((current) => {
      const seen = new Set(current.map(keyOfGhost));
      const merged = [...current];
      for (const person of people) {
        const key = keyOfGhost(person);
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(person);
        }
      }
      return merged;
    });
  };

  // Hand the picker who is already chosen and what to do with the answer, then
  // open it on its own screen. It calls `addContacts` back through the bridge.
  const openContactPicker = (): void => {
    requestContacts({ initial: ghosts, onPicked: addContacts });
    router.push('/contact-picker');
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.close} onPress={() => router.back()}>
          <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{cloning ? t.clone.duplicateTitle : t.newGroup}</Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* One compact row: the cover — tapped to choose an icon — with the
            name inline beside it and a clear (×) once there is a name; and
            under it, in the same card, the sentence that says what the group is
            for. The two belong together: they are both the group's own account
            of itself, where everything below is a setting about how it behaves.
            Splitting them into two cards would have said otherwise. */}
        <Card style={{ paddingVertical: theme.spacing.md }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.group.chooseIcon}
              onPress={() => setIconOpen(true)}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <GroupPhoto photoPath={null} emoji={emoji} size={44} />
            </Pressable>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t.misc.newGroupPlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.group.groupName}
              autoFocus
              style={{
                flex: 1,
                fontSize: 18,
                fontWeight: '700',
                color: theme.color.text,
                paddingVertical: 0,
              }}
            />
            {name.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.entry.clear}
                onPress={() => setName('')}
                hitSlop={8}
                style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
              >
                <Ionicons name="close-circle" size={iconSize.md} color={theme.color.textFaint} />
              </Pressable>
            ) : null}
          </Row>

          {/* Inset past the cover so it lines up with the name rather than with
              the mark, which is what makes the two read as one block of writing
              about the group instead of two unrelated fields.

              Multiline and auto-growing: a description is a sentence, and a
              sentence that scrolls inside two lines of a text box is a sentence
              nobody re-reads before saving. `maxLength` is the same cap the
              column carries, so the field simply stops accepting keystrokes
              rather than letting somebody type a paragraph the database will
              refuse — a refusal they would only meet after tapping Create. */}
          <View
            style={{
              marginTop: theme.spacing.md,
              paddingTop: theme.spacing.md,
              marginStart: 44 + theme.spacing.md,
              borderTopWidth: 1,
              borderTopColor: theme.color.border,
            }}
          >
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={t.group.descriptionPlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.group.groupDescription}
              maxLength={GROUP_DESCRIPTION_MAX}
              multiline
              style={{
                fontSize: 15,
                color: theme.color.text,
                paddingVertical: 0,
                // Two lines of room before it grows, so the field looks like
                // somewhere to write rather than a one-line input.
                minHeight: 40,
                textAlignVertical: 'top',
              }}
            />
          </View>
        </Card>

        {/* Controlled by the avatar tap above — no trigger of its own. */}
        <CoverEmojiPicker
          value={emoji}
          onChange={setPickedEmoji}
          open={iconOpen}
          onOpenChange={setIconOpen}
        />

        {/* People sit directly under the name — they are the group, so nothing
            optional (kind, dates, budget) comes between naming it and saying who
            is in it. Contacts is still a real button, not a corner link — it has
            just moved onto the end of the title row instead of taking a
            full-width line of its own, so the typed name (the quieter second
            way) sits directly under the label it belongs to. Nobody's address
            book is uploaded (ADR-006). */}
        <Card style={{ gap: theme.spacing.md }}>
          <InfoDisclosure
            title={t.extras.addPeopleByName}
            info={t.extras.ghostNote}
            titleVariant="caption"
            // `right` is InfoDisclosure's own title-row slot: the title flexes,
            // this sits at the end of the same Row (start/end, not left/right,
            // so RTL mirrors it), and the folded-out explanation still spans the
            // full width underneath.
            right={
              <Button
                // The short label is what fits beside a title at `sm`; the full
                // "browse my contacts" is what the button still announces, so
                // shortening the text costs nothing to a screen reader.
                label={t.people.contacts}
                accessibilityLabel={t.people.browseContacts}
                variant="secondary"
                size="sm"
                onPress={openContactPicker}
                icon={
                  <Ionicons name="people-outline" size={iconSize.base} color={theme.color.brand} />
                }
              />
            }
          />
          <Row>
            <TextInput
              value={ghostName}
              onChangeText={setGhostName}
              placeholder={t.people.namePlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.misc.personName}
              onSubmitEditing={addTypedGhost}
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
              disabled={!ghostName.trim()}
              onPress={addTypedGhost}
            />
          </Row>

          {ghosts.length > 0 ? (
            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {ghosts.map((ghost, index) => (
                <Pressable
                  key={`${keyOfGhost(ghost)}-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={fill(t.itemize.removeItem, { label: ghost.name })}
                  onPress={() => setGhosts((current) => current.filter((_, i) => i !== index))}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: theme.spacing.md,
                    height: 32,
                    borderRadius: theme.radius.pill,
                    backgroundColor: theme.color.surfaceMuted,
                  }}
                >
                  <Text variant="caption">{ghost.name}</Text>
                  <Ionicons name="close" size={iconSize.sm} color={theme.color.textMuted} />
                </Pressable>
              ))}
            </Row>
          ) : null}
        </Card>

        {/* The group's settings, stated rather than hidden.

            This was a "More options" disclosure: one row that named none of the
            four things behind it, with the kind of group — already decided,
            already guessed from the name — sitting unread on its right. The
            shape it wears now is the expense screen's: a stack of named facts
            with their current values, hairlines between, each one a tap from
            being changed. The screen reads as a group that already exists and
            can be adjusted, which is what it is, instead of a form with a
            drawer of unanswered questions in it.

            Kind and simplify are always here; dates and budget are trip-only,
            so a dinner or a flat never sees them. The budget, left at zero, sets
            nothing; entered, it seeds the planner's overall cap on create.
            ADR-009: simplification is presentation only — the pairwise ledger
            underneath is untouched. */}
        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          <DetailRows>
            {/* Row plus the editor it unfolds, as one child, so the divider
                between rows lands above the row and not between a row and its
                own open editor. Same shape for the three that unfold. */}
            <View>
              <DetailRow
                icon={currentType.icon}
                label={t.extras.groupKind}
                value={currentType.label}
                expanded={openAttr === 'kind'}
                accessibilityLabel={`${t.extras.groupKind}, ${currentType.label}`}
                onPress={() => setOpenAttr((current) => (current === 'kind' ? null : 'kind'))}
              />
              {openAttr === 'kind' ? (
                <View style={{ paddingBottom: theme.spacing.md }}>
                  <ChipRow<GroupType>
                    value={type}
                    onChange={setPickedType}
                    options={typeOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                      icon: iconFor(option.icon),
                    }))}
                  />
                </View>
              ) : null}
            </View>

            {type === GroupType.Trip ? (
              <View>
                <DetailRow
                  icon="calendar-outline"
                  label={t.misc.tripDatesTitle}
                  value={dateSummary}
                  placeholder={!tripDates.start_date || !tripDates.end_date}
                  expanded={openAttr === 'dates'}
                  accessibilityLabel={`${t.misc.tripDatesTitle}, ${dateSummary}`}
                  onPress={() => setOpenAttr((current) => (current === 'dates' ? null : 'dates'))}
                />
                {openAttr === 'dates' ? (
                  <View style={{ paddingBottom: theme.spacing.md }}>
                    <TripDates
                      group={tripDates}
                      locale={locale}
                      embedded
                      onChange={(patch) => setTripDates((current) => ({ ...current, ...patch }))}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}

            {type === GroupType.Trip ? (
              <View>
                <DetailRow
                  icon="wallet-outline"
                  label={t.extras.tripBudget}
                  value={budgetSummary}
                  placeholder={budget <= 0n}
                  expanded={openAttr === 'budget'}
                  accessibilityLabel={`${t.extras.tripBudgetOptional}, ${budgetSummary}`}
                  onPress={() => setOpenAttr((current) => (current === 'budget' ? null : 'budget'))}
                />
                {openAttr === 'budget' ? (
                  <View style={{ paddingBottom: theme.spacing.md }}>
                    <AmountField currency={currency} value={budget} onChange={setBudget} />
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* The one row that is not tappable, because its control says the
                value and changes it in the same gesture. A chevron here would
                promise a second place to go that does not exist. */}
            <DetailRow
              icon="flash-outline"
              label={t.group.simplifyDebts}
              subtitle={t.group.simplifyDebtsHint}
              trailing={
                <Toggle
                  value={effectiveSimplify}
                  onValueChange={setSimplify}
                  accessibilityLabel={t.group.simplifyDebts}
                />
              }
            />
          </DetailRows>
        </Card>

        {/* Seed the whole form from a group you already have — a power move, so
            it is a quiet link at the foot, not a card above the real work.
            Hidden once you are already cloning: you are past the choosing. */}
        {!cloning ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.clone.startFromExisting}
            onPress={() => router.push('/clone-group')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.sm,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons name="copy-outline" size={iconSize.base} color={theme.color.brand} />
            <Text variant="subheading" style={{ color: theme.color.brand, fontWeight: '600' }}>
              {t.clone.startFromExisting}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {/* The primary action is pinned rather than parked at the foot of a long
          scroll: name, kind, country, dates, simplify and people all sit above
          it, and "just make the group" should not depend on scrolling past all
          of them first.

          The bottom padding is a plain spacing token, not useScreenClearance:
          the Screen above already applies the bottom safe-area inset on this
          screen, so a clearance hook would count the gesture bar twice. This is
          only the breathing room between the button and that inset. */}
      <View
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.md,
          gap: theme.spacing.sm,
          borderTopWidth: 1,
          borderTopColor: theme.color.border,
          backgroundColor: theme.color.bg,
        }}
      >
        {error ? <Callout tone="negative">{error}</Callout> : null}
        {createGroup.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}

        <Button
          label={t.misc.createGroup}
          size="lg"
          fullWidth
          disabled={createGroup.isPending}
          onPress={() => void submit()}
        />
      </View>
    </Screen>
  );
}
