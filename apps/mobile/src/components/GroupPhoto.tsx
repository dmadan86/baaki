/**
 * A group's picture, and how one gets chosen.
 *
 * The bucket is private (ADR-013), so a photo is read through a short-lived
 * signed URL rather than a public link. That means the URL has to be fetched
 * and can fail, which is why the emoji is not a placeholder shown while
 * loading — it is the real fallback, and a group that never gets a photo looks
 * finished rather than broken.
 *
 * Choosing a photo lives in `@/lib/image`, with the downscaling every upload in
 * the app goes through.
 */

import { useEffect, useState } from 'react';
import { Image } from 'expo-image';
import { ActivityIndicator, Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

import { groupPhotoUrl } from '@/data/api';

interface GroupPhotoProps {
  photoPath?: string | null;
  /** A locally chosen image that has not been uploaded yet. */
  localUri?: string | null;
  emoji?: string | null;
  size?: number;
  onPress?: () => void;
  busy?: boolean;
}

export function GroupPhoto({
  photoPath,
  localUri,
  emoji,
  size = 64,
  onPress,
  busy = false,
}: GroupPhotoProps) {
  const theme = useTheme();
  const { t } = useStrings();
  const url = useGroupPhotoUrl(photoPath);
  const source = localUri ?? url;

  const body = (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 3,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.color.brandSoft,
      }}
    >
      {busy ? (
        <ActivityIndicator color={theme.color.brand} />
      ) : source ? (
        <Image
          source={{ uri: source }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <Text style={{ fontSize: size * 0.45 }}>{emoji ?? '👥'}</Text>
      )}

      {onPress && !busy ? (
        <View
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: size * 0.34,
            height: size * 0.34,
            borderRadius: size,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.brand,
          }}
        >
          <Ionicons name="camera" size={size * 0.18} color={theme.color.onBrand} />
        </View>
      ) : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={source ? t.misc.changeGroupPhoto : t.misc.addGroupPhoto}
    >
      {body}
    </Pressable>
  );
}

/** Resolves a storage path to a signed URL, and re-resolves when it changes. */
export function useGroupPhotoUrl(photoPath: string | null | undefined): string | null {
  const path = photoPath ?? null;
  const [resolved, setResolved] = useState<{ path: string | null; url: string | null }>({
    path: null,
    url: null,
  });

  // Adjusted during render rather than in an effect: clearing a stale URL is
  // derived from the new path, and doing it in an effect would show the old
  // group's photo for a frame first.
  if (resolved.path !== path) setResolved({ path, url: null });

  useEffect(() => {
    if (!path) return;
    let active = true;
    void groupPhotoUrl(path).then((url) => {
      if (active) setResolved({ path, url });
    });
    return () => {
      active = false;
    };
  }, [path]);

  return resolved.path === path ? resolved.url : null;
}
