import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import {
  useAddGhostMember,
  useDecideMemberClaim,
  useGroup,
  useGroupLedger,
  useMemberClaims,
} from '@/data/hooks';
import { displayName, groupLabel, isGhost, vpaOf } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

export default function MembersScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const addGhost = useAddGhostMember(groupId);
  const claims = useMemberClaims(groupId);
  const decide = useDecideMemberClaim(groupId);

  const [ghostName, setGhostName] = useState('');
  const [ghostContact, setGhostContact] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const currency = group.data?.default_currency ?? 'INR';
  const ghosts = (members.data ?? []).filter(isGhost);

  /**
   * Answering a claim (ADR-006).
   *
   * The refusals are worth their own sentences: an admin who taps Confirm a
   * second later than another admin, or on a place somebody has since taken,
   * is not looking at a failure — they are looking at an answer that already
   * happened, and "something went wrong" would send them to check the network.
   */
  const answer = (claimId: string, approve: boolean): void => {
    setClaimError(null);
    decide.mutate(
      { claimId, approve },
      {
        onSuccess: (verdict) => {
          if (verdict.ok) return;
          const said =
            verdict.reason === 'ALREADY_DECIDED'
              ? t.claims.alreadyDecided
              : verdict.reason === 'ALREADY_A_MEMBER'
                ? t.claims.theyAreAlreadyIn
                : verdict.reason === 'NOT_CLAIMABLE'
                  ? t.claims.placeTaken
                  : t.claims.decideFailed;
          setClaimError(said);
        },
        onError: (caught) =>
          setClaimError(friendlyError(caught, t.claims.decideFailed, 'claims.decide')),
      },
    );
  };

  /**
   * One field for the address, whichever kind it is. Asking somebody to first
   * declare "email or phone?" and then type it is a question the text itself
   * already answers.
   */
  const contactOf = (value: string): { email?: string; phone?: string } => {
    const trimmed = value.trim();
    if (!trimmed) return {};
    return trimmed.includes('@') ? { email: trimmed } : { phone: trimmed };
  };

  const add = (): void => {
    const name = ghostName.trim();
    const contact = contactOf(ghostContact);
    if (!name && !contact.email && !contact.phone) return;
    setError(null);
    addGhost.mutate(
      { name, ...contact },
      {
        onSuccess: () => {
          setGhostName('');
          setGhostContact('');
        },
        onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
      },
    );
  };

  /**
   * Several people at once, one call each — the server takes one member per
   * request and batching them here would only hide which of them failed.
   *
   * They are added in sequence rather than in parallel because a batch of
   * simultaneous writes to the same group races the balance triggers for no
   * benefit; nobody picks contacts fast enough for the wait to show.
   *
   * A failure part-way does not undo the ones already in. Adding somebody is
   * not a transaction — it is five separate acts — so the honest report is
   * which names did not make it, not a rollback nobody asked for.
   */
  const addPicked = async (people: readonly PickedContact[]): Promise<void> => {
    setError(null);
    setAdding(true);
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
        // The first refusal's own words, kept so the message can say why rather
        // than only which names did not make it.
        if (!reason) reason = caught instanceof Error ? caught.message : String(caught);
      }
    }
    setAdding(false);
    if (failed.length === 0) {
      setBrowsing(false);
      return;
    }
    setError(fill(t.misc.couldNotAddSome, { reason: reason ?? '' }));
  };

  // Contacts already used, so the picker can grey them out instead of letting
  // somebody add the same person twice. The server would collapse it anyway —
  // this just makes the reason visible.
  const alreadyAdded = new Set(
    (members.data ?? []).flatMap((member) =>
      [member.invite_email, member.invite_phone].filter((value): value is string => Boolean(value)),
    ),
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.members}</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <IconButton
            label={t.people.invite}
            onPress={() => router.push(`/group/${groupId}/invite`)}
          >
            <Ionicons name="share-outline" size={iconSize.md} color={theme.color.brand} />
          </IconButton>
        </Row>

        {/* Above the member list, because it is a question and the list is not.
            Only admins ever see anything here: the function returns no rows to
            anybody else, so the screen does not have to know who is one. */}
        {(claims.data ?? []).length > 0 ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">{t.claims.requestsTitle}</Text>
            {claimError ? <Callout tone="negative">{claimError}</Callout> : null}
            {(claims.data ?? []).map((claim) => (
              <View key={claim.id} style={{ gap: theme.spacing.sm }}>
                <Row style={{ gap: theme.spacing.md }}>
                  <Avatar name={claim.ghost_name ?? '?'} ghost />
                  <Text variant="body" style={{ flex: 1 }}>
                    {fill(t.claims.saysTheyAre, {
                      who: claim.requested_name ?? claim.requester_name ?? t.misc.unnamed,
                      name: claim.ghost_name ?? t.misc.unnamed,
                    })}
                  </Text>
                </Row>
                <Row style={{ gap: theme.spacing.sm }}>
                  <Button
                    label={t.claims.approve}
                    size="sm"
                    disabled={decide.isPending}
                    onPress={() => answer(claim.id, true)}
                  />
                  <Button
                    label={t.claims.decline}
                    size="sm"
                    variant="secondary"
                    disabled={decide.isPending}
                    onPress={() => answer(claim.id, false)}
                  />
                </Row>
              </View>
            ))}
          </Card>
        ) : null}

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

        {/* ADR-006: a name is enough to start splitting with someone. */}
        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.people.addSomeone}
          </Text>
          <Row>
            <TextInput
              value={ghostName}
              onChangeText={setGhostName}
              placeholder={t.people.namePlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.common.name}
              onSubmitEditing={add}
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
              disabled={(!ghostName.trim() && !ghostContact.trim()) || addGhost.isPending}
              onPress={add}
            />
          </Row>

          <TextInput
            value={ghostContact}
            onChangeText={setGhostContact}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder={t.people.contactPlaceholder}
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel={t.common.emailOrPhone}
            onSubmitEditing={add}
            style={{
              fontSize: 15,
              color: theme.color.text,
              paddingVertical: theme.spacing.sm,
            }}
          />

          <Button
            label={browsing ? t.people.hideContacts : t.people.browseContacts}
            variant="ghost"
            onPress={() => setBrowsing((open) => !open)}
          />

          {browsing ? (
            // Tall enough that the letter rail has something to aim at — a
            // 320pt window turns a thousand contacts back into a peephole.
            <View style={{ height: 480 }}>
              <ContactPicker
                onConfirm={(people) => void addPicked(people)}
                existing={alreadyAdded}
                busy={adding}
              />
            </View>
          ) : null}
          <Text variant="micro" tone="muted">
            {t.misc.nameAloneBody}
          </Text>
          {addGhost.isPending || adding ? <ActivityIndicator color={theme.color.brand} /> : null}
          {error ? <Callout tone="negative">{error}</Callout> : null}
        </Card>

        {ghosts.length > 0 ? (
          <Row style={{ justifyContent: 'space-between' }}>
            <Badge label={plural(locale, ghosts.length, t.people.yetToJoin)} />
            <Text
              variant="caption"
              tone="brand"
              onPress={() => router.push(`/group/${groupId}/invite`)}
            >
              {t.people.sendInviteLink}
            </Text>
          </Row>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
