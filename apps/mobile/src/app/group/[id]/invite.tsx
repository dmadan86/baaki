import { useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
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
import QRCodeStyled from 'react-native-qrcode-styled';

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
  // The rendered QR, so a share can send the image itself and not just the link.
  const qrRef = useRef<{ toDataURL?: (cb: (base64: string) => void) => void } | null>(null);

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
   * scheme cannot carry, so this goes through the OS share sheet (the only way
   * to hand an app a file in managed Expo). `fallback` is the link-only path for
   * when the code cannot be captured or nothing on the phone can accept a
   * share — better a working link than a dead button.
   */
  const shareQr = async (fallback: () => Promise<void>): Promise<void> => {
    if (!link) return;
    try {
      const base64 = await captureQr();
      if (!base64 || !(await Sharing.isAvailableAsync())) {
        await fallback();
        return;
      }
      // expo-file-system 57 API: File/Paths, not the old string paths. The PNG
      // is base64, so decode to bytes before writing.
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
                <QRCodeStyled
                  // The ref forwards to the underlying react-native-svg <Svg>,
                  // whose toDataURL(cb) captureQr calls to share the code as a
                  // PNG — same contract the old library's getRef gave us, so no
                  // native screenshot module is needed.
                  ref={(c) => {
                    qrRef.current = c;
                  }}
                  data={link}
                  // 200pt of modules plus a white quiet border, so it stays
                  // crisp inside the card and scans without crowding the edge.
                  size={200}
                  padding={16}
                  style={{ backgroundColor: '#ffffff' }}
                  // A fixed near-black rather than a theme token: the code lives
                  // on a permanently white tile in both light and dark, so the
                  // ink must not follow the theme or it would vanish in dark mode.
                  color="#0A0A1A"
                  // Level-H error correction leaves ~30% redundancy, enough that
                  // the punched-out centre logo and the rounded dots never cost a
                  // scan.
                  errorCorrectionLevel="H"
                  // Each module a rounded dot with a hair of a gap between them —
                  // the "scan with phone" wallet look — instead of a solid grid.
                  pieceBorderRadius="50%"
                  pieceScale={0.92}
                  // The three corner finders as rounded squares with a rounded
                  // pupil, matching the dot treatment.
                  outerEyesOptions={{ borderRadius: '28%', color: '#0A0A1A' }}
                  innerEyesOptions={{ borderRadius: '35%', color: '#0A0A1A' }}
                  // The Waves glyph on its rounded tile, centred with a quiet
                  // margin; hidePieces clears the modules behind it so it sits in
                  // a clean gap rather than on top of the code.
                  logo={{
                    href: require('../../../../assets/images/icon.png'),
                    scale: 0.85,
                    padding: 6,
                    hidePieces: true,
                  }}
                />
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
                  // Send the QR image itself; drop to the plain link if the code
                  // cannot be captured (see shareQr).
                  onPress={() => void shareQr(() => shareVia(option.channel))}
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
                onPress={() => void shareQr(share)}
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
