/**
 * Receipts on an expense — one gallery, many images (A46).
 *
 * This folds the old single "kept bill" and the separate "attachments" into one
 * surface. Every image is a receipt; each is either group-visible (any member
 * sees it) or private (only the expense's payers and author). Privacy is a per-
 * image choice, enforced at the DB + r2-sign — a private row a non-party cannot
 * see never reached this device, so the lock badge here is a label, not the
 * gate. Tapping a thumbnail opens a full-screen, swipeable, pinch-zoom viewer.
 *
 * The legacy bill (the fixed-key `receipts` object an older expense kept before
 * this gallery existed) is shown as the first, group-visible item so nothing is
 * orphaned; new images are all attachment rows.
 */

import { useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View } from 'react-native';

import { IconButton, iconSize, Row, Text, useTheme } from '@waves/ui';

import { ZoomableGallery, type GalleryPage } from '@/components/ZoomableGallery';
import { ReceiptAnnotator } from '@/components/ReceiptAnnotator';
import { ReceiptCropper } from '@/components/ReceiptCropper';
import {
  useAnnotateExpenseAttachment,
  useAttachExpenseAttachment,
  useExpenseAttachments,
  useRemoveExpenseAttachment,
  useRemoveExpenseReceipt,
  useReplaceExpenseAttachmentImage,
  type ExpenseAttachmentRow,
} from '@/data/hooks';
import { captureReceipt, pickReceiptImage } from '@/lib/image';
import { EMPTY_ANNOTATIONS, isEmptyAnnotations, type Annotations } from '@/lib/annotations';
import { imageUrl, restrictedImageUrl } from '@/lib/storage';
import { fill, useStrings } from '@/i18n';

const THUMB = 96;

/** One gallery entry: the legacy kept bill, or an attachment row. */
type GalleryItem =
  | { kind: 'legacy'; key: string; path: string; visibility: 'group' }
  | { kind: 'attachment'; key: string; row: ExpenseAttachmentRow };

/**
 * Resolve every item to a displayable URL, each through its own backend (the
 * legacy bill is group-readable in the `receipts` bucket; an attachment is
 * signed by subject in the restricted bucket). Keyed by item so a resolved URL
 * is not re-fetched, and a still-resolving item stays null rather than showing a
 * stale neighbour.
 */
function useResolvedUrls(
  expenseId: string,
  items: readonly GalleryItem[],
): (string | null | undefined)[] {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const keys = items.map((it) => it.key).join('|');
  useEffect(() => {
    let active = true;
    void (async () => {
      for (const it of items) {
        if (urls[it.key] !== undefined) continue;
        const url =
          it.kind === 'legacy'
            ? await imageUrl('receipts', it.path)
            : await restrictedImageUrl('expense-attachments', expenseId, it.row.storagePath);
        if (!active) return;
        setUrls((prev) => ({ ...prev, [it.key]: url }));
      }
    })();
    return () => {
      active = false;
    };
    // `keys` captures the item set; re-resolve only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenseId, keys]);
  // `undefined` = still resolving, `null` = resolved to nothing, string = URL.
  return items.map((it) => urls[it.key]);
}

function Thumb({
  url,
  resolved,
  isPrivate,
  onPress,
  label,
}: {
  url: string | null;
  resolved: boolean;
  isPrivate: boolean;
  onPress: () => void;
  label: string;
}): React.JSX.Element {
  const theme = useTheme();
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
      {isPrivate ? (
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

export function ExpenseReceipts({
  groupId,
  expenseId,
  canManage,
  canRemoveLegacy,
  legacyReceiptPath,
  onLegacyRemoved,
}: {
  groupId: string;
  expenseId: string;
  /** Whether the viewer may add and manage attachments — a party to the expense
   *  (payer/author). This never widens to admins: the attach/remove/annotate
   *  RPCs are party-only, so an admin who is not a party gets no attachment
   *  controls. */
  canManage: boolean;
  /** Whether the viewer may remove the legacy kept bill — a party OR a group
   *  admin (moderation of a group-visible image), matching the pre-gallery rule.
   *  The legacy bill lives in the group-readable `receipts` bucket, not the
   *  party-gated attachment table, so an admin removal is server-allowed. */
  canRemoveLegacy: boolean;
  /** The fixed key of the legacy kept bill, when one exists; null otherwise. */
  legacyReceiptPath: string | null;
  /** Called after the legacy bill is removed, so the parent can hide its item. */
  onLegacyRemoved?: () => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useStrings();
  const attachments = useExpenseAttachments(expenseId);
  const attach = useAttachExpenseAttachment(groupId, expenseId);
  const removeAttachment = useRemoveExpenseAttachment(expenseId);
  const removeLegacy = useRemoveExpenseReceipt(groupId, expenseId);
  const annotate = useAnnotateExpenseAttachment();
  const replace = useReplaceExpenseAttachmentImage(groupId, expenseId);

  const items = useMemo<GalleryItem[]>(() => {
    const list: GalleryItem[] = [];
    if (legacyReceiptPath) {
      list.push({ kind: 'legacy', key: 'legacy', path: legacyReceiptPath, visibility: 'group' });
    }
    for (const row of attachments.data) {
      list.push({ kind: 'attachment', key: row.id, row });
    }
    return list;
  }, [legacyReceiptPath, attachments.data]);

  const urls = useResolvedUrls(expenseId, items);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<{
    attachmentId: string;
    uri: string;
    initial: Annotations;
  } | null>(null);
  const [adjusting, setAdjusting] = useState<{
    attachmentId: string;
    uri: string;
    oldStoragePath: string;
  } | null>(null);

  const pages = useMemo<GalleryPage[]>(
    () =>
      items.map((it, i) => ({
        url: urls[i] ?? null,
        annotations: it.kind === 'attachment' ? (it.row.annotations ?? undefined) : undefined,
      })),
    [items, urls],
  );

  // Nothing to show and cannot add → render nothing, so a non-party's bill is
  // not cluttered with an empty section.
  if (items.length === 0 && !canManage) return null;

  const isPrivate = (it: GalleryItem) =>
    it.kind === 'attachment' && it.row.visibility === 'parties';

  const add = (picked: Awaited<ReturnType<typeof captureReceipt>>) => {
    if (!picked) return; // Cancelled/declined.
    Alert.alert(t.receipts.chooseVisibility, undefined, [
      {
        text: t.receipts.everyone,
        onPress: () =>
          attach.mutate(
            { picked, visibility: 'group' },
            { onError: () => Alert.alert(t.receipts.couldNotAdd) },
          ),
      },
      {
        text: t.receipts.payersOnly,
        onPress: () =>
          attach.mutate(
            { picked, visibility: 'parties' },
            { onError: () => Alert.alert(t.receipts.couldNotAdd) },
          ),
      },
      { text: t.common.cancel, style: 'cancel' },
    ]);
  };

  const startAdd = () => {
    Alert.alert(t.receipts.add, undefined, [
      { text: t.receipts.scan, onPress: () => void captureReceipt().then(add) },
      { text: t.receipts.choosePhoto, onPress: () => void pickReceiptImage().then(add) },
      { text: t.common.cancel, style: 'cancel' },
    ]);
  };

  const removeAt = (index: number) => {
    const it = items[index];
    if (!it) return;
    Alert.alert(t.receipts.removeConfirm, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.receipts.remove,
        style: 'destructive',
        onPress: () => {
          setViewerIndex(null);
          const onError = () => Alert.alert(t.imageAudit.couldNotRemove);
          if (it.kind === 'legacy') {
            // Only clear the parent's receipt state on a confirmed delete — if the
            // byte removal throws, the bill is still there and must keep showing.
            removeLegacy.mutate(undefined, { onSuccess: () => onLegacyRemoved?.(), onError });
          } else {
            removeAttachment.mutate(
              { attachmentId: it.row.id, storagePath: it.row.storagePath },
              { onError },
            );
          }
        },
      },
    ]);
  };

  const viewing = viewerIndex !== null ? items[viewerIndex] : null;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="caption" tone="muted">
        {t.receipts.title}
      </Text>
      {items.length === 0 ? (
        // No receipt yet (and, per the guard above, the viewer may add one). A
        // lone 96px tile left a wide empty band under it; a full-width row that
        // reads "Add receipt" fills the space and makes the affordance obvious.
        <Pressable
          onPress={startAdd}
          disabled={attach.isPending}
          accessibilityRole="button"
          accessibilityLabel={t.receipts.add}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingVertical: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.color.border,
            borderStyle: 'dashed',
            backgroundColor: theme.color.surfaceMuted,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.surface,
            }}
          >
            {attach.isPending ? (
              <ActivityIndicator color={theme.color.brand} />
            ) : (
              <Ionicons name="camera-outline" size={iconSize.lg} color={theme.color.brand} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="subheading">{t.receipts.add}</Text>
            <Text variant="micro" tone="muted">
              {`${t.receipts.scan} · ${t.receipts.choosePhoto}`}
            </Text>
          </View>
          <Ionicons name="add" size={iconSize.lg} color={theme.color.brand} />
        </Pressable>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing.sm }}
        >
          {canManage ? (
            <Pressable
              onPress={startAdd}
              disabled={attach.isPending}
              accessibilityRole="button"
              accessibilityLabel={t.receipts.add}
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

          {items.map((it, index) => (
            <Thumb
              key={it.key}
              url={urls[index] ?? null}
              resolved={urls[index] !== undefined}
              isPrivate={isPrivate(it)}
              label={
                isPrivate(it) ? `${t.receipts.title} — ${t.receipts.privateTag}` : t.receipts.title
              }
              onPress={() => setViewerIndex(index)}
            />
          ))}
        </ScrollView>
      )}

      <Modal
        visible={viewing !== null}
        animationType="fade"
        onRequestClose={() => setViewerIndex(null)}
      >
        <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
          <Row
            style={{
              justifyContent: 'space-between',
              paddingHorizontal: theme.spacing.xl,
              paddingTop: theme.spacing.xxl,
              paddingBottom: theme.spacing.sm,
            }}
          >
            <IconButton label={t.common.close} onPress={() => setViewerIndex(null)}>
              <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
            </IconButton>
            <View style={{ alignItems: 'center' }}>
              <Text variant="caption" tone="muted">
                {fill(t.receipts.counter, {
                  index: (viewerIndex ?? 0) + 1,
                  total: items.length,
                })}
              </Text>
              {viewing && isPrivate(viewing) ? (
                <Row style={{ gap: 4, alignItems: 'center' }}>
                  <Ionicons name="lock-closed" size={11} color={theme.color.textMuted} />
                  <Text variant="micro" tone="muted">
                    {t.receipts.privateTag}
                  </Text>
                </Row>
              ) : null}
            </View>
            {(() => {
              // An attachment's edit/remove is party-only (`canManage`); the
              // legacy bill's remove also allows a group admin (`canRemoveLegacy`)
              // — the same split the RPCs enforce. Nothing to offer → a spacer,
              // so the counter stays centred.
              const showEdit =
                canManage && viewing?.kind === 'attachment' && viewerIndex !== null
                  ? urls[viewerIndex]
                  : null;
              const showRemove =
                viewing !== null && (viewing.kind === 'legacy' ? canRemoveLegacy : canManage);
              if (viewerIndex === null || (!showEdit && !showRemove)) {
                return <View style={{ width: 44 }} />;
              }
              return (
                <Row style={{ gap: theme.spacing.xs }}>
                  {showEdit ? (
                    <IconButton
                      label={t.adjust.title}
                      onPress={() => {
                        const url = urls[viewerIndex];
                        if (viewing?.kind === 'attachment' && url) {
                          setAdjusting({
                            attachmentId: viewing.row.id,
                            uri: url,
                            oldStoragePath: viewing.row.storagePath,
                          });
                        }
                      }}
                    >
                      <Ionicons name="crop" size={iconSize.md} color={theme.color.text} />
                    </IconButton>
                  ) : null}
                  {showEdit ? (
                    <IconButton
                      label={t.annotate.title}
                      onPress={() => {
                        const url = urls[viewerIndex];
                        if (viewing?.kind === 'attachment' && url) {
                          setEditing({
                            attachmentId: viewing.row.id,
                            uri: url,
                            initial: viewing.row.annotations ?? EMPTY_ANNOTATIONS,
                          });
                        }
                      }}
                    >
                      <Ionicons name="pencil" size={iconSize.md} color={theme.color.text} />
                    </IconButton>
                  ) : null}
                  {showRemove ? (
                    <IconButton
                      label={t.receipts.remove}
                      onPress={() => {
                        if (!removeAttachment.isPending && !removeLegacy.isPending)
                          removeAt(viewerIndex);
                      }}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={iconSize.lg}
                        color={theme.color.negative}
                      />
                    </IconButton>
                  ) : null}
                </Row>
              );
            })()}
          </Row>
          <ZoomableGallery
            pages={pages}
            index={viewerIndex ?? 0}
            onIndexChange={(i) => setViewerIndex(i)}
          />
        </View>
      </Modal>

      {editing ? (
        <ReceiptAnnotator
          uri={editing.uri}
          initial={editing.initial}
          saving={annotate.isPending}
          onCancel={() => setEditing(null)}
          onSave={(next) =>
            annotate.mutate(
              {
                attachmentId: editing.attachmentId,
                annotations: isEmptyAnnotations(next) ? null : next,
              },
              {
                onSuccess: () => setEditing(null),
                onError: () => Alert.alert(t.annotate.couldNotSave),
              },
            )
          }
        />
      ) : null}

      {adjusting ? (
        <ReceiptCropper
          uri={adjusting.uri}
          saving={replace.isPending}
          onCancel={() => setAdjusting(null)}
          onSave={(picked) =>
            replace.mutate(
              {
                attachmentId: adjusting.attachmentId,
                oldStoragePath: adjusting.oldStoragePath,
                picked,
              },
              {
                onSuccess: () => setAdjusting(null),
                onError: () => Alert.alert(t.adjust.couldNotSave),
              },
            )
          }
        />
      ) : null}
    </View>
  );
}
