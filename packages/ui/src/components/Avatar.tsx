import { View } from 'react-native';

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
}: {
  name: string;
  emoji?: string;
  size?: number;
  tint?: TintName;
  ghost?: boolean;
}) {
  const theme = useTheme();
  const resolved = theme.tint[tint ?? tintForKey(name)];

  return (
    <View
      accessible
      accessibilityLabel={ghost ? `${name}, not yet joined` : name}
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
      }}
    >
      <Text variant={size >= 44 ? 'subheading' : 'caption'} style={{ color: resolved.ink }}>
        {emoji ?? initialsOf(name)}
      </Text>
    </View>
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
