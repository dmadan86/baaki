import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { currencyForCountry, guessGroupEmoji } from '@baaki/core';
import { Button, Card, ChipRow, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { GroupPhoto } from '@/components/GroupPhoto';
import { pickGroupPhoto, type PickedImage } from '@/lib/image';
import { uploadGroupPhoto } from '@/data/api';
import { useCreateGroup } from '@/data/hooks';
import { useSync } from '@/sync';
import type { GroupType } from '@/data/types';
import { deviceCountry, useStrings } from '@/i18n';

/**
 * Where the icon comes from when the name has not said anything yet — which is
 * the state this screen opens in, and the state a group called "Ravi and Asha"
 * stays in. The kind of group is a real answer to "what is this", so it is a
 * better fallback than one fixed emoji for everybody.
 */
const EMOJI_FOR_TYPE: Record<GroupType, string> = {
  trip: '✈️',
  home: '🏠',
  couple: '💜',
  event: '🎉',
  other: '👥',
};

export default function NewGroupScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const createGroup = useCreateGroup();
  const { mutate, flush } = useSync();

  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [type, setType] = useState<GroupType>('trip');
  const [ghostName, setGhostName] = useState('');
  const [ghosts, setGhosts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Read once, not on every render: a phone does not change country mid-form,
  // and re-reading it would be a new value every time for `useMemo` to chase.
  const [country] = useState(() => deviceCountry());

  // Derived, not held: the icon is a reading of the name, so it has no state of
  // its own to fall out of step with. It changes under the caret as somebody
  // types "Goa" and again if they change what kind of group this is.
  const emoji = guessGroupEmoji(name) ?? EMOJI_FOR_TYPE[type];

  const submit = async (): Promise<void> => {
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
        currency: currencyForCountry(country) ?? 'INR',
        emoji,
        // Trips benefit most from simplification; a two-person group does not.
        simplify: type === 'trip' || type === 'event',
      });
      // ADR-006: people who have not installed anything are still participants.
      //
      // Queued through the same offline pipe as the group, not sent as a direct
      // RPC. The create above only resolves once it is on disk, not once it has
      // reached the server — so a direct `baaki_add_ghost_member` here raced the
      // create and hit a group the server had never seen, which is exactly the
      // membership check it fails: `NOT_A_MEMBER`. Behind the create in one
      // ordered queue, each ghost applies after the group it belongs to exists.
      for (const ghost of ghosts) {
        await mutate('member.add_ghost', groupId, {
          memberId: randomUUID(),
          name: ghost,
          email: null,
          phone: null,
        });
      }
      // The photo lives in Storage, not the offline queue, and the storage
      // policy is "members of this group only" — which needs the group, and the
      // membership row, to actually be on the server. Flush the queued create
      // (and the ghosts behind it) before writing an object under its id.
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

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
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
              <Text variant="caption" tone="muted">
                Group name (optional)
              </Text>
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
              <Text variant="micro" tone="faint">
                {t.extras.blankNameHint}
              </Text>
            </View>
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
              { value: 'trip', label: t.extras.typeTrip },
              { value: 'home', label: t.extras.typeHome },
              { value: 'couple', label: t.extras.typeCouple },
              { value: 'event', label: t.extras.typeEvent },
              { value: 'other', label: t.extras.typeOther },
            ]}
          />
        </View>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.extras.addPeopleByName}
          </Text>
          <Text variant="micro" tone="faint">
            {t.extras.ghostNote}
          </Text>
          <Row>
            <TextInput
              value={ghostName}
              onChangeText={setGhostName}
              placeholder={t.people.namePlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.misc.personName}
              onSubmitEditing={() => {
                if (ghostName.trim()) {
                  setGhosts((current) => [...current, ghostName.trim()]);
                  setGhostName('');
                }
              }}
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
              onPress={() => {
                setGhosts((current) => [...current, ghostName.trim()]);
                setGhostName('');
              }}
            />
          </Row>

          {ghosts.length > 0 ? (
            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {ghosts.map((ghost, index) => (
                <Pressable
                  key={`${ghost}-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${ghost}`}
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
                  <Text variant="caption">{ghost}</Text>
                  <Ionicons name="close" size={14} color={theme.color.textMuted} />
                </Pressable>
              ))}
            </Row>
          ) : null}
        </Card>

        {error ? (
          <Text variant="caption" tone="negative">
            {error}
          </Text>
        ) : null}
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
      </ScrollView>
    </Screen>
  );
}
