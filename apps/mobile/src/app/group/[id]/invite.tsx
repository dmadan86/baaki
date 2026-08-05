import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Linking, Platform, ScrollView, Share, View } from 'react-native';

import { Badge, Button, Card, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { mintInvite, type MintedInvite } from '@/data/api';
import { useGroup } from '@/data/hooks';
import { groupLabel } from '@/data/types';
import { useAuth } from '@/lib/auth';
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

  const { group, members } = useGroup(groupId);
  const { profile } = useAuth();
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

  const label = groupLabel(group.data, members.data ?? [], profile?.id);
  const message = `Join ${label} on Baaki to split expenses — no app or account needed to start: ${link}`;

  const share = async (): Promise<void> => {
    if (!link) return;
    await Share.share({ message });
  };

  /**
   * The share sheet already reaches every app on the phone, but the three
   * people actually use are worth one tap rather than three. Each is a plain
   * URL scheme, so nothing here depends on those apps having an SDK.
   */
  const shareVia = async (channel: 'whatsapp' | 'sms' | 'email'): Promise<void> => {
    if (!link) return;
    const url =
      channel === 'whatsapp'
        ? `whatsapp://send?text=${encodeURIComponent(message)}`
        : channel === 'sms'
          ? // iOS wants '&body=', Android wants '?body=' — the separator is the
            // only difference, and getting it wrong silently drops the text.
            `sms:${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(message)}`
          : `mailto:?subject=${encodeURIComponent(`Join ${label} on Baaki`)}&body=${encodeURIComponent(message)}`;

    try {
      await Linking.openURL(url);
    } catch {
      // WhatsApp not installed, no mail account configured, a browser with no
      // handler: fall back to the sheet rather than showing an error.
      await Share.share({ message });
    }
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
              {label}
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

            <Row style={{ gap: theme.spacing.md, flexWrap: 'wrap' }}>
              {(
                [
                  { channel: 'whatsapp', label: 'WhatsApp', icon: 'logo-whatsapp' },
                  { channel: 'sms', label: 'SMS', icon: 'chatbubble-outline' },
                  { channel: 'email', label: 'Email', icon: 'mail-outline' },
                ] as const
              ).map((option) => (
                <Button
                  key={option.channel}
                  label={option.label}
                  variant="secondary"
                  onPress={() => void shareVia(option.channel)}
                  icon={<Ionicons name={option.icon} size={18} color={theme.color.brand} />}
                />
              ))}
            </Row>

            <Row style={{ gap: theme.spacing.md }}>
              <Button
                label="Share another way"
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
