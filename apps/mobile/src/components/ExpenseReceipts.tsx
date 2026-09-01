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

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
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
  useExpenseAttachments,
  useRemoveExpenseAttachment,
  useRemoveExpenseReceipt,
  useReplaceExpenseAttachmentImage,
  type ExpenseAttachmentRow,
} from '@/data/hooks';
import {
  captureReceiptAsset,
  pickReceiptAsset,
  prepareReceipt,
  type PickedAsset,
} from '@/lib/image';
import { EMPTY_ANNOTATIONS, isEmptyAnnotations, type Annotations } from '@/lib/annotations';
import { imageUrl, restrictedImageUrl } from '@/lib/storage';
import { cacheImage, cachedImageUri, evictImage } from '@/lib/storage/imageCache';
import {
  discardPendingReceipt,
  enqueueReceipt,
  flushReceiptQueue,
  pendingReceiptUri,
  retryPendingReceipts,
  usePendingReceipts,
  type FlushResult,
  type PendingReceiptStatus,
  type PendingReceiptView,
} from '@/lib/receiptQueue';
import { SyncStatus, useSync } from '@/sync';
import { fill, useStrings } from '@/i18n';

const THUMB = 96;

/** One gallery entry: the legacy kept bill, an uploaded attachment, or a capture
 *  still on its way up — parked on the device, sending, or refused. */
type GalleryItem =
  | { kind: 'legacy'; key: string; path: string; visibility: 'group' }
  | { kind: 'attachment'; key: string; row: ExpenseAttachmentRow }
  | { kind: 'pending'; key: string; entry: PendingReceiptView };

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
  status,
  onPress,
  label,
}: {
  url: string | null;
  resolved: boolean;
  isPrivate: boolean;
  /**
   * Set for a capture that has not finished uploading, so the tile says which
   * of the three it is. This is the whole answer to "did that work?": the image
   * is on screen either way, and the badge is what separates a receipt that is
   * safely on the server from one that is still on the phone.
   */
  status?: PendingReceiptStatus;
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
      {status ? (
        // A soft scrim over the image, with the state drawn on top of it: a
        // spinner while the bytes are in the air, a cloud glyph while they wait
        // for a connection, and a filled red disc when the send failed. The
        // failure is a disc rather than a bare glyph because a red line drawn
        // straight onto an arbitrary photograph is exactly as legible as the
        // photograph lets it be, which is not enough for the one state somebody
        // has to notice.
        <View
          style={{
            position: 'absolute',
            inset: 0,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(10, 10, 26, 0.35)',
          }}
        >
          {status === 'uploading' ? <ActivityIndicator color="#FFFFFF" /> : null}
          {status === 'queued' ? (
            <Ionicons name="cloud-upload-outline" size={iconSize.lg} color="#FFFFFF" />
          ) : null}
          {status === 'failed' ? (
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: theme.radius.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.color.negative,
              }}
            >
              <Ionicons name="alert" size={iconSize.md} color="#FFFFFF" />
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Imperative handle so a parent (the expense-detail hero) can own the add
 *  button while this component keeps the add flow and the gallery. */
export interface ExpenseReceiptsHandle {
  openAdd: () => void;
}

interface ExpenseReceiptsProps {
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
  /** When true, this section renders no add affordance of its own — the parent
   *  drives adding through the ref (`openAdd`), and an empty gallery renders
   *  nothing rather than an add row. The gallery of existing receipts still
   *  shows, minus its inline "+" tile. */
  externalAdd?: boolean;
}

export const ExpenseReceipts = forwardRef<ExpenseReceiptsHandle, ExpenseReceiptsProps>(
  function ExpenseReceipts(
    {
      groupId,
      expenseId,
      canManage,
      canRemoveLegacy,
      legacyReceiptPath,
      onLegacyRemoved,
      externalAdd = false,
    },
    ref,
  ) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { t } = useStrings();
    const attachments = useExpenseAttachments(expenseId);
    const removeAttachment = useRemoveExpenseAttachment(expenseId);
    const removeLegacy = useRemoveExpenseReceipt(groupId, expenseId);
    const annotate = useAnnotateExpenseAttachment();
    const replace = useReplaceExpenseAttachmentImage(groupId, expenseId);
    const queryClient = useQueryClient();
    const { status, flush } = useSync();

    // Every capture on this expense that has not finished uploading, with the
    // state it is in. This is a subscription to the device-wide queue, not this
    // screen's copy of it: an upload that finishes while the person is on another
    // screen still updates these tiles when they come back, and a capture parked
    // by a run of the app that was killed is here on the next launch.
    const pending = usePendingReceipts(expenseId);

    // The picked photograph, shown from its own local file while it is being
    // resized and written into the queue.
    //
    // That work is a second or more on a mid-range phone — decode a 12-megapixel
    // image, scale it, re-encode it — and it used to happen behind a spinner in
    // the add tile, with the picture itself appearing only at the end. So the
    // picker handed back the original first: this holds its URI, the strip draws
    // it immediately, and the real pending tile replaces it the moment the queue
    // has the file.
    const [preparing, setPreparing] = useState<string | null>(null);

    // Attachments the person has just removed, hidden while the delete makes its
    // round trip. The list is the mirror's, and the mirror only forgets the row
    // after the RPC lands and a pull brings the change back — several seconds in
    // which the tile they deleted was still sitting there. Cleared by the row
    // actually going (the filter below stops matching) or by the failure.
    const [removedIds, setRemovedIds] = useState<readonly string[]>([]);

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

    // The free per-expense limit is reached (and the group is not paid): point the
    // person at the upgrade rather than open the add sheet. Reuses the scan cap's
    // strings and upgrade route so both ceilings read and route the same.
    const showCapUpsell = () => {
      Alert.alert(t.expense.capReachedTitle, t.expense.capReachedBody, [
        { text: t.common.cancel, style: 'cancel' },
        { text: t.expense.capUpgrade, onPress: () => router.push('/settings/upgrade') },
      ]);
    };

    // What a flush of the receipt queue means for this screen. A success pulls
    // the freshly-recorded rows into the mirror, so the optimistic tile is
    // replaced by the real attachment rather than sitting beside it, and either
    // outcome moves the cap, so the gate is re-asked.
    const applyFlushResult = async (result: FlushResult) => {
      if (result.uploadedExpenseIds.length > 0) await flush();
      if (result.uploadedExpenseIds.length > 0 || result.hadPermanentFailure) refreshCap();
      // The one refusal somebody can act on: another party filled the last slot
      // from another device, so the local gate let this through and the server
      // did not. Offer the upgrade rather than leave a red tile unexplained.
      if (result.capReached) showCapUpsell();
    };

    // Send whatever is parked.
    //
    // The queue is flushed from the sync provider too — on launch, on foreground,
    // on reconnect — so this is not the only thing keeping uploads moving; it is
    // the copy that runs while this screen is the one being looked at, and the
    // only one in a position to answer with the cap upsell. Best-effort
    // throughout: a capture that could not be sent stays in the gallery wearing
    // its failure rather than throwing anything at the screen.
    const sendPending = async () => {
      await applyFlushResult(await flushReceiptQueue());
    };

    // Send failed captures again at the person's asking, ignoring the backoff and
    // the refusal mark the automatic path respects.
    const retryFailed = (attachmentIds: readonly string[]) => {
      void (async () => {
        await applyFlushResult(await retryPendingReceipts(attachmentIds));
      })();
    };

    // Try to send on mount and whenever the connection comes back.
    useEffect(() => {
      if (status === SyncStatus.Offline || status === SyncStatus.Metered) return;
      void sendPending();
      // Re-run when the connection state flips; the sender reads current values.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]);

    const items = useMemo<GalleryItem[]>(() => {
      const list: GalleryItem[] = [];
      if (legacyReceiptPath) {
        list.push({ kind: 'legacy', key: 'legacy', path: legacyReceiptPath, visibility: 'group' });
      }
      for (const row of attachments.data) {
        // Just deleted, and the mirror has not caught up yet. Hiding it here
        // rather than waiting is what makes the tap feel like it did something.
        if (removedIds.includes(row.id)) continue;
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
    }, [legacyReceiptPath, attachments.data, pending, removedIds]);

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

    const isPrivate = (it: GalleryItem) =>
      (it.kind === 'attachment' && it.row.visibility === 'parties') ||
      (it.kind === 'pending' && it.entry.visibility === 'parties');

    /**
     * Add at a chosen visibility.
     *
     * There is one path here now, and it is the durable one: the bytes are
     * written to a file and recorded in the receipt queue *before* anything is
     * sent, and the queue does the sending. This used to branch — upload now if
     * online, park it if not — and the online branch was the one that hurt.
     * Nothing appeared while it ran, so a slow upload and a failed one looked
     * identical; leaving the screen took its callbacks with it; and an app killed
     * mid-upload lost the photograph, which by then was the only copy of a bill
     * already in the bin. Parking first costs one file write and buys all three
     * back — the tile is on screen the moment the write lands, and the upload is
     * the queue's problem from then on, not this screen's.
     */
    const commitAdd = (asset: PickedAsset, visibility: 'group' | 'parties') => {
      // On screen from here, from the original file — before the resize, before
      // the queue, before anything touches the network.
      setPreparing(asset.uri);
      void (async () => {
        try {
          const file = await prepareReceipt(asset);
          await enqueueReceipt({
            expenseId,
            groupId,
            visibility,
            sourceUri: file.uri,
            contentType: file.mimeType,
          });
        } catch {
          // The bytes never reached the disk (a full device, a revoked path), so
          // there is no tile to carry the failure and this is the only chance to
          // say so. Everything past this point has somewhere to show it instead.
          Alert.alert(t.receipts.couldNotKeep);
          return;
        } finally {
          setPreparing(null);
        }
        await sendPending();
      })();
    };

    /**
     * A bill added here belongs to the group that is splitting it.
     *
     * This used to stop and ask who could see it, between the whole group and
     * the people on the bill. The question came a beat after the photograph,
     * when the person was done, and the answer was the group's every time — a
     * receipt for a bill everybody is paying a share of is not a private
     * document. So it is no longer asked: the bill lands group-readable, which
     * is what the R2 group path already authorises by membership.
     *
     * The narrower 'parties' visibility stays in {@link commitAdd} and in the
     * storage rules — payment proofs still use it, and a receipt already added
     * that way keeps its Private tag.
     */
    const add = (asset: PickedAsset | null) => {
      if (!asset) return; // Cancelled/declined.
      commitAdd(asset, 'group');
    };

    const startAdd = () => {
      Alert.alert(t.receipts.add, undefined, [
        { text: t.receipts.scan, onPress: () => void captureReceiptAsset().then(add) },
        { text: t.receipts.choosePhoto, onPress: () => void pickReceiptAsset().then(add) },
        { text: t.common.cancel, style: 'cancel' },
      ]);
    };

    // The add affordance's tap: locked → upsell, otherwise the scan/choose sheet.
    const handleAddPress = () => {
      if (capLocked) showCapUpsell();
      else startAdd();
    };

    // Hand the add action up to a parent that renders its own button (the detail
    // hero). Defined here, after handleAddPress and before the sole early return
    // below, so the hook runs on every render and reads the current handler.
    useImperativeHandle(ref, () => ({ openAdd: handleAddPress }));

    // Nothing to show and cannot add here → render nothing, so a non-party's bill
    // is not cluttered with an empty section. `externalAdd` also counts as "cannot
    // add here": the parent's button owns adding, so an empty gallery is nothing.
    if (items.length === 0 && preparing === null && (!canManage || externalAdd)) return null;

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
              void discardPendingReceipt(it.entry.attachmentId);
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
              const attachmentId = it.row.id;
              // Gone from the strip now. The row itself only disappears once the
              // RPC has landed and a pull has brought the mirror up to date, and
              // watching a deleted receipt sit there through both is the whole
              // complaint. Put back if the delete turns out to have failed.
              setRemovedIds((current) => [...current, attachmentId]);
              removeAttachment.mutate(
                { attachmentId, storagePath },
                // Removing a live attachment frees a slot, so re-ask the cap gate.
                {
                  onError: () => {
                    setRemovedIds((current) => current.filter((id) => id !== attachmentId));
                    onError();
                  },
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

    // What the strip as a whole is doing, for the line under it. Sending wins
    // over failed, and failed over waiting: the line reports the most active
    // thing happening, and the per-tile badges say which capture is which.
    const unsent = items.flatMap((it) => (it.kind === 'pending' ? [it.entry] : []));
    const failedIds = unsent
      .filter((entry) => entry.status === 'failed')
      .map((entry) => entry.attachmentId);
    const stripStatus: PendingReceiptStatus | null = unsent.some(
      (entry) => entry.status === 'uploading',
    )
      ? 'uploading'
      : failedIds.length > 0
        ? 'failed'
        : unsent.length > 0
          ? 'queued'
          : null;

    /** The state in words, for the tile's accessibility label and the strip line. */
    const statusWord = (state: PendingReceiptStatus): string =>
      state === 'uploading'
        ? t.receipts.sending
        : state === 'failed'
          ? t.receipts.notSent
          : t.receipts.waitingToSend;

    // A capture that did not go up: say what that means and offer the two things
    // worth doing about it. Removing here does not go through `removeAt`'s
    // confirmation — nothing was ever sent, so there is no change to record and
    // nothing for anybody else to see disappear.
    const showUnsent = (entry: PendingReceiptView) => {
      Alert.alert(
        t.receipts.notSent,
        entry.permanent ? t.receipts.notSentBlockedBody : t.receipts.notSentBody,
        [
          { text: t.common.cancel, style: 'cancel' },
          {
            text: t.receipts.remove,
            style: 'destructive',
            onPress: () => void discardPendingReceipt(entry.attachmentId),
          },
          { text: t.receipts.tryAgain, onPress: () => retryFailed([entry.attachmentId]) },
        ],
      );
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
        {/* The caption labels the thumbnail strip, which has nothing else to say
            what it is. The empty state does not need it: the tile below already
            reads "Add receipt" in bigger type, so the heading was the same word
            twice, stacked. */}
        {items.length > 0 || preparing !== null ? (
          <Text variant="caption" tone="muted">
            {t.receipts.title}
          </Text>
        ) : null}
        {items.length === 0 && preparing === null ? (
          // No receipt yet (and, per the guard above, the viewer may add one). A
          // lone 96px tile left a wide empty band under it; a full-width row that
          // reads "Add receipt" fills the space and makes the affordance obvious.
          <Pressable
            onPress={handleAddPress}
            disabled={preparing !== null}
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
              {preparing !== null ? (
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
            {canManage && !externalAdd ? (
              <Pressable
                onPress={handleAddPress}
                disabled={preparing !== null}
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
                <Ionicons name="add" size={iconSize.lg} color={theme.color.brand} />
              </Pressable>
            ) : null}

            {/* The photograph just chosen, straight from its own file, while it
              is being resized and written into the queue. It is the same tile
              the queue will draw a moment later, wearing the same "on its way"
              scrim — so the handover from this to the real pending item is
              invisible, and there is no window where the strip looks empty. */}
            {preparing !== null ? (
              <Thumb
                url={preparing}
                resolved
                isPrivate={false}
                status="uploading"
                label={`${t.receipts.title} — ${t.receipts.sending}`}
                onPress={() => {}}
              />
            ) : null}

            {items.map((it, index) => (
              <Thumb
                key={it.key}
                url={urls[index] ?? null}
                resolved={urls[index] !== undefined}
                isPrivate={isPrivate(it)}
                status={it.kind === 'pending' ? it.entry.status : undefined}
                label={[
                  isPrivate(it)
                    ? `${t.receipts.title} — ${t.receipts.privateTag}`
                    : t.receipts.title,
                  it.kind === 'pending' ? statusWord(it.entry.status) : null,
                ]
                  .filter(Boolean)
                  .join(' — ')}
                onPress={() => {
                  // A failed capture's tap is about the failure, not the picture
                  // — the picture is already the thumbnail, and what the person
                  // needs is the reason and a way out of it.
                  if (it.kind === 'pending' && it.entry.status === 'failed') showUnsent(it.entry);
                  else setViewerIndex(index);
                }}
              />
            ))}
          </ScrollView>
        )}

        {stripStatus === 'failed' ? (
          // Only for the state somebody has to act on.
          //
          // This line used to mirror every state the tiles were already showing:
          // a spinner in the tile and a spinner under it, saying "Sending" about
          // the same upload — two announcements of one thing, and the strip
          // visibly busier than the work it was reporting. A send in progress
          // needs no words; the scrim on the tile is the whole story. A send that
          // failed does, because the way out of it is a retry, and this is the
          // only place that offers one without opening anything.
          <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
            <Ionicons name="alert-circle" size={iconSize.sm} color={theme.color.negative} />
            <Text variant="micro" style={{ color: theme.color.negative }}>
              {statusWord(stripStatus)}
            </Text>
            <Pressable
              onPress={() => retryFailed(failedIds)}
              accessibilityRole="button"
              accessibilityLabel={t.receipts.tryAgain}
              hitSlop={8}
            >
              <Text variant="micro" style={{ color: theme.color.brand }}>
                {t.receipts.tryAgain}
              </Text>
            </Pressable>
          </Row>
        ) : null}

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
  },
);
