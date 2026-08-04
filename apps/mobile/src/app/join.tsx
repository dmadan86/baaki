import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { Avatar, Badge, Button, Card, EmptyState, Row, Screen, Text, useTheme } from '@baaki/ui';

import { acceptInvite, previewInvite, type InvitePreview } from '@/data/api';
import { keys } from '@/data/hooks';
import { useAuth } from '@/lib/auth';

/**
 * Landing screen for an invite link (ADR-006).
 *
 * The link shows a real preview of the group before asking for anything, and
 * the "is one of these you?" step is the ghost-claim flow: pick your name and
 * every expense already recorded against it becomes yours.
 */
export default function JoinScreen() {
  const theme = useTheme();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { session, continueAsGuest } = useAuth();
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  // A link with no token can be judged during render; no effect needed.
  const [busy, setBusy] = useState(Boolean(token));
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(
    token ? null : 'This link is missing its invite code',
  );

  useEffect(() => {
    let active = true;
    if (!token) return;
    void (async () => {
      try {
        const result = await previewInvite(token);
        if (active) setPreview(result);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  const join = async (): Promise<void> => {
    if (!token) return;
    setJoining(true);
    setError(null);
    try {
      // Nobody is forced to register to accept an invite.
      if (!session) await continueAsGuest();
      const result = await acceptInvite({ token, claimMemberId: claimId });
      await queryClient.invalidateQueries({ queryKey: keys.groups });
      router.replace(`/group/${result.group.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setJoining(false);
    }
  };

  if (busy) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.color.brand} />
        </View>
      </Screen>
    );
  }

  if (!preview?.group) {
    return (
      <Screen>
        <EmptyState
          title="This link has expired"
          body={
            error ??
            'Ask whoever sent it for a fresh one — links expire so they cannot be passed around forever.'
          }
          action={<Button label="Go to Baaki" onPress={() => router.replace('/')} />}
        />
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
          flexGrow: 1,
          justifyContent: 'center',
        }}
      >
        <Card style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <Avatar name={preview.group.name} emoji={preview.group.cover_emoji ?? '👥'} size={78} />
          <Text variant="title" align="center">
            {preview.group.name}
          </Text>
          <Text variant="caption" tone="muted" align="center">
            {`${preview.memberCount} people are splitting expenses here`}
          </Text>
          <Badge label="Free forever, no account needed" tone="positive" />
        </Card>

        {preview.claimable.length > 0 ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">Is one of these you?</Text>
            <Text variant="caption" tone="muted">
              Pick your name and everything already recorded for you comes with you.
            </Text>
            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.md }}>
              {preview.claimable.map((candidate) => (
                <Pressable
                  key={candidate.memberId}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: claimId === candidate.memberId }}
                  accessibilityLabel={candidate.name ?? 'Unnamed'}
                  onPress={() =>
                    setClaimId((current) =>
                      current === candidate.memberId ? null : candidate.memberId,
                    )
                  }
                  style={{
                    alignItems: 'center',
                    gap: 4,
                    opacity: claimId === candidate.memberId ? 1 : 0.5,
                  }}
                >
                  <Avatar name={candidate.name ?? '?'} ghost size={52} />
                  <Text variant="micro" tone={claimId === candidate.memberId ? 'brand' : 'muted'}>
                    {candidate.name ?? 'Unnamed'}
                  </Text>
                </Pressable>
              ))}
            </Row>
            {claimId ? (
              <Row style={{ gap: theme.spacing.sm }}>
                <Ionicons name="information-circle-outline" size={16} color={theme.color.brand} />
                <Text variant="micro" tone="brand" style={{ flex: 1 }}>
                  Their past expenses and balances become yours.
                </Text>
              </Row>
            ) : null}
          </Card>
        ) : null}

        {error ? (
          <Text variant="caption" tone="negative" align="center">
            {error}
          </Text>
        ) : null}

        <Button
          label={claimId ? 'Join and claim my history' : 'Join this group'}
          size="lg"
          fullWidth
          disabled={joining}
          onPress={() => void join()}
        />
        {joining ? <ActivityIndicator color={theme.color.brand} /> : null}

        <Text variant="micro" tone="faint" align="center">
          Joining as a guest keeps everything on this device. Add a phone number later and it all
          comes with you.
        </Text>
      </ScrollView>
    </Screen>
  );
}
