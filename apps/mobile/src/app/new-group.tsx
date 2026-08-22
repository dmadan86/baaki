import { useState, type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  currencyForCountry,
  currencySymbol,
  guessGroupEmoji,
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
  Divider,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  Toggle,
  useTheme,
} from '@waves/ui';

import { GroupPhoto } from '@/components/GroupPhoto';
import { friendlyError } from '@/lib/errors';
import { type PickedContact } from '@/components/ContactPicker';
import { CoverEmojiPicker } from '@/components/CoverEmojiPicker';
import { InfoDisclosure } from '@/components/InfoDisclosure';
import { TripDates, type TripDatesValue } from '@/components/TripDates';
import { requestContacts } from '@/lib/contactPickerBridge';
import { useCreateGroup } from '@/data/hooks';
import { useGuestGuard } from '@/lib/guestGuard';
import { useSync } from '@/sync';
import { GroupType } from '@/data/types';
import { deviceCountry, fill, useStrings } from '@/i18n';

/**
 * Where the icon comes from when the name has not said anything yet — which is
 * the state this screen opens in, and the state a group called "Ravi and Asha"
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
 * One line of the combined attributes card: a label (with an optional one-line
 * hint under it) on the left, and its control — a value pill or a toggle — at
 * the far right, the way a task-details sheet stacks time, date and repeat.
 */
function AttrRow({
  label,
  subtitle,
  children,
}: {
  label: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Row
      style={{
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text variant="subheading" style={{ fontWeight: '600' }}>
          {label}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {children}
    </Row>
  );
}

/**
 * The tappable value on the right of an AttrRow: an icon and its current value
 * on a soft pill. It lights up in the brand tint while its editor is unfolded
 * below, so the open row is obvious.
 */
function Pill({
  icon,
  label,
  placeholder = false,
  expanded,
  onPress,
  accessibilityLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  placeholder?: boolean;
  expanded: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  const ink = expanded ? theme.color.brand : placeholder ? theme.color.textMuted : theme.color.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        paddingHorizontal: theme.spacing.md,
        height: 38,
        borderRadius: theme.radius.pill,
        backgroundColor: expanded ? theme.color.brandSoft : theme.color.surfaceMuted,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.base} color={ink} />
      <Text variant="subheading" style={{ fontWeight: '600', color: ink }}>
        {label}
      </Text>
    </Pressable>
  );
}

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
  const guard = useGuestGuard();
  const { mutate } = useSync();

  const [name, setName] = useState('');
  // The group cover is an emoji icon, chosen by tapping the avatar. Photos are
  // a paid feature edited from group settings, not part of creating one.
  const [iconOpen, setIconOpen] = useState(false);
  const [type, setType] = useState<GroupType>(GroupType.Trip);
  // Which attribute row of the combined card is unfolded, if any — one at a
  // time, so the card stays a short list until you open the one you want.
  const [openAttr, setOpenAttr] = useState<'kind' | 'dates' | 'budget' | null>(null);
  const [ghostName, setGhostName] = useState('');
  // People to add on Create — a typed name carries no address, a contact carries
  // whatever the phone had. Same shape either way, so the create loop treats
  // them alike.
  const [ghosts, setGhosts] = useState<PickedContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Not asked on this screen anymore — derived silently from the phone's locale
  // so the group still gets a sensible currency and settle rails (both changeable
  // later in group settings, which keeps the country row).
  const country: string | null = deviceCountry();
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

  // The icon is a reading of the name, unless somebody has chosen one; it
  // changes under the caret as they type "Goa" and again if they change the
  // kind of group.
  const emoji = pickedEmoji ?? guessGroupEmoji(name) ?? EMOJI_FOR_TYPE[type];
  // Trips and events benefit most from simplification; a two-person group does
  // not. Follows the type until somebody says otherwise.
  const effectiveSimplify = simplify ?? (type === GroupType.Trip || type === GroupType.Event);
  const currency = currencyForCountry(country) ?? 'INR';

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
          phone: ghost.phone,
        });
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

      router.replace(`/group/${groupId}`);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'newGroup.create'));
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
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.newGroup}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* One compact row: the cover — tapped to choose an icon — with the
            name inline beside it and a clear (×) once there is a name. */}
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
        </Card>

        {/* Controlled by the avatar tap above — no trigger of its own. */}
        <CoverEmojiPicker
          value={emoji}
          onChange={setPickedEmoji}
          open={iconOpen}
          onOpenChange={setIconOpen}
        />

        {/* Kind, dates, budget and simplify as one card of attribute rows —
            each a label with a value pill that unfolds its editor beneath, so
            the whole shape of a group is set from one short list rather than
            four stacked cards. Dates and budget are trip-only.

            The budget, left at zero, sets nothing; entered, it seeds the
            planner's overall cap on create so the Plan screen opens with the
            number already in it. ADR-009: simplification is presentation only —
            the pairwise ledger underneath is untouched. */}
        <Card style={{ gap: 0 }}>
          <AttrRow label={t.extras.groupKind}>
            <Pill
              icon={currentType.icon}
              label={currentType.label}
              expanded={openAttr === 'kind'}
              accessibilityLabel={t.extras.whatKindOfGroup}
              onPress={() => setOpenAttr((current) => (current === 'kind' ? null : 'kind'))}
            />
          </AttrRow>
          {openAttr === 'kind' ? (
            <View style={{ paddingBottom: theme.spacing.md }}>
              <ChipRow<GroupType>
                value={type}
                onChange={(next) => {
                  setType(next);
                  setOpenAttr(null);
                }}
                options={typeOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                  icon: iconFor(option.icon),
                }))}
              />
            </View>
          ) : null}

          {type === GroupType.Trip ? (
            <>
              <Divider />
              <AttrRow label={t.misc.tripDatesTitle}>
                <Pill
                  icon="calendar-outline"
                  label={dateSummary}
                  placeholder={!tripDates.start_date || !tripDates.end_date}
                  expanded={openAttr === 'dates'}
                  accessibilityLabel={t.misc.tripDatesTitle}
                  onPress={() => setOpenAttr((current) => (current === 'dates' ? null : 'dates'))}
                />
              </AttrRow>
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

              <Divider />
              <AttrRow label={t.extras.tripBudget}>
                <Pill
                  icon="wallet-outline"
                  label={budgetSummary}
                  placeholder={budget <= 0n}
                  expanded={openAttr === 'budget'}
                  accessibilityLabel={t.extras.tripBudgetOptional}
                  onPress={() => setOpenAttr((current) => (current === 'budget' ? null : 'budget'))}
                />
              </AttrRow>
              {openAttr === 'budget' ? (
                <View style={{ paddingBottom: theme.spacing.md }}>
                  <AmountField currency={currency} value={budget} onChange={setBudget} />
                </View>
              ) : null}
            </>
          ) : null}

          <Divider />
          <AttrRow label={t.group.simplifyDebts} subtitle={t.group.simplifyDebtsHint}>
            <Toggle
              value={effectiveSimplify}
              onValueChange={setSimplify}
              accessibilityLabel={t.group.simplifyDebts}
            />
          </AttrRow>
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <InfoDisclosure
            title={t.extras.addPeopleByName}
            info={t.extras.ghostNote}
            titleVariant="caption"
            right={
              // Opens the address book on its own screen rather than unfolding
              // it inline — a thousand-name list needs the whole height. Nobody's
              // book is uploaded (ADR-006). The picker hands its answer back
              // through the bridge into `addContacts`.
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.people.browseContacts}
                hitSlop={8}
                onPress={openContactPicker}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Ionicons name="people-outline" size={iconSize.base} color={theme.color.brand} />
                <Text variant="caption" style={{ color: theme.color.brand }}>
                  {t.people.contacts}
                </Text>
              </Pressable>
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
      </ScrollView>

      {/* The primary action is pinned rather than parked at the foot of a long
          scroll: name, kind, country, dates, simplify and people all sit above
          it, and "just make the group" should not depend on scrolling past all
          of them first. */}
      <View
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
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
