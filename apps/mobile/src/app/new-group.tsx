import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { Button, Card, ChipRow, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { addGhostMember } from '@/data/api';
import { useCreateGroup } from '@/data/hooks';
import type { GroupType } from '@/data/types';
import { useStrings } from '@/i18n';

const EMOJI = ['🏖️', '🏠', '💜', '🎉', '✈️', '🍽️', '⛰️', '🎓'];

export default function NewGroupScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const createGroup = useCreateGroup();

  const [name, setName] = useState('');
  const [type, setType] = useState<GroupType>('trip');
  const [emoji, setEmoji] = useState(EMOJI[0] as string);
  const [ghostName, setGhostName] = useState('');
  const [ghosts, setGhosts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    try {
      const groupId = await createGroup.mutateAsync({
        name: name.trim(),
        type,
        currency: 'INR',
        emoji,
        // Trips benefit most from simplification; a two-person group does not.
        simplify: type === 'trip' || type === 'event',
      });
      // ADR-006: people who have not installed anything are still participants.
      for (const ghost of ghosts) {
        await addGhostMember(groupId, ghost);
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
          <IconButton label="Close" onPress={() => router.back()}>
            <Ionicons name="close" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.newGroup}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <Text variant="caption" tone="muted">
            Group name
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Goa trip"
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel="Group name"
            autoFocus
            style={{
              fontSize: 22,
              fontWeight: '700',
              color: theme.color.text,
              paddingVertical: theme.spacing.sm,
            }}
          />

          <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {EMOJI.map((option) => (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ selected: emoji === option }}
                accessibilityLabel={`Icon ${option}`}
                onPress={() => setEmoji(option)}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: theme.radius.pill,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor:
                    emoji === option ? theme.color.brandSoft : theme.color.surfaceMuted,
                }}
              >
                <Text variant="subheading">{option}</Text>
              </Pressable>
            ))}
          </Row>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            What kind of group?
          </Text>
          <ChipRow<GroupType>
            value={type}
            onChange={setType}
            options={[
              { value: 'trip', label: 'Trip' },
              { value: 'home', label: 'Home' },
              { value: 'couple', label: 'Couple' },
              { value: 'event', label: 'Event' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </View>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            Add people by name
          </Text>
          <Text variant="micro" tone="faint">
            They do not need the app. Add them now and they can claim their history later.
          </Text>
          <Row>
            <TextInput
              value={ghostName}
              onChangeText={setGhostName}
              placeholder="Rahul"
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel="Person's name"
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
              label="Add"
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
        {createGroup.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}

        <Button
          label="Create group"
          size="lg"
          fullWidth
          disabled={!name.trim() || createGroup.isPending}
          onPress={() => void submit()}
        />
      </ScrollView>
    </Screen>
  );
}
