/**
 * The trip album — every shared photo, as a grid (plan feature #2).
 *
 * A read of the mirror (ADR-005), so it opens with no connection: photos added
 * offline sit in the queue and show at once, a removal is a tombstone that
 * reaches every device. Any member may add or remove — a shared album only its
 * author can prune goes stale the way a shared plan would.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, ScrollView, useWindowDimensions, View } from 'react-native';

import {
  Button,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { AlbumThumb, AlbumViewer, useAlbumUpload } from '@/components/TripAlbum';
import { useGroup, useRemoveTripPhoto, useTripPhotos, type TripPhotoRow } from '@/data/hooks';
import { useStrings } from '@/i18n';

const COLUMNS = 3;

export default function AlbumScreen(): React.JSX.Element {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t } = useStrings();
  const { width } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const { group } = useGroup(groupId);
  const photos = useTripPhotos(groupId);
  const { addPhoto, uploading, error, clearError } = useAlbumUpload(groupId);
  const remove = useRemoveTripPhoto(groupId);

  const [viewing, setViewing] = useState<TripPhotoRow | null>(null);

  const gap = theme.spacing.sm;
  const side = theme.spacing.xl;
  const cell = Math.floor((width - side * 2 - gap * (COLUMNS - 1)) / COLUMNS);

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

  const rows = photos.data;

  return (
    <Screen>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: side,
          paddingTop: theme.spacing.md,
        }}
      >
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.album.title}</Text>
          <Text variant="micro" tone="muted">
            {group.data?.name}
          </Text>
        </View>
        <IconButton label={t.album.add} onPress={() => void addPhoto()}>
          <Ionicons name="add" size={iconSize.lg} color={theme.color.brand} />
        </IconButton>
      </View>

      {error ? (
        <View style={{ paddingHorizontal: side, paddingTop: theme.spacing.sm }}>
          <Text variant="caption" tone="negative" onPress={clearError}>
            {error === 'cap' ? t.storage.full : t.couldNotSave}
          </Text>
        </View>
      ) : null}

      {rows.length === 0 ? (
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            paddingHorizontal: side,
            gap: theme.spacing.lg,
          }}
        >
          <EmptyState
            title={t.album.empty}
            body={t.album.emptyBody}
            action={
              <Button
                label={uploading ? t.album.uploading : t.album.add}
                onPress={() => void addPhoto()}
                disabled={uploading}
              />
            }
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: side,
            paddingTop: theme.spacing.lg,
            paddingBottom: clearance,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
            {rows.map((photo) => (
              <AlbumThumb
                key={photo.id}
                path={photo.storagePath}
                size={cell}
                dimmed={photo.pending}
                onPress={() => setViewing(photo)}
              />
            ))}
          </View>
        </ScrollView>
      )}

      <AlbumViewer
        photo={viewing}
        onClose={() => setViewing(null)}
        onRemove={confirmRemove}
        removing={remove.isPending}
      />
    </Screen>
  );
}
