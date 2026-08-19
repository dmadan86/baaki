import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Linking, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { Button, EmptyState, IconButton, iconSize, Screen, useTheme } from '@waves/ui';

import { ZoomableImage } from '@/components/ZoomableImage';
import { fill, useStrings } from '@/i18n';
import { providerFor } from '@/lib/cloud/providers';
import { entryFor } from '@/lib/receiptIndex';
import { receiptFiles } from '@/lib/receiptStore';

/**
 * See the bill, any time after it was kept (E2).
 *
 * The receipt lives in the on-device vault, keyed by the expense id — never on
 * Waves. This screen reads it from there and shows it full-bleed, pinch to zoom.
 * When the local file is gone (a reinstall, a cleared vault) it does not simply
 * fail: if the receipt was backed up to a personal cloud, it says which one and,
 * when a share link is known, offers to open it; otherwise it explains the bill
 * is on the device it was added from. A missing receipt is a calm message, never
 * a crash.
 */
export default function ReceiptViewerScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const { id, shareUrl } = useLocalSearchParams<{ id: string; shareUrl?: string }>();
  const receiptId = id ?? '';

  // Device-only and synchronous — the vault is a file lookup. Null on web, and
  // null once the file is gone, which is the fallback path below.
  const files = receiptFiles(receiptId);

  // Only consulted when the local image is missing, to tell the person where it
  // went. A backed-up receipt names its provider; anything else is "other
  // device". Read once on mount.
  const [cloudLabel, setCloudLabel] = useState<string | null>(null);
  useEffect(() => {
    if (files) return;
    let active = true;
    void (async () => {
      const entry = await entryFor(receiptId);
      if (!active) return;
      setCloudLabel(
        entry?.state === 'synced' && entry.provider ? providerFor(entry.provider).label : null,
      );
    })();
    return () => {
      active = false;
    };
  }, [files, receiptId]);

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        <View style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
        </View>

        {files ? (
          <ZoomableImage uri={files.imageUri} />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              title={t.expense.receiptMissingTitle}
              body={
                cloudLabel
                  ? fill(t.expense.receiptMissingCloud, { provider: cloudLabel })
                  : t.expense.receiptMissingOtherDevice
              }
              action={
                // A share link means the owner opened the bill to the group from
                // their own Drive (E3) — anyone can open it, even without the
                // local file.
                shareUrl ? (
                  <Button
                    label={t.expense.viewReceipt}
                    onPress={() => void Linking.openURL(shareUrl).catch(() => undefined)}
                  />
                ) : undefined
              }
            />
          </View>
        )}
      </View>
    </Screen>
  );
}
