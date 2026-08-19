import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import {
  Badge,
  Button,
  Callout,
  Card,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import { mintInvite, type MintedInvite } from '@/data/api';
import { friendlyError } from '@/lib/errors';
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
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
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
      setError(friendlyError(caught, t.couldNotSave, 'invite.create'));
    } finally {
      setBusy(false);
    }
  };

  const label = groupLabel(group.data, members.data ?? [], profile?.id);
  const message = t.people.shareMessage.replace('{group}', label).replace('{link}', link ?? '');

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
          : `mailto:?subject=${encodeURIComponent(t.people.emailSubject.replace('{group}', label))}&body=${encodeURIComponent(message)}`;

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
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.people.inviteTitle}</Text>
            <Text variant="micro" tone="muted">
              {label}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading">{t.people.anyoneWithLink}</Text>
          <Text variant="caption" tone="muted">
            {t.people.anyoneWithLinkBody}
          </Text>
        </Card>

        {invite && link ? (
          <>
            <Card style={{ gap: theme.spacing.md }}>
              <Text variant="caption" tone="muted">
                {t.people.inviteLink}
              </Text>
              <Text variant="body" style={{ color: theme.color.brand }} selectable>
                {link}
              </Text>
              <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                <Badge
                  label={t.people.expires.replace(
                    '{when}',
                    new Intl.DateTimeFormat(locale, {
                      day: 'numeric',
                      month: 'short',
                    }).format(new Date(invite.expiresAt)),
                  )}
                />
                <Badge label={t.people.usesBadge.replace('{count}', String(invite.maxUses))} />
              </Row>
            </Card>

            {/* The same link as a code to point a camera at — for handing the
                group to someone sitting across the table, where typing a URL or
                waiting on a message is the slow way. Any phone's camera reads
                it: it encodes the identical invite URL, so scanning it deep-links
                into the same join flow the link does. Drawn on a white quiet zone
                regardless of theme, because a QR on a dark background does not
                scan. */}
            <Card style={{ gap: theme.spacing.md, alignItems: 'center' }}>
              <Text variant="caption" tone="muted">
                {t.people.scanToJoin}
              </Text>
              <View
                style={{
                  padding: theme.spacing.md,
                  backgroundColor: '#ffffff',
                  borderRadius: theme.radius.md,
                }}
              >
                <QRCode value={link} size={200} backgroundColor="#ffffff" color="#000000" />
              </View>
            </Card>

            {/* The quick channels as an even three-across of round icon
                buttons with the name beneath — the share-row every reference app
                uses (Strava, Instacart, Urban Company). Equal columns, so it
                reads as one control instead of the ragged, wrapping pills it was.
                Full share sheet still lives under the button below. */}
            <Row style={{ gap: theme.spacing.sm }}>
              {(
                [
                  { channel: 'whatsapp', label: t.people.whatsapp, icon: 'logo-whatsapp' },
                  { channel: 'sms', label: t.extras.sms, icon: 'chatbubble' },
                  { channel: 'email', label: t.extras.email, icon: 'mail' },
                ] as const
              ).map((option) => (
                <Pressable
                  key={option.channel}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  onPress={() => void shareVia(option.channel)}
                  style={({ pressed }) => ({
                    flex: 1,
                    alignItems: 'center',
                    gap: theme.spacing.xs,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.color.brandSoft,
                    }}
                  >
                    <Ionicons name={option.icon} size={iconSize.lg} color={theme.color.brand} />
                  </View>
                  <Text variant="caption" tone="muted">
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </Row>

            <Row style={{ gap: theme.spacing.md }}>
              <Button
                label={t.people.shareAnotherWay}
                size="lg"
                onPress={() => void share()}
                icon={
                  <Ionicons name="share-outline" size={iconSize.md} color={theme.color.onBrand} />
                }
              />
              <Button
                label={copied ? t.people.linkCopied : t.people.copyLink}
                variant="secondary"
                size="lg"
                onPress={() => void copy()}
              />
            </Row>

            <Text variant="micro" tone="muted" align="center">
              {t.people.mintMistakeNote}
            </Text>
          </>
        ) : (
          <Button
            label={t.people.createLink}
            size="lg"
            fullWidth
            disabled={busy}
            onPress={() => void mint()}
          />
        )}

        {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
        {error ? <Callout tone="negative">{error}</Callout> : null}
      </ScrollView>
    </Screen>
  );
}
