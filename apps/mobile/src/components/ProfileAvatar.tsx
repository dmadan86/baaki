/**
 * Your own face, and how one gets chosen.
 *
 * The bucket is private (ADR-013), so what `profiles.avatar_url` holds is a
 * storage path that has to be signed before it can be displayed — except when
 * it holds an https URL, which is what Google sign-in puts there. `avatarPhotoUrl`
 * resolves both, and this component only ever deals in the resolved value.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Avatar, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

import { avatarPhotoUrl } from '@/data/api';

/** Resolves whatever is in `avatar_url` to a displayable URL, and re-resolves on change. */
export function useAvatarUrl(value: string | null | undefined): string | null {
  const stored = value ?? null;
  const [resolved, setResolved] = useState<{ stored: string | null; url: string | null }>({
    stored: null,
    url: null,
  });

  // Adjusted during render rather than in an effect: clearing a stale URL is
  // derived from the new value, and doing it in an effect would show the
  // previous person's face for a frame first.
  if (resolved.stored !== stored) setResolved({ stored, url: null });

  useEffect(() => {
    if (!stored) return;
    let active = true;
    void avatarPhotoUrl(stored).then((url) => {
      if (active) setResolved({ stored, url });
    });
    return () => {
      active = false;
    };
  }, [stored]);

  return resolved.stored === stored ? resolved.url : null;
}

export function ProfileAvatar({
  name,
  avatarUrl,
  size = 78,
  onPress,
  busy = false,
}: {
  name: string;
  avatarUrl: string | null | undefined;
  size?: number;
  onPress?: () => void;
  busy?: boolean;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const url = useAvatarUrl(avatarUrl);

  const body = (
    <View style={{ width: size, height: size }}>
      {busy ? (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.brandSoft,
          }}
        >
          <ActivityIndicator color={theme.color.brand} />
        </View>
      ) : (
        <Avatar name={name} size={size} photoUrl={url} />
      )}

      {onPress && !busy ? (
        <View
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: size * 0.32,
            height: size * 0.32,
            borderRadius: size,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.brand,
            borderWidth: 2,
            borderColor: theme.color.surface,
          }}
        >
          <Ionicons name="camera" size={size * 0.17} color={theme.color.onBrand} />
        </View>
      ) : null}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={url ? t.misc.changeYourPhoto : t.misc.addYourPhoto}
    >
      {body}
    </Pressable>
  );
}
