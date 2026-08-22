/**
 * Your own face, and how one gets chosen.
 *
 * The bucket is private (ADR-013), so what `profiles.avatar_url` holds is a
 * storage path that has to be signed before it can be displayed — except when
 * it holds an https URL, which is what Google sign-in puts there. `avatarPhotoUrl`
 * resolves both, and this component only ever deals in the resolved value.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Avatar, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

import { avatarPhotoUrl } from '@/data/api';
import { useSignedUrl } from '@/lib/useSignedUrl';

/**
 * Resolves whatever is in `avatar_url` to a displayable URL, re-resolving on
 * change and re-minting before a signed URL can expire (see `useSignedUrl`).
 * `avatarPhotoUrl` passes an https OAuth avatar straight through, so those never
 * expire and the extra re-mints are cheap no-ops.
 */
export function useAvatarUrl(value: string | null | undefined): string | null {
  return useSignedUrl(value, avatarPhotoUrl);
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
            backgroundColor: theme.color.buttonPrimary,
            borderWidth: 2,
            borderColor: theme.color.surface,
          }}
        >
          <Ionicons name="camera" size={size * 0.17} color={theme.color.onButtonPrimary} />
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
