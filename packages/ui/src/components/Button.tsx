import type { ReactNode } from 'react';
import { Pressable, View, type PressableProps, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

/**
 * `onBrand` and `onBrandOutline` are the pair that sits on the brand panel:
 * purple-on-purple is invisible there, so the filled one inverts to white with
 * a purple label and its partner is an outline in the panel's own white.
 *
 * `danger` is for the small number of actions that cannot be undone — erasing
 * an account, and nothing else so far. It is filled rather than outlined so it
 * cannot be mistaken for the secondary button beside it, and it borrows the
 * semantic negative colour deliberately: in this app red already means money
 * leaving, and a destructive action is the same warning in a different place.
 *
 * `ghostDanger` is the quieter cousin: a chromeless button (like `ghost`) but
 * with a red label, for the leave-and-archive kind of action that reads as a
 * warning without shouting like a filled block — it sits at the foot of a
 * settings screen, not in the main flow.
 */
export type ButtonVariant =
  'primary' | 'secondary' | 'ghost' | 'ghostDanger' | 'onBrand' | 'onBrandOutline' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  fullWidth?: boolean;
  style?: ViewStyle;
}

export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon,
  fullWidth = false,
  style,
  disabled,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const height = size === 'sm' ? 38 : size === 'lg' ? 56 : 48;
  const paddingHorizontal = size === 'sm' ? theme.spacing.lg : theme.spacing.xxl;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      style={({ pressed }) => [
        {
          height,
          paddingHorizontal,
          borderRadius: theme.radius.pill,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.sm,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          backgroundColor:
            variant === 'primary'
              ? pressed
                ? theme.color.brandPressed
                : theme.color.brand
              : variant === 'danger'
                ? theme.color.negative
                : variant === 'secondary'
                  ? theme.color.brandSoft
                  : variant === 'onBrand'
                    ? theme.color.onBrand
                    : variant === 'onBrandOutline'
                      ? pressed
                        ? '#FFFFFF29'
                        : '#FFFFFF1F'
                      : 'transparent',
          borderWidth: variant === 'onBrandOutline' ? 1 : 0,
          borderColor: variant === 'onBrandOutline' ? '#FFFFFF5C' : undefined,
          opacity: disabled
            ? 0.45
            : (variant === 'onBrand' || variant === 'danger') && pressed
              ? 0.9
              : 1,
        },
        variant === 'primary' && !disabled && theme.shadow.soft,
        style,
      ]}
      {...rest}
    >
      {icon}
      <Text
        variant={size === 'sm' ? 'caption' : 'subheading'}
        tone={
          variant === 'primary' || variant === 'onBrandOutline' || variant === 'danger'
            ? 'onBrand'
            : variant === 'ghostDanger'
              ? 'negative'
              : 'brand'
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Circular icon button — the header controls on the reference boards. */
export function IconButton({
  children,
  label,
  onPress,
  tone = 'surface',
  badge = false,
}: {
  children: ReactNode;
  label: string;
  onPress?: () => void;
  tone?: 'surface' | 'brand';
  badge?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          borderRadius: theme.radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          // Default (surface) is a bare icon — no chip, no shadow — so a top bar
          // reads as just its icons and their actions. `brand` stays a filled
          // circle: it marks the one deliberate call to action, not navigation.
          backgroundColor: tone === 'brand' ? theme.color.brand : 'transparent',
          opacity: pressed ? 0.8 : 1,
        },
        tone === 'brand' ? theme.shadow.soft : null,
      ]}
    >
      {children}
      {badge ? (
        <View
          style={{
            position: 'absolute',
            top: 10,
            right: 11,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: theme.color.negative,
          }}
        />
      ) : null}
    </Pressable>
  );
}

/**
 * A round icon-only floating action button. `label` is not drawn — it is the
 * accessibility name, so the control still announces what it does. The circle
 * matches the dashboard's add button (52pt) so the two primary "+" controls
 * read as the same affordance across screens.
 */
export function Fab({
  onPress,
  label,
  icon,
}: {
  onPress?: () => void;
  label: string;
  icon: ReactNode;
}) {
  const theme = useTheme();
  const size = 52;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        {
          position: 'absolute',
          right: theme.spacing.xl,
          bottom: 108,
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? theme.color.brandPressed : theme.color.brand,
        },
        theme.shadow.lifted,
      ]}
    >
      {icon}
    </Pressable>
  );
}
