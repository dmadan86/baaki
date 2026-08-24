/**
 * The payment proof on a settlement — a screenshot the payer attaches, visible
 * to the two parties only (feature §4).
 *
 * The payer records that they paid (ADR-007: Baaki never moves the money) and
 * can back it with an image — a bank confirmation, a UPI receipt. The payee
 * sees that image before tapping "Confirm received", so a confirmation is a
 * response to evidence rather than to a bare claim. Nobody else in the group
 * sees it: the row reached this device already RLS-filtered by the party
 * predicate, and the URL is signed only for a party. The enforcement is the DB
 * and r2-sign; this screen is the label on it.
 *
 * Unlike the offline-first ledger writes, attach and remove are direct online
 * RPCs — the bytes need an upload, and the settlement they hang off must already
 * exist server-side (its party check answers about a real row). So this control
 * only ever appears on a settlement that has already synced, never mid-record.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { ActivityIndicator, Alert, Modal, Pressable, View } from 'react-native';

import { Button, IconButton, iconSize, Text, useTheme } from '@waves/ui';

import { ZoomableImage } from '@/components/ZoomableImage';
import {
  useAttachSettlementProof,
  useRemoveSettlementProof,
  useSettlementProof,
} from '@/data/hooks';
import { restrictedImageUrl } from '@/lib/storage';
import { useStrings } from '@/i18n';

const THUMB = 72;

/**
 * Resolve a restricted key to a URL, telling "still resolving" apart from
 * "resolved to nothing" — a signing failure or a disabled backend would
 * otherwise spin forever. The async resolve is the only writer, keyed by the
 * path it was for, so no setState runs synchronously in the effect.
 */
function useRestrictedUrl(
  settlementId: string,
  path: string | null,
): { url: string | null; resolved: boolean } {
  const [fetched, setFetched] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let active = true;
    void (async () => {
      const resolved = await restrictedImageUrl('settlement-proofs', settlementId, path);
      if (active) setFetched({ path, url: resolved });
    })();
    return () => {
      active = false;
    };
  }, [settlementId, path]);
  if (!path) return { url: null, resolved: true };
  if (fetched && fetched.path === path) return { url: fetched.url, resolved: true };
  return { url: null, resolved: false };
}

/**
 * `canManage` is true only for the payer — the party who says they paid. The
 * payee gets the same view but no add/remove: they are looking at the other
 * side's evidence, not their own.
 */
export function SettlementProof({
  groupId,
  settlementId,
  canManage,
}: {
  groupId: string;
  settlementId: string;
  canManage: boolean;
}): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useStrings();
  const proof = useSettlementProof(settlementId);
  const attach = useAttachSettlementProof(groupId, settlementId);
  const remove = useRemoveSettlementProof(settlementId);
  const [viewing, setViewing] = useState(false);

  const row = proof.data;
  const { url, resolved } = useRestrictedUrl(settlementId, row?.storagePath ?? null);

  // No proof and I cannot add one → nothing to show. The payee sees this state
  // as an absence, not an empty control, until the payer attaches.
  if (!row && !canManage) return null;

  if (!row) {
    return (
      <Button
        label={t.proof.add}
        variant="secondary"
        size="md"
        disabled={attach.isPending}
        onPress={() => attach.mutate()}
        icon={
          attach.isPending ? undefined : (
            <Ionicons name="camera-outline" size={iconSize.md} color={theme.color.brand} />
          )
        }
      />
    );
  }

  const confirmRemove = () => {
    Alert.alert(t.proof.removeConfirm, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.proof.remove,
        style: 'destructive',
        onPress: () => {
          setViewing(false);
          remove.mutate({ proofId: row.id, storagePath: row.storagePath });
        },
      },
    ]);
  };

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="caption" tone="muted">
        {t.proof.title}
      </Text>
      <Pressable
        onPress={() => setViewing(true)}
        accessibilityRole="button"
        accessibilityLabel={t.proof.view}
        style={{
          width: THUMB,
          height: THUMB,
          borderRadius: theme.radius.md,
          overflow: 'hidden',
          backgroundColor: theme.color.surfaceMuted,
        }}
      >
        {url ? (
          <Image
            source={{ uri: url }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {resolved ? (
              <Ionicons name="image-outline" size={iconSize.lg} color={theme.color.textFaint} />
            ) : (
              <ActivityIndicator color={theme.color.textFaint} />
            )}
          </View>
        )}
      </Pressable>

      <Modal visible={viewing} animationType="fade" onRequestClose={() => setViewing(false)}>
        <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: theme.spacing.xl,
              paddingTop: theme.spacing.xxl,
              paddingBottom: theme.spacing.sm,
            }}
          >
            <IconButton label={t.common.close} onPress={() => setViewing(false)}>
              <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
            </IconButton>
            {canManage ? (
              <IconButton
                label={t.proof.remove}
                onPress={() => {
                  if (!remove.isPending) confirmRemove();
                }}
              >
                <Ionicons name="trash-outline" size={iconSize.lg} color={theme.color.negative} />
              </IconButton>
            ) : (
              <View style={{ width: 44 }} />
            )}
          </View>
          {url ? (
            <ZoomableImage uri={url} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {resolved ? (
                <Ionicons name="image-outline" size={iconSize.xl} color={theme.color.textFaint} />
              ) : (
                <ActivityIndicator color={theme.color.brand} />
              )}
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}
