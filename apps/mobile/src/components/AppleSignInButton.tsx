/**
 * Apple's own button, or ours.
 *
 * Apple's Human Interface Guidelines govern what this button may look like —
 * approved wording, the official mark, set colours and proportions — and
 * `AppleAuthenticationButton` is the native control, so it is correct by
 * construction and localised into languages this app does not itself ship.
 * That matters here: Baaki speaks four, and Apple speaks forty.
 *
 * It is rendered through `appleModule()` rather than imported, for the reason
 * `lib/appleAuth.ts` sets out at length — the native view manager is resolved
 * at module scope on iOS and throws on a binary built before this package
 * existed, which expo-router turns into a launch failure rather than a missing
 * button.
 *
 * Where there is no native sheet — Android, and iOS builds without the module —
 * this falls back to an ordinary Baaki button. That is not decoration: an
 * account created with Apple on an iPhone has to be reachable from an Android
 * phone, and the web flow behind it is the only way in.
 */

import { useAppleSignInAvailable, appleModule } from '@/lib/appleAuth';
import { Button, useTheme } from '@waves/ui';

interface Props {
  /** Matches the wording of the Google button beside it. */
  label: string;
  disabled?: boolean;
  onPress: () => void;
}

/** The same height as a `size="lg"` Button, so the two sit as a pair. */
const HEIGHT = 56;

export function AppleSignInButton({ label, disabled, onPress }: Props) {
  const theme = useTheme();
  const native = useAppleSignInAvailable();
  const apple = native ? appleModule() : null;

  if (!apple) {
    return (
      <Button
        label={label}
        variant="secondary"
        size="lg"
        fullWidth
        disabled={disabled}
        onPress={onPress}
      />
    );
  }

  const {
    AppleAuthenticationButton,
    AppleAuthenticationButtonType,
    AppleAuthenticationButtonStyle,
  } = apple;

  return (
    <AppleAuthenticationButton
      // "Continue with Apple" rather than "Sign in with", for the same reason
      // the button beside it says continue: ADR-006 means most people arrive
      // here already holding an account full of expenses, and are adding a way
      // back to it rather than starting one.
      buttonType={AppleAuthenticationButtonType.CONTINUE}
      // Apple's black on our light theme, white on our dark one — the pairing
      // that keeps the button legible against the surface it sits on.
      buttonStyle={
        theme.scheme === 'dark'
          ? AppleAuthenticationButtonStyle.WHITE
          : AppleAuthenticationButtonStyle.BLACK
      }
      // Half the height, because `radius.pill` is the 999 sentinel every other
      // button rounds itself with and Apple wants a real corner in points.
      cornerRadius={HEIGHT / 2}
      style={{ width: '100%', height: HEIGHT, opacity: disabled ? 0.5 : 1 }}
      onPress={disabled ? () => {} : onPress}
    />
  );
}
