/**
 * The trip album — shared photos, the memory layer (plan feature #2).
 *
 * A third photo concept next to the group cover and a receipt: many per trip,
 * free for any member to add, browsable as a grid on its own screen and as a
 * strip under an expense. The pieces here are shared between those two surfaces
 * so an "add" and a "remove" behave the same wherever they appear.
 *
 * The bytes go to Cloudflare R2 under the `trip-photos` bucket through the same
 * storage seam every image uses (`putImage`/`imageUrl`/`removeImage`); this file
 * only ever holds the object path. The image is re-encoded before it leaves the
 * phone, which is what strips its EXIF GPS — an album photo must not carry the
 * place it was taken to everyone in the group.
 */

import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, View } from 'react-native';

import { IconButton, iconSize, Text, useTheme } from '@waves/ui';

import { ZoomableImage } from '@/components/ZoomableImage';
import {
  useAddTripPhoto,
  useRemoveTripPhoto,
  useTripPhotos,
  type TripPhotoRow,
} from '@/data/hooks';
import { pickAlbumPhoto } from '@/lib/image';
import { imageUrl, putImage, removeImage, StorageCapError } from '@/lib/storage';
import { useStrings } from '@/i18n';

/**
 * Resolve an object path to a signed URL, cached across mounts.
 *
 * A grid of a dozen thumbnails must not fire a dozen edge calls on every render.
 * Signed URLs live an hour; this keeps each resolved URL for fifty minutes, so
 * the same photo shown in the grid and again in the viewer is signed once.
 */
const urlCache = new Map<string, { url: string; at: number }>();
const URL_CACHE_MS = 50 * 60 * 1000;

function cachedUrl(path: string | null): string | null {
  if (!path) return null;
  const hit = urlCache.get(path);
  return hit && Date.now() - hit.at < URL_CACHE_MS ? hit.url : null;
}

function useResolvedImage(path: string | null): string | null {
  // What is known synchronously — a cache hit — is derived at render, never
  // pushed through setState in an effect (that cascades renders). The async
  // resolve is the only writer, and its result is keyed by the path it was for,
  // so a fast scroll to a new photo never shows the previous one's URL.
  const cached = cachedUrl(path);
  const [fetched, setFetched] = useState<{ path: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!path || cachedUrl(path)) return; // Nothing to fetch.
    let active = true;
    void (async () => {
      const resolved = await imageUrl('trip-photos', path);
      if (!active) return;
      if (resolved) urlCache.set(path, { url: resolved, at: Date.now() });
      setFetched({ path, url: resolved });
    })();
    return () => {
      active = false;
    };
  }, [path]);

  if (cached) return cached;
  return fetched && fetched.path === path ? fetched.url : null;
}

/** One tappable album thumbnail. A path that will not resolve is a calm blank,
 *  never a crash — a photo removed on another device simply shows nothing. */
export function AlbumThumb({
  path,
  size,
  onPress,
  dimmed,
}: {
  path: string;
  size: number;
  onPress?: () => void;
  dimmed?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const url = useResolvedImage(path);
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.md,
        overflow: 'hidden',
        backgroundColor: theme.color.surfaceMuted,
        opacity: dimmed ? 0.5 : 1,
      }}
    >
      {url ? (
        <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.color.textFaint} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * Pick, shrink, upload and record one album photo. The upload happens before the
 * mutation is queued — the object path is what the queued `trip_photo.add`
 * carries, and it has to exist first. A storage-cap refusal is surfaced as a
 * distinct message the person can act on; anything else is a generic failure.
 */
export function useAlbumUpload(groupId: string): {
  addPhoto: (opts?: { expenseId?: string | null; day?: string | null }) => Promise<void>;
  uploading: boolean;
  error: 'cap' | 'failed' | null;
  clearError: () => void;
} {
  const add = useAddTripPhoto(groupId);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<'cap' | 'failed' | null>(null);
  // Guard against a double-tap kicking off two pickers at once.
  const busy = useRef(false);

  const addPhoto = async (opts?: { expenseId?: string | null; day?: string | null }) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    // Set once the bytes are committed to R2 — so a failure to queue the row
    // afterwards can free them again rather than leave a committed object no
    // trip_photo row references, silently eating the group's storage cap.
    let committedPath: string | null = null;
    try {
      const picked = await pickAlbumPhoto();
      if (!picked) return; // Cancelled or declined — an ordinary answer.
      setUploading(true);
      const ext = picked.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const path = `${groupId}/${randomUUID()}.${ext}`;
      await putImage({
        bucket: 'trip-photos',
        path,
        base64: picked.base64,
        contentType: picked.mimeType,
        groupId,
      });
      committedPath = path;
      // enqueue() persists the mutation before it resolves, so once this returns
      // the row is durable and the object has an owner. If it throws, the object
      // is orphaned — the catch below reclaims it.
      await add.mutateAsync({
        storagePath: path,
        expenseId: opts?.expenseId ?? null,
        day: opts?.day ?? null,
      });
      committedPath = null;
    } catch (caught) {
      if (committedPath) await removeImage('trip-photos', committedPath).catch(() => {});
      setError(caught instanceof StorageCapError ? 'cap' : 'failed');
    } finally {
      setUploading(false);
      busy.current = false;
    }
  };

  return { addPhoto, uploading, error, clearError: () => setError(null) };
}

/** The full-screen viewer: pinch-to-zoom, with a remove action for any member. */
export function AlbumViewer({
  photo,
  onClose,
  onRemove,
  removing,
}: {
  photo: TripPhotoRow | null;
  onClose: () => void;
  onRemove: (photo: TripPhotoRow) => void;
  removing: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const url = useResolvedImage(photo?.storagePath ?? null);

  return (
    <Modal
      visible={photo !== null}
      animationType="fade"
      onRequestClose={onClose}
      transparent={false}
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
          <IconButton label={t.common.close} onPress={onClose}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          {photo ? (
            <IconButton
              label={t.album.remove}
              onPress={() => {
                if (!removing) onRemove(photo);
              }}
            >
              {removing ? (
                <ActivityIndicator color={theme.color.negative} />
              ) : (
                <Ionicons name="trash-outline" size={iconSize.lg} color={theme.color.negative} />
              )}
            </IconButton>
          ) : (
            <View style={{ width: 44 }} />
          )}
        </View>

        {url ? (
          <ZoomableImage uri={url} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={theme.color.brand} />
          </View>
        )}

        {photo?.caption ? (
          <View style={{ padding: theme.spacing.xl }}>
            <Text variant="caption" tone="muted">
              {photo.caption}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/** Longest edge of a strip thumbnail. */
const STRIP_THUMB = 96;

/**
 * The photo strip under one expense — the album filtered to this bill, plus an
 * "add" tile. Self-contained: it owns its viewer and its remove, so an expense
 * screen only has to drop it in. Hidden entirely when there is nothing to show
 * and nothing to add would be surprising — so the add tile is always present.
 */
export function TripAlbumStrip({
  groupId,
  expenseId,
}: {
  groupId: string;
  expenseId: string;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const photos = useTripPhotos(groupId, { expenseId });
  const { addPhoto, uploading } = useAlbumUpload(groupId);
  const remove = useRemoveTripPhoto(groupId);
  const [viewing, setViewing] = useState<TripPhotoRow | null>(null);

  const confirmRemove = (photo: TripPhotoRow) => {
    Alert.alert(t.album.removeConfirm, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.album.remove,
        style: 'destructive',
        onPress: () => {
          setViewing(null);
          remove.mutate({ photoId: photo.id, storagePath: photo.storagePath });
        },
      },
    ]);
  };

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="caption" tone="muted">
        {t.album.photos}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: theme.spacing.sm }}
      >
        <Pressable
          onPress={() => void addPhoto({ expenseId })}
          disabled={uploading}
          accessibilityRole="button"
          accessibilityLabel={t.album.add}
          style={{
            width: STRIP_THUMB,
            height: STRIP_THUMB,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.color.border,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.surfaceMuted,
          }}
        >
          {uploading ? (
            <ActivityIndicator color={theme.color.brand} />
          ) : (
            <Ionicons name="add" size={iconSize.lg} color={theme.color.brand} />
          )}
        </Pressable>

        {photos.data.map((photo) => (
          <AlbumThumb
            key={photo.id}
            path={photo.storagePath}
            size={STRIP_THUMB}
            dimmed={photo.pending}
            onPress={() => setViewing(photo)}
          />
        ))}
      </ScrollView>

      <AlbumViewer
        photo={viewing}
        onClose={() => setViewing(null)}
        onRemove={confirmRemove}
        removing={remove.isPending}
      />
    </View>
  );
}
