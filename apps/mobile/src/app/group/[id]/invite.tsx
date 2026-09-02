import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  View,
} from 'react-native';
import QRCodeStyled from 'react-native-qrcode-styled';
import { Rect } from 'react-native-svg';

import {
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

import { ensureGroupJoinToken, groupJoinLink, resetGroupJoinToken } from '@/data/api';
import { friendlyError } from '@/lib/errors';
import { useGroup } from '@/data/hooks';
import { useSync } from '@/sync';
import { groupLabel } from '@/data/types';
import { useAuth } from '@/lib/auth';
import { useStrings } from '@/i18n';

/**
 * The group's durable join link, shown as a QR (the WhatsApp/Signal model).
 *
 * The link is one stable, re-showable token per group — the same one every open
 * and on every device — so the QR paints straight from the mirror with no server
 * round-trip once it exists. The first time a group is ever shared, the token is
 * minted on open (a brief spinner). An admin can Reset it, which rotates the
 * token and kills every copy of the old QR. Sharing and copying are separate
 * buttons that hand out the same link.
 */
export default function InviteScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const { group, members } = useGroup(groupId);
  const { profile } = useAuth();
  const { flush } = useSync();

  // The token from the mirror is authoritative; `ensured` is the value ensure/
  // reset just returned, held so the QR appears the instant the RPC replies
  // rather than waiting for the next pull to carry the group row back.
  const [ensured, setEnsured] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The rendered QR, so a share can send the image itself and not just the link.
  const qrRef = useRef<{ toDataURL?: (cb: (base64: string) => void) => void } | null>(null);

  const joinToken = group.data?.join_token ?? ensured;
  const link = joinToken ? groupJoinLink(joinToken) : null;

  const iAmAdmin =
    (members.data ?? []).find((m) => m.profile_id === profile?.id && m.left_at === null)?.role ===
    'admin';

  const ensure = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const token = await ensureGroupJoinToken(groupId);
      setEnsured(token);
      void flush();
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'invite.ensure'));
    } finally {
      setBusy(false);
    }
  };

  // Make the link on open the first time a group is ever shared; if the mirror
  // already carries one, there is nothing to do and the QR is there immediately.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    if (group.isLoading || !group.data) return;
    started.current = true;
    // Already have a link from the mirror → nothing to do; the QR is showing.
    if (group.data.join_token) return;
    // Deferred a microtask so the state ensure() sets does not run synchronously
    // inside the effect (that cascades renders); the mint still starts at once.
    void Promise.resolve().then(() => ensure());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.isLoading, group.data]);

  const label = groupLabel(group.data, members.data ?? [], profile?.id);
  const message = t.people.shareMessage.replace('{group}', label).replace('{link}', link ?? '');

  const reset = (): void => {
    Alert.alert(t.people.resetLink, t.people.resetLinkBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.people.resetLink,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              const token = await resetGroupJoinToken(groupId);
              setEnsured(token);
              void flush();
            } catch (caught) {
              setError(friendlyError(caught, t.couldNotSave, 'invite.reset'));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  };

  const share = async (): Promise<void> => {
    if (!link) return;
    await Share.share({ message });
  };

  /** The rendered QR as base64 PNG, or null if the code is not mounted yet. */
  const captureQr = (): Promise<string | null> =>
    new Promise((resolve) => {
      const ref = qrRef.current;
      if (!ref?.toDataURL) return resolve(null);
      try {
        ref.toDataURL((base64) => resolve(base64 ?? null));
      } catch {
        resolve(null);
      }
    });

  /**
   * Send the QR code itself, so the person on the other end of a chat can scan
   * it rather than only tap a link. The image is the one thing a plain URL
   * scheme cannot carry, so this goes through the OS share sheet. `fallback` is
   * the link-only path for when the code cannot be captured.
   */
  const shareQr = async (fallback: () => Promise<void>): Promise<void> => {
    if (!link) return;
    try {
      const base64 = await captureQr();
      if (!base64 || !(await Sharing.isAvailableAsync())) {
        await fallback();
        return;
      }
      const file = new FileSystem.File(FileSystem.Paths.cache, 'waves-invite-qr.png');
      if (file.exists) file.delete();
      file.create();
      file.write(new Uint8Array(decodeBase64(base64)));
      await Sharing.shareAsync(file.uri, {
        mimeType: 'image/png',
        dialogTitle: message,
        UTI: 'public.png',
      });
    } catch {
      await fallback();
    }
  };

  const shareVia = async (channel: 'whatsapp' | 'sms' | 'email'): Promise<void> => {
    if (!link) return;
    const url =
      channel === 'whatsapp'
        ? `whatsapp://send?text=${encodeURIComponent(message)}`
        : channel === 'sms'
          ? `sms:${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(message)}`
          : `mailto:?subject=${encodeURIComponent(t.people.emailSubject.replace('{group}', label))}&body=${encodeURIComponent(message)}`;
    try {
      await Linking.openURL(url);
    } catch {
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
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
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

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading">{t.people.anyoneWithLink}</Text>
          <Text variant="caption" tone="muted">
            {t.people.durableLinkBody}
          </Text>
        </Card>

        {link ? (
          <>
            {/* The QR is the point of the screen — the identical join link as a
                code to point a camera at. Drawn on a white quiet zone regardless
                of theme, because a QR on a dark background does not scan. */}
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
                <QRCodeStyled
                  ref={(c) => {
                    qrRef.current = c;
                  }}
                  data={link}
                  size={200}
                  padding={16}
                  style={{ backgroundColor: '#ffffff' }}
                  // The RN `backgroundColor` style is not rasterised by
                  // `toDataURL`, so a captured/shared PNG would come out with a
                  // transparent ground — the dark pieces then vanish on a dark
                  // chat bubble (WhatsApp). Paint the white quiet zone as an SVG
                  // layer behind the code instead, so it is part of the export.
                  renderBackground={() => (
                    <Rect x={-40} y={-40} width={320} height={320} fill="#ffffff" />
                  )}
                  color="#0A0A1A"
                  errorCorrectionLevel="H"
                  pieceBorderRadius="50%"
                  pieceScale={0.92}
                  outerEyesOptions={{ borderRadius: '28%', color: '#0A0A1A' }}
                  innerEyesOptions={{ borderRadius: '35%', color: '#0A0A1A' }}
                  logo={{
                    href: require('../../../../assets/images/icon.png'),
                    scale: 0.85,
                    padding: 6,
                    hidePieces: true,
                  }}
                />
              </View>
            </Card>

            <Card style={{ gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                {t.people.inviteLink}
              </Text>
              <Text variant="body" style={{ color: theme.color.brand }} selectable>
                {link}
              </Text>
            </Card>

            {/* The quick channels — WhatsApp, SMS, Email and the OS share sheet,
                all on one straight row, each in its own brand colour. */}
            <Row style={{ gap: theme.spacing.sm }}>
              {(
                [
                  {
                    channel: 'whatsapp',
                    label: t.people.whatsapp,
                    icon: 'logo-whatsapp',
                    color: '#25D366',
                  },
                  { channel: 'sms', label: t.extras.sms, icon: 'chatbubble', color: '#1E88E5' },
                  { channel: 'email', label: t.extras.email, icon: 'mail', color: '#EA4335' },
                  {
                    channel: 'share',
                    label: t.common.share,
                    icon: 'share-social',
                    color: '#7C4DFF',
                  },
                ] as const
              ).map((option) => (
                <Pressable
                  key={option.channel}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  onPress={() =>
                    void shareQr(
                      option.channel === 'share' ? share : () => shareVia(option.channel),
                    )
                  }
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
                      backgroundColor: option.color,
                    }}
                  >
                    <Ionicons name={option.icon} size={iconSize.lg} color="#ffffff" />
                  </View>
                  <Text variant="caption" tone="muted">
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </Row>

            <Button
              label={copied ? t.people.linkCopied : t.people.copyLink}
              variant="secondary"
              size="lg"
              fullWidth
              onPress={() => void copy()}
            />

            {/* Rotating the link is an admin's lever, for when a link has spread
                too far. It kills the current QR and every shared copy. */}
            {iAmAdmin ? (
              <Button
                label={t.people.resetLink}
                variant="ghost"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={reset}
                icon={
                  <Ionicons name="refresh-outline" size={iconSize.md} color={theme.color.brand} />
                }
              />
            ) : null}

            <Text variant="micro" tone="muted" align="center">
              {t.people.mintMistakeNote}
            </Text>
          </>
        ) : error ? (
          // Minting failed — a retry, not a first step.
          <Button label={t.people.createLink} size="lg" fullWidth onPress={() => void ensure()} />
        ) : (
          // First-ever share (or still loading): the durable link is being made.
          // Hold the QR's place so the screen reads as "your code is coming".
          <Card
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: theme.spacing.xxxl,
              gap: theme.spacing.md,
            }}
          >
            <ActivityIndicator color={theme.color.brand} />
            <Text variant="caption" tone="muted">
              {t.common.loading}
            </Text>
          </Card>
        )}

        {error ? <Callout tone="negative">{error}</Callout> : null}
      </ScrollView>
    </Screen>
  );
}
