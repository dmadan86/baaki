/**
 * The one switch in the app.
 *
 * React Native's `Switch` takes a track colour but paints the thumb from the
 * platform's own theme, and on Android that theme is Material's green. Every
 * call site here set `trackColor` and none set `thumbColor`, so every toggle in
 * the app rode a Waves-purple track under a knob from a different design
 * system — a mismatch no screen could see, because each one looked correct in
 * the code that produced it.
 *
 * Stating both halves in one place is the fix: a screen can no longer get one
 * of them right and leave the other to the platform.
 */

import { Platform, Switch } from 'react-native';

import { useTheme } from '../theme';
import { palette } from '../tokens';

/**
 * react-native-web splits the thumb colour in two: `thumbColor` paints the off
 * state and `activeThumbColor` the on state, defaulting the latter to Material
 * teal. Native reads `thumbColor` for both, so the web half has to be asked for
 * separately — and only on web, since the prop means nothing to the Android and
 * iOS views underneath.
 */
const webThumb =
  Platform.OS === 'web' ? ({ activeThumbColor: palette.white } as Record<string, string>) : null;

export interface ToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  /** Required: a switch with no label is a control a screen reader cannot name. */
  accessibilityLabel: string;
}

export function Toggle({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
}: ToggleProps) {
  const theme = useTheme();

  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      // White on both sides. On the purple track it reads as the part that
      // moved; on the grey one it still looks like something you can push.
      thumbColor={palette.white}
      {...webThumb}
      trackColor={{ true: theme.color.brand, false: theme.color.border }}
      // iOS ignores the `false` track colour above and draws its own grey
      // behind the switch unless this is set too.
      ios_backgroundColor={theme.color.border}
      // An explicit thumbColor overrides the greying-out Android would have
      // done for a disabled switch, so the dimming has to be asked for.
      style={{ opacity: disabled ? 0.5 : 1 }}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
