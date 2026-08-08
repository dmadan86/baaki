import { useState } from 'react';
import { Image, Pressable, View } from 'react-native';

import { useTheme } from '../theme';
import { tints, type TintName } from '../tokens';
import { Text } from './Text';

/** Stable tint per name, so a person keeps the same colour everywhere. */
export function tintForKey(key: string): TintName {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return tints[hash % tints.length] as TintName;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

export function Avatar({
  name,
  emoji,
  size = 44,
  tint,
  /** Ghost members (ADR-006) read as provisional until somebody claims them. */
  ghost = false,
  photoUrl,
  onPress,
  accessibilityLabel,
}: {
  name: string;
  emoji?: string;
  size?: number;
  tint?: TintName;
  ghost?: boolean;
  /**
   * A resolved, displayable URL. The avatar bucket is private, so callers pass
   * a signed URL rather than a storage path — this component does no fetching.
   */
  photoUrl?: string | null;
  /**
   * Handled here rather than by wrapping this in a `Pressable` at the call
   * site: the circle below is already an accessibility element, so a wrapper
   * would give a screen reader two stops for one control — the button, and
   * then the name inside it again.
   */
  onPress?: () => void;
  /**
   * Overrides the name, for when the avatar stands for a destination rather
   * than for a person. "Account" is what tapping it does; "Guest" is not.
   */
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const resolved = theme.tint[tint ?? tintForKey(name)];

  // A signed URL can expire between being handed over and being fetched. When
  // it does, fall back to the initials rather than a blank circle — one reads
  // as a person who has not chosen a picture, the other reads as broken.
  const [broken, setBroken] = useState<string | null>(null);
  if (broken !== null && broken !== photoUrl) setBroken(null);
  const showPhoto = Boolean(photoUrl) && broken !== photoUrl;

  const label = accessibilityLabel ?? (ghost ? `${name}, not yet joined` : name);

  const body = (
    <View
      accessible={!onPress}
      accessibilityLabel={onPress ? undefined : label}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: resolved.bg,
        borderWidth: ghost ? 1.5 : 0,
        borderColor: resolved.ink,
        borderStyle: ghost ? 'dashed' : 'solid',
        overflow: 'hidden',
      }}
    >
      {showPhoto && photoUrl ? (
        <Image
          source={{ uri: photoUrl }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
          onError={() => setBroken(photoUrl)}
        />
      ) : (
        <Text variant={size >= 44 ? 'subheading' : 'caption'} style={{ color: resolved.ink }}>
          {emoji ?? initialsOf(name)}
        </Text>
      )}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {body}
    </Pressable>
  );
}

export function AvatarStack({
  names,
  max = 4,
  size = 30,
}: {
  names: readonly string[];
  max?: number;
  size?: number;
}) {
  const theme = useTheme();
  const shown = names.slice(0, max);
  const overflow = names.length - shown.length;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {shown.map((name, index) => (
        <View key={name} style={{ marginLeft: index === 0 ? 0 : -size / 3 }}>
          <Avatar name={name} size={size} />
        </View>
      ))}
      {overflow > 0 ? (
        <View
          style={{
            marginLeft: -size / 3,
            width: size,
            height: size,
            borderRadius: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.surfaceMuted,
          }}
        >
          <Text variant="micro" tone="muted">{`+${overflow}`}</Text>
        </View>
      ) : null}
    </View>
  );
}
