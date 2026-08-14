import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { currencyForCountry, guessGroupEmoji, MutationKind } from '@baaki/core';
import {
  Button,
  Callout,
  Card,
  ChipRow,
  IconButton,
  Row,
  Screen,
  Text,
  Toggle,
  useTheme,
} from '@baaki/ui';

import { GroupPhoto } from '@/components/GroupPhoto';
import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { CountryRow } from '@/components/CountryPicker';
import { CoverEmojiPicker } from '@/components/CoverEmojiPicker';
import { InfoDisclosure } from '@/components/InfoDisclosure';
import { TripDates, type TripDatesValue } from '@/components/TripDates';
import { pickGroupPhoto, type PickedImage } from '@/lib/image';
import { uploadGroupPhoto } from '@/data/api';
import { useCreateGroup } from '@/data/hooks';
import { useGuestGuard } from '@/lib/guestGuard';
import { useSync } from '@/sync';
import { GroupType } from '@/data/types';
import { deviceCountry, useStrings } from '@/i18n';

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
  [GroupType.Other]: '👥',
};

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';

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
  const { mutate, flush } = useSync();

  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [type, setType] = useState<GroupType>(GroupType.Trip);
  const [ghostName, setGhostName] = useState('');
  // People to add on Create — a typed name carries no address, a contact carries
  // whatever the phone had. Same shape either way, so the create loop treats
  // them alike.
  const [ghosts, setGhosts] = useState<PickedContact[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read once, not on every render: a phone does not change country mid-form.
  const [country, setCountry] = useState<string | null>(() => deviceCountry());
  // Null until somebody picks: the icon is otherwise read from the name, so an
  // untouched group still gets a sensible cover.
  const [pickedEmoji, setPickedEmoji] = useState<string | null>(null);
  // Null until toggled, so it can follow the group type's default until then.
  const [simplify, setSimplify] = useState<boolean | null>(null);
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
  const effectiveSimplify = simplify ?? (type === 'trip' || type === 'event');
  const currency = currencyForCountry(country) ?? 'INR';

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
      if (tripDates.start_date && tripDates.end_date) {
        await mutate(MutationKind.GroupUpdate, groupId, {
          start_date: tripDates.start_date,
          end_date: tripDates.end_date,
          time_zone: tripDates.time_zone,
          remind_daily: tripDates.remind_daily,
          remind_morning_at: tripDates.remind_morning_at,
          remind_evening_at: tripDates.remind_evening_at,
        });
      }

      // The photo lives in Storage, not the offline queue, and its policy is
      // "members of this group only" — which needs the group and the membership
      // row actually on the server. Flush the queued create (and everything
      // behind it) before writing an object under its id.
      if (photo) {
        setUploading(true);
        try {
          await flush([groupId]);
          await uploadGroupPhoto({ groupId, base64: photo.base64, mimeType: photo.mimeType });
        } catch {
          // A photo that would not upload is not worth losing the group over;
          // it can be added again from group settings.
        } finally {
          setUploading(false);
        }
      }
      router.replace(`/group/${groupId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
    setBrowsing(false);
  };

  // The contacts already queued, so the picker greys them rather than letting
  // somebody add the same person twice.
  const alreadyPicked = new Set(
    ghosts.flatMap((ghost) =>
      [ghost.email, ghost.phone].filter((value): value is string => Boolean(value)),
    ),
  );

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
            <Ionicons name="close" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.newGroup}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ gap: theme.spacing.lg }}>
            <GroupPhoto
              photoPath={null}
              localUri={photo?.uri ?? null}
              emoji={emoji}
              size={72}
              onPress={() => void pickGroupPhoto().then(setPhoto)}
            />
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
              <InfoDisclosure
                title={t.group.nameOptional}
                info={t.extras.blankNameHint}
                titleVariant="caption"
              />
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={t.misc.newGroupPlaceholder}
                placeholderTextColor={theme.color.textFaint}
                accessibilityLabel={t.group.groupName}
                autoFocus
                style={{
                  fontSize: 22,
                  fontWeight: '700',
                  color: theme.color.text,
                  paddingVertical: theme.spacing.sm,
                }}
              />
            </View>
          </Row>

          <Row style={{ gap: theme.spacing.sm }}>
            <CoverEmojiPicker value={emoji} onChange={setPickedEmoji} />
          </Row>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.extras.whatKindOfGroup}
          </Text>
          <ChipRow<GroupType>
            value={type}
            onChange={setType}
            options={[
              { value: GroupType.Trip, label: t.extras.typeTrip },
              { value: GroupType.Home, label: t.extras.typeHome },
              { value: GroupType.Couple, label: t.extras.typeCouple },
              { value: GroupType.Event, label: t.extras.typeEvent },
              { value: GroupType.Other, label: t.extras.typeOther },
            ]}
          />
        </View>

        {/* Decides which payment rails the settle screen offers, and what a new
            expense starts in. The same flagged row the settings screen uses. */}
        <CountryRow countryCode={country} onChange={setCountry} />

        <TripDates
          group={tripDates}
          locale={locale}
          onChange={(patch) => setTripDates((current) => ({ ...current, ...patch }))}
        />

        {/* ADR-009: simplification is presentation only — the pairwise ledger
            underneath is untouched. */}
        <Card>
          <InfoDisclosure
            title={t.group.simplifyDebts}
            info={t.group.simplifyDebtsBody}
            right={
              <Toggle
                value={effectiveSimplify}
                onValueChange={setSimplify}
                accessibilityLabel={t.group.simplifyDebts}
              />
            }
          />
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <InfoDisclosure
            title={t.extras.addPeopleByName}
            info={t.extras.ghostNote}
            titleVariant="caption"
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

          {/* The same phone-contacts picker the Members screen uses. It reads
              the address book on the device and only the people ticked come
              back — nobody's book is uploaded (ADR-006). */}
          <Button
            label={browsing ? t.people.hideContacts : t.people.browseContacts}
            variant="ghost"
            onPress={() => setBrowsing((open) => !open)}
          />

          {browsing ? (
            // Tall enough that the letter rail has something to aim at — a
            // short window turns a thousand contacts back into a peephole.
            <View style={{ height: 480 }}>
              <ContactPicker onConfirm={addContacts} existing={alreadyPicked} />
            </View>
          ) : null}

          {ghosts.length > 0 ? (
            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {ghosts.map((ghost, index) => (
                <Pressable
                  key={`${keyOfGhost(ghost)}-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${ghost.name}`}
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
                  <Ionicons name="close" size={14} color={theme.color.textMuted} />
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
        {createGroup.isPending || uploading ? (
          <ActivityIndicator color={theme.color.brand} />
        ) : null}

        <Button
          label={t.misc.createGroup}
          size="lg"
          fullWidth
          disabled={createGroup.isPending || uploading}
          onPress={() => void submit()}
        />
      </View>
    </Screen>
  );
}
