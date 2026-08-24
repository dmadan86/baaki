/**
 * Expense attachments — images on a bill, at a chosen visibility (feature §3).
 *
 * A `group` attachment behaves like the receipt: any member sees it. A `parties`
 * one is hidden to everyone but the expense's payers and author — a personal
 * bill the payer keeps to themselves, while the amount stays shared so balances
 * are honest. The list here is already RLS-filtered by the pull, so a `parties`
 * row a non-party cannot see never reached this device; the lock badge is a
 * label, not the enforcement. The enforcement is the DB + r2-sign.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View } from 'react-native';

import { IconButton, iconSize, Text, useTheme } from '@waves/ui';

import { ZoomableImage } from '@/components/ZoomableImage';
import {
  useAttachExpenseAttachment,
  useExpenseAttachments,
  useRemoveExpenseAttachment,
  type ExpenseAttachmentRow,
} from '@/data/hooks';
import { restrictedImageUrl } from '@/lib/storage';
import { useStrings } from '@/i18n';

const THUMB = 96;

/**
 * Resolve a restricted key to a URL, distinguishing "still resolving" from
 * "resolved to nothing" — otherwise a signing failure or a disabled backend
 * spins a thumbnail forever. `resolved` flips true once the async settles, even
 * when the URL came back null, so a caller can show a fallback instead.
 */
function useRestrictedUrl(
  expenseId: string,
  path: string | null,
): { url: string | null; resolved: boolean } {
  // The async resolve is the only writer, keyed by the path it was for — so a
  // quick switch to another attachment never shows the previous one's URL, and
  // no setState runs synchronously in the effect (that cascades renders).
  const [fetched, setFetched] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let active = true;
    void (async () => {
      const resolved = await restrictedImageUrl('expense-attachments', expenseId, path);
      if (active) setFetched({ path, url: resolved });
    })();
    return () => {
      active = false;
    };
  }, [expenseId, path]);
  if (!path) return { url: null, resolved: true };
  if (fetched && fetched.path === path) return { url: fetched.url, resolved: true };
  return { url: null, resolved: false };
}

function AttachmentThumb({
  expenseId,
  row,
  onPress,
}: {
  expenseId: string;
  row: ExpenseAttachmentRow;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const { url, resolved } = useRestrictedUrl(expenseId, row.storagePath);
  const label =
    row.visibility === 'parties'
      ? `${t.attachments.title} — ${t.attachments.payersOnly}`
      : t.attachments.title;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        width: THUMB,
        height: THUMB,
        borderRadius: theme.radius.md,
        overflow: 'hidden',
        backgroundColor: theme.color.surfaceMuted,
      }}
    >
      {url ? (
        <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {resolved ? (
            <Ionicons name="image-outline" size={iconSize.lg} color={theme.color.textFaint} />
          ) : (
            <ActivityIndicator color={theme.color.textFaint} />
          )}
        </View>
      )}
      {row.visibility === 'parties' ? (
        <View
          style={{
            position: 'absolute',
            top: 4,
            insetInlineEnd: 4,
            backgroundColor: theme.color.bg,
            borderRadius: theme.radius.pill,
            padding: 3,
          }}
        >
          <Ionicons name="lock-closed" size={12} color={theme.color.text} />
        </View>
      ) : null}
    </Pressable>
  );
}

export function ExpenseAttachments({
  groupId,
  expenseId,
  canAttach,
}: {
  groupId: string;
  expenseId: string;
  canAttach: boolean;
}): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useStrings();
  const attachments = useExpenseAttachments(expenseId);
  const attach = useAttachExpenseAttachment(groupId, expenseId);
  const remove = useRemoveExpenseAttachment(expenseId);
  const [viewing, setViewing] = useState<ExpenseAttachmentRow | null>(null);
  const { url: viewingUrl, resolved: viewingResolved } = useRestrictedUrl(
    expenseId,
    viewing?.storagePath ?? null,
  );

  const rows = attachments.data;

  // Nothing to show and cannot add → render nothing, so a non-party's bill is
  // not cluttered with an empty section.
  if (rows.length === 0 && !canAttach) return null;

  const startAdd = () => {
    Alert.alert(t.attachments.chooseVisibility, undefined, [
      { text: t.attachments.everyone, onPress: () => attach.mutate({ visibility: 'group' }) },
      { text: t.attachments.payersOnly, onPress: () => attach.mutate({ visibility: 'parties' }) },
      { text: t.common.cancel, style: 'cancel' },
    ]);
  };

  const confirmRemove = (row: ExpenseAttachmentRow) => {
    Alert.alert(t.attachments.removeConfirm, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.attachments.remove,
        style: 'destructive',
        onPress: () => {
          setViewing(null);
          remove.mutate({ attachmentId: row.id, storagePath: row.storagePath });
        },
      },
    ]);
  };

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="caption" tone="muted">
        {t.attachments.title}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: theme.spacing.sm }}
      >
        {canAttach ? (
          <Pressable
            onPress={startAdd}
            disabled={attach.isPending}
            accessibilityRole="button"
            accessibilityLabel={t.attachments.add}
            style={{
              width: THUMB,
              height: THUMB,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.color.border,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.surfaceMuted,
            }}
          >
            {attach.isPending ? (
              <ActivityIndicator color={theme.color.brand} />
            ) : (
              <Ionicons name="add" size={iconSize.lg} color={theme.color.brand} />
            )}
          </Pressable>
        ) : null}

        {rows.map((row) => (
          <AttachmentThumb
            key={row.id}
            expenseId={expenseId}
            row={row}
            onPress={() => setViewing(row)}
          />
        ))}
      </ScrollView>

      <Modal
        visible={viewing !== null}
        animationType="fade"
        onRequestClose={() => setViewing(null)}
      >
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
            <IconButton label={t.common.close} onPress={() => setViewing(null)}>
              <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
            </IconButton>
            {viewing && canAttach ? (
              <IconButton
                label={t.attachments.remove}
                onPress={() => {
                  if (!remove.isPending) confirmRemove(viewing);
                }}
              >
                <Ionicons name="trash-outline" size={iconSize.lg} color={theme.color.negative} />
              </IconButton>
            ) : (
              <View style={{ width: 44 }} />
            )}
          </View>
          {viewingUrl ? (
            <ZoomableImage uri={viewingUrl} />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {viewingResolved ? (
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
