import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, Share, View } from 'react-native';

import { Badge, Button, Card, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { mintInvite, type MintedInvite } from '@/data/api';
import { useGroup } from '@/data/hooks';
import { useStrings } from '@/i18n';

/**
 * Web-lite (M3) will serve this path; until then the link deep-links straight
 * into the app, which is what the people being invited here actually have.
 */
const INVITE_BASE = 'https://baaki.app/join';

export default function InviteScreen() {
  const theme = useTheme();
  const { locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const { group } = useGroup(groupId);
  const [invite, setInvite] = useState<MintedInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const link = invite ? `${INVITE_BASE}#${invite.token}` : null;

  const mint = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await mintInvite(groupId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const share = async (): Promise<void> => {
    if (!link) return;
    await Share.share({
      message: `Join "${group.data?.name ?? 'our group'}" on Baaki — no app needed to start: ${link}`,
    });
  };

  const copy = async (): Promise<void> => {
    if (!link) return;
    await Clipboard.setStringAsync(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Close" onPress={() => router.back()}>
            <Ionicons name="close" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">Invite people</Text>
            <Text variant="micro" tone="muted">
              {group.data?.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading">Anyone with the link can join</Text>
          <Text variant="caption" tone="muted">
            They do not need to install anything or make an account to see the group and add
            expenses. If they were already in it as a name, they can claim that history when they
            join.
          </Text>
        </Card>

        {invite && link ? (
          <>
            <Card style={{ gap: theme.spacing.md }}>
              <Text variant="caption" tone="muted">
                Invite link
              </Text>
              <Text variant="body" style={{ color: theme.color.brand }} selectable>
                {link}
              </Text>
              <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                <Badge
                  label={`expires ${new Intl.DateTimeFormat(locale, {
                    day: 'numeric',
                    month: 'short',
                  }).format(new Date(invite.expiresAt))}`}
                />
                <Badge label={`${invite.maxUses} uses`} />
              </Row>
            </Card>

            <Row style={{ gap: theme.spacing.md }}>
              <Button
                label="Share"
                size="lg"
                onPress={() => void share()}
                icon={<Ionicons name="share-outline" size={18} color={theme.color.onBrand} />}
              />
              <Button
                label={copied ? 'Copied' : 'Copy link'}
                variant="secondary"
                size="lg"
                onPress={() => void copy()}
              />
            </Row>

            <Text variant="micro" tone="faint" align="center">
              Made a link by mistake? Mint a new one — the old link keeps working until it expires,
              so only share links you mean to.
            </Text>
          </>
        ) : (
          <Button
            label="Create an invite link"
            size="lg"
            fullWidth
            disabled={busy}
            onPress={() => void mint()}
          />
        )}

        {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
        {error ? (
          <Text variant="caption" tone="negative">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
