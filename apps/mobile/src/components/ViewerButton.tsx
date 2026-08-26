/**
 * A floating, circular action button for the full-screen image viewers.
 *
 * The receipt viewer sits over a dark, immersive backdrop (the Photos/ChatGPT
 * pattern), so its controls float *over* the image rather than in a bar that
 * eats layout. A translucent dark pill keeps every glyph legible whether the
 * pixels behind it are light or dark, and an active `busy` swaps the glyph for a
 * spinner in place so the button never resizes mid-press.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable } from 'react-native';

import { iconSize } from '@waves/ui';

const SIZE = 40;

export function ViewerButton({
  icon,
  label,
  onPress,
  busy,
  tint = '#FFFFFF',
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  busy?: boolean;
  /** Glyph colour — defaults to white; a destructive action passes a red. */
  tint?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => ({
        width: SIZE,
        height: SIZE,
        borderRadius: SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(20, 20, 30, 0.55)',
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator color={tint} />
      ) : (
        <Ionicons name={icon} size={iconSize.md} color={tint} />
      )}
    </Pressable>
  );
}
