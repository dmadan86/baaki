import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { fill, useStrings } from '@/i18n';

import { acceptInvite, previewInvite, type InvitePreview } from '@/data/api';
import { keys } from '@/data/hooks';
import { useAuth } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';

/**
 * Landing screen for an invite link (ADR-006).
 *
 * The link shows a real preview of the group before asking for anything, and
 * the "is one of these you?" step is the ghost-claim flow: pick your name and
 * every expense already recorded against it becomes yours.
 */
export default function JoinScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { session, continueAsGuest } = useAuth();
  const guard = useGuestGuard();
  const queryClient = useQueryClient();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [busy, setBusy] = useState(Boolean(token));
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The group whose admin has been asked, once a claim has been sent. */
  const [pending, setPending] = useState<string | null>(null);

  /**
   * Whether the route parameters have had a chance to arrive.
   *
   * A link with no token looked like something that could be judged during the
   * first render. It cannot: a deep link is parsed a frame later, so on a real
   * invite opened on a real phone the screen said "This link is missing its
   * invite code" and then went on saying it while the group name, the member
   * list and a working Join button loaded underneath. Waiting a tick before
   * calling a link broken is the whole fix.
   */
  const [settled, setSettled] = useState(Boolean(token));
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), 0);
    return () => clearTimeout(timer);
  }, [settled]);

  const shown = error ?? (!token && settled ? t.misc.linkMissingCode : null);

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

  /**
   * `claim` is passed rather than read from state because "join as someone new
   * instead" clears it and joins in the same tap — and a state update is not
   * visible to the call that follows it, so the old claim would be sent again.
   */
  const join = async (claim: string | null = claimId): Promise<void> => {
    if (!token) return;
    // An existing guest holds one group (ADR-006 addendum); joining a second
    // sends them to sign up instead. A brand-new person with no session yet is
    // not a guest, so `guard.gate` is null and their first join is never gated.
    if (guard.blockAddGroup()) return;
    setJoining(true);
    setError(null);
    try {
      // Nobody is forced to register to accept an invite.
      if (!session) await continueAsGuest();
      const result = await acceptInvite({ token, claimMemberId: claim });

      // Claiming somebody's place only asks. Routing into the group here would
      // land on a screen the person cannot read yet, because they are not a
      // member until an admin agrees.
      if ('pending' in result) {
        setPending(result.group.name);
        return;
      }

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
          title={t.misc.linkExpired}
          body={shown ?? t.misc.linkExpiredBody}
          action={<Button label={t.misc.goToBaaki} onPress={() => router.replace('/')} />}
        />
      </Screen>
    );
  }

  if (pending) {
    const claimed = preview.claimable.find((candidate) => candidate.memberId === claimId);
    return (
      <Screen edges={['top', 'bottom']}>
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.xl,
            gap: theme.spacing.xl,
          }}
        >
          <Card style={{ alignItems: 'center', gap: theme.spacing.md }}>
            <Ionicons name="hourglass-outline" size={40} color={theme.color.brand} />
            <Text variant="subheading" align="center">
              {t.claims.waitingTitle}
            </Text>
            <Text variant="caption" tone="muted" align="center">
              {fill(t.claims.waitingBody, {
                group: pending,
                name: claimed?.name ?? t.misc.unnamed,
              })}
            </Text>
          </Card>

          {/* The way out of waiting on an admin who never opens the app. The
              claim is left standing: if they answer it later and this person
              has since joined as themselves, the approval refuses rather than
              making them a member twice. */}
          <Button
            label={t.claims.joinAsNewInstead}
            variant="secondary"
            fullWidth
            disabled={joining}
            onPress={() => {
              setClaimId(null);
              setPending(null);
              void join(null);
            }}
          />
          <Button label={t.misc.goToBaaki} variant="ghost" onPress={() => router.replace('/')} />
        </View>
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
          <Badge label={t.misc.freeNoAccount} tone="positive" />
        </Card>

        {preview.claimable.length > 0 ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">{t.misc.isOneOfTheseYou}</Text>
            <Text variant="caption" tone="muted">
              {t.extras.claimHistoryNote}
            </Text>
            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.md }}>
              {preview.claimable.map((candidate) => (
                <Pressable
                  key={candidate.memberId}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: claimId === candidate.memberId }}
                  accessibilityLabel={candidate.name ?? t.misc.unnamed}
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
                    {candidate.name ?? t.misc.unnamed}
                  </Text>
                </Pressable>
              ))}
            </Row>
            {claimId ? (
              <Row style={{ gap: theme.spacing.sm }}>
                <Ionicons name="information-circle-outline" size={16} color={theme.color.brand} />
                <Text variant="micro" tone="brand" style={{ flex: 1 }}>
                  {`${t.extras.theirPastBecomesYours} ${t.claims.needsConfirming}`}
                </Text>
              </Row>
            ) : null}
          </Card>
        ) : null}

        {shown ? <Callout tone="negative">{shown}</Callout> : null}

        <Button
          // Claiming asks; joining as somebody new does not. The button says
          // which of the two is about to happen.
          label={
            claimId
              ? fill(t.claims.askToJoinAs, {
                  name:
                    preview.claimable.find((candidate) => candidate.memberId === claimId)?.name ??
                    t.misc.unnamed,
                })
              : t.misc.joinGroup
          }
          size="lg"
          fullWidth
          disabled={joining}
          onPress={() => void join()}
        />
        {joining ? <ActivityIndicator color={theme.color.brand} /> : null}

        <Text variant="micro" tone="faint" align="center">
          {t.extras.guestKeepsItHere}
        </Text>
      </ScrollView>
    </Screen>
  );
}
