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

import { useCallback, useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { iconSize, Row, Text, useTheme } from '@waves/ui';

import { canAddExpenseAttachment } from '@/data/api';
import { receiptCapStatus } from '@/lib/receiptCapGate';
import { saveImageToDevice } from '@/lib/saveImage';

import { ViewerButton } from '@/components/ViewerButton';
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
import { cacheImage, cachedImageUri, evictImage } from '@/lib/storage/imageCache';
import {
  discardPendingReceipt,
  enqueueReceipt,
  flushReceiptQueue,
  isOnline,
  listPendingReceipts,
  pendingReceiptUri,
  type PendingReceipt,
} from '@/lib/receiptQueue';
import { SyncStatus, useSync } from '@/sync';
import { fill, useStrings } from '@/i18n';

const THUMB = 96;

/** One gallery entry: the legacy kept bill, an uploaded attachment, or a capture
 *  that was taken offline and is still waiting to upload. */
type GalleryItem =
  | { kind: 'legacy'; key: string; path: string; visibility: 'group' }
  | { kind: 'attachment'; key: string; row: ExpenseAttachmentRow }
  | { kind: 'pending'; key: string; entry: PendingReceipt };

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

        // A still-unsent capture is already a local file — show it straight from
        // there, no network and no cache round-trip.
        if (it.kind === 'pending') {
          if (!active) return;
          setUrls((prev) => ({ ...prev, [it.key]: pendingReceiptUri(it.entry) }));
          continue;
        }

        const bucket = it.kind === 'legacy' ? 'receipts' : 'expense-attachments';
        const path = it.kind === 'legacy' ? it.path : it.row.storagePath;

        // A bill seen before is on disk under its stable path — show it straight
        // away, so an already-opened receipt renders with no network (ADR-005).
        const cached = cachedImageUri(bucket, path);
        if (cached) {
          if (!active) return;
          setUrls((prev) => ({ ...prev, [it.key]: cached }));
          continue;
        }

        // Not cached: resolve the short-lived signed URL. Offline this is null
        // and the tile stays a blank placeholder, exactly as before.
        const url =
          it.kind === 'legacy'
            ? await imageUrl('receipts', path)
            : await restrictedImageUrl('expense-attachments', expenseId, path);
        if (!active) return;
        setUrls((prev) => ({ ...prev, [it.key]: url }));
        // Show it now over the network, and quietly save the bytes so the next
        // view — including offline — reads the local copy. Fire-and-forget: a
        // failed cache write never blocks or breaks the on-screen image.
        if (url) void cacheImage(bucket, path, url);
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
  pending,
  onPress,
  label,
}: {
  url: string | null;
  resolved: boolean;
  isPrivate: boolean;
  /** A capture not yet uploaded — wears an upload glyph so the wait is visible. */
  pending?: boolean;
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
      {pending ? (
        // A soft scrim plus a cloud-upload glyph, so an unsent capture reads as
        // "saved, waiting to send" rather than a finished receipt.
        <View
          style={{
            position: 'absolute',
            inset: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(10, 10, 26, 0.35)',
          }}
        >
          <Ionicons name="cloud-upload-outline" size={iconSize.lg} color="#FFFFFF" />
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
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const attachments = useExpenseAttachments(expenseId);
  const attach = useAttachExpenseAttachment(groupId, expenseId);
  const removeAttachment = useRemoveExpenseAttachment(expenseId);
  const removeLegacy = useRemoveExpenseReceipt(groupId, expenseId);
  const annotate = useAnnotateExpenseAttachment();
  const replace = useReplaceExpenseAttachmentImage(groupId, expenseId);
  const queryClient = useQueryClient();
  const { status, flush } = useSync();

  // Captures taken while offline (or when an upload could not reach R2), held on
  // the device until they can be sent. They show in the gallery straight away
  // from their local file, and a flush uploads them the moment there is network.
  const [pending, setPending] = useState<PendingReceipt[]>([]);
  const refreshPending = useCallback(async () => {
    setPending(await listPendingReceipts(expenseId));
  }, [expenseId]);
  useEffect(() => {
    // An async load from AsyncStorage — the setState lands after an await, not
    // synchronously, so the cascading-render rule does not apply here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshPending();
  }, [refreshPending]);

  // The per-expense receipt ceiling (A46): a free group keeps a small number of
  // gallery images per expense; paid lifts it. This is the affordance — the
  // attach RPC enforces the same limit — so a failed fetch defaults to "allowed"
  // and lets the server be the boundary, the same stance as the scan cap.
  const cap = useQuery({
    queryKey: ['attachmentCap', expenseId],
    queryFn: () => canAddExpenseAttachment(expenseId),
    staleTime: 30_000,
  });
  const capLocked = !cap.isError && receiptCapStatus(cap.data, cap.isLoading) === 'locked';
  const refreshCap = () =>
    void queryClient.invalidateQueries({ queryKey: ['attachmentCap', expenseId] });

  // Try to send any parked captures when there is a usable network — on mount
  // and whenever the connection comes back. A success pulls the freshly-recorded
  // rows into the mirror (so the optimistic tile becomes the real attachment) and
  // re-asks the cap; a permanent refusal (cap reached, not a party) just clears
  // the stuck entry. All best-effort — a flush never throws into the screen.
  useEffect(() => {
    if (status === SyncStatus.Offline || status === SyncStatus.Metered) return;
    void (async () => {
      const result = await flushReceiptQueue();
      if (result.uploadedExpenseIds.length > 0) {
        await refreshPending();
        await flush();
        refreshCap();
      } else if (result.hadPermanentFailure) {
        await refreshPending();
        refreshCap();
      }
    })();
    // Re-run when the connection state flips; refreshers are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const items = useMemo<GalleryItem[]>(() => {
    const list: GalleryItem[] = [];
    if (legacyReceiptPath) {
      list.push({ kind: 'legacy', key: 'legacy', path: legacyReceiptPath, visibility: 'group' });
    }
    for (const row of attachments.data) {
      list.push({ kind: 'attachment', key: row.id, row });
    }
    // Show a parked capture only until its real row lands — once the upload has
    // been pulled into the mirror, the entry shares that row's id, so drop it
    // here to avoid a duplicate tile for the same receipt.
    const uploaded = new Set(attachments.data.map((row) => row.id));
    for (const entry of pending) {
      if (!uploaded.has(entry.attachmentId)) {
        list.push({ kind: 'pending', key: `pending-${entry.attachmentId}`, entry });
      }
    }
    return list;
  }, [legacyReceiptPath, attachments.data, pending]);

  const urls = useResolvedUrls(expenseId, items);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
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
    (it.kind === 'attachment' && it.row.visibility === 'parties') ||
    (it.kind === 'pending' && it.entry.visibility === 'parties');

  // The free per-expense limit is reached (and the group is not paid): point the
  // person at the upgrade rather than open the add sheet. Reuses the scan cap's
  // strings and upgrade route so both ceilings read and route the same.
  const showCapUpsell = () => {
    Alert.alert(t.expense.capReachedTitle, t.expense.capReachedBody, [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.expense.capUpgrade, onPress: () => router.push('/settings/upgrade') },
    ]);
  };

  // The server may still refuse over the cap even when the local gate allowed it
  // (another party filled the last slot from another device); surface that as the
  // upgrade prompt, not a generic failure. Anything else is the generic message.
  const onAddError = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('ATTACHMENT_CAP')) {
      showCapUpsell();
      refreshCap();
    } else {
      Alert.alert(t.receipts.couldNotAdd);
    }
  };

  // Add at a chosen visibility. Online it uploads now; offline (or if the upload
  // cannot reach R2) the capture is parked on the device and shown at once, to
  // be sent automatically on reconnect — the receipt equivalent of ADR-005's
  // offline writes.
  const commitAdd = (
    picked: NonNullable<Awaited<ReturnType<typeof captureReceipt>>>,
    visibility: 'group' | 'parties',
  ) => {
    const contentType = picked.mimeType ?? 'image/jpeg';
    const park = async () => {
      await enqueueReceipt({ expenseId, groupId, visibility, base64: picked.base64, contentType });
      await refreshPending();
    };
    void (async () => {
      if (!(await isOnline())) {
        await park();
        return;
      }
      attach.mutate(
        { picked, visibility },
        {
          onSuccess: refreshCap,
          onError: (error) =>
            void (async () => {
              // The connection dropped mid-upload → park it rather than fail.
              if (!(await isOnline())) {
                await park();
                return;
              }
              onAddError(error);
            })(),
        },
      );
    })();
  };

  const add = (picked: Awaited<ReturnType<typeof captureReceipt>>) => {
    if (!picked) return; // Cancelled/declined.
    Alert.alert(t.receipts.chooseVisibility, undefined, [
      { text: t.receipts.everyone, onPress: () => commitAdd(picked, 'group') },
      { text: t.receipts.payersOnly, onPress: () => commitAdd(picked, 'parties') },
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

  // The add affordance's tap: locked → upsell, otherwise the scan/choose sheet.
  const handleAddPress = () => {
    if (capLocked) showCapUpsell();
    else startAdd();
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
          if (it.kind === 'pending') {
            // Not uploaded yet: just drop the parked capture and its local bytes.
            void discardPendingReceipt(it.entry.attachmentId).then(refreshPending);
          } else if (it.kind === 'legacy') {
            // Only clear the parent's receipt state on a confirmed delete — if the
            // byte removal throws, the bill is still there and must keep showing.
            removeLegacy.mutate(undefined, {
              onSuccess: () => {
                evictImage('receipts', it.path);
                onLegacyRemoved?.();
              },
              onError,
            });
          } else {
            const storagePath = it.row.storagePath;
            removeAttachment.mutate(
              { attachmentId: it.row.id, storagePath },
              // Removing a live attachment frees a slot, so re-ask the cap gate.
              {
                onError,
                onSuccess: () => {
                  evictImage('expense-attachments', storagePath);
                  refreshCap();
                },
              },
            );
          }
        },
      },
    ]);
  };

  const viewing = viewerIndex !== null ? items[viewerIndex] : null;

  // Save the open receipt off the device via the OS share/save sheet.
  const saveViewed = () => {
    if (viewerIndex === null || saving) return;
    const url = urls[viewerIndex];
    if (!url) return;
    setSaving(true);
    void saveImageToDevice(url).then((result) => {
      setSaving(false);
      if (result === 'error') Alert.alert(t.receipts.couldNotSave);
    });
  };

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
          onPress={handleAddPress}
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
              onPress={handleAddPress}
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
              pending={it.kind === 'pending'}
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
        {/* A dark, immersive viewer (the Photos/ChatGPT pattern): the image fills
            the screen and every control floats over it, so nothing squeezes the
            pixels. Save, adjust, annotate and remove sit as translucent circular
            buttons; the counter is a pill at the foot. */}
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <StatusBar barStyle="light-content" />

          <ZoomableGallery
            pages={pages}
            index={viewerIndex ?? 0}
            onIndexChange={(i) => setViewerIndex(i)}
          />

          <Row
            style={{
              position: 'absolute',
              top: insets.top + theme.spacing.sm,
              left: theme.spacing.xl,
              right: theme.spacing.xl,
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            }}
          >
            <ViewerButton
              icon="close"
              label={t.common.close}
              onPress={() => setViewerIndex(null)}
            />
            <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {viewerIndex !== null && urls[viewerIndex] ? (
                <ViewerButton
                  icon="download-outline"
                  label={t.receipts.download}
                  onPress={saveViewed}
                  busy={saving}
                />
              ) : null}
              {(() => {
                if (viewerIndex === null) return null;
                // An attachment's edit/remove is party-only (`canManage`); the
                // legacy bill's remove also allows a group admin
                // (`canRemoveLegacy`) — the same split the RPCs enforce.
                const showEdit =
                  canManage && viewing?.kind === 'attachment' ? urls[viewerIndex] : null;
                const showRemove =
                  viewing !== null && (viewing.kind === 'legacy' ? canRemoveLegacy : canManage);
                return (
                  <>
                    {showEdit ? (
                      <ViewerButton
                        icon="crop"
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
                      />
                    ) : null}
                    {showEdit ? (
                      <ViewerButton
                        icon="pencil"
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
                      />
                    ) : null}
                    {showRemove ? (
                      <ViewerButton
                        icon="trash-outline"
                        label={t.receipts.remove}
                        tint={theme.color.negative}
                        onPress={() => {
                          if (!removeAttachment.isPending && !removeLegacy.isPending)
                            removeAt(viewerIndex);
                        }}
                      />
                    ) : null}
                  </>
                );
              })()}
            </Row>
          </Row>

          {/* Page counter + private tag, a floating pill at the foot. */}
          <View
            style={{
              position: 'absolute',
              bottom: insets.bottom + theme.spacing.xl,
              left: 0,
              right: 0,
              alignItems: 'center',
            }}
          >
            <Row
              style={{
                gap: theme.spacing.xs,
                alignItems: 'center',
                paddingHorizontal: theme.spacing.md,
                paddingVertical: 6,
                borderRadius: theme.radius.pill,
                backgroundColor: 'rgba(20, 20, 30, 0.55)',
              }}
            >
              {viewing && isPrivate(viewing) ? (
                <Ionicons name="lock-closed" size={11} color="#FFFFFF" />
              ) : null}
              <Text variant="caption" style={{ color: '#FFFFFF' }}>
                {fill(t.receipts.counter, {
                  index: (viewerIndex ?? 0) + 1,
                  total: items.length,
                })}
              </Text>
            </Row>
          </View>
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
                onSuccess: () => {
                  // The row now points at fresh bytes under a new path; drop the
                  // old cached copy so a later view fetches the replacement.
                  evictImage('expense-attachments', adjusting.oldStoragePath);
                  setAdjusting(null);
                },
                onError: () => Alert.alert(t.adjust.couldNotSave),
              },
            )
          }
        />
      ) : null}
    </View>
  );
}
