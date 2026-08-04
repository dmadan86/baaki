import type { ReactNode } from 'react';
import { Pressable, View, type PressableProps, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
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
          opacity: disabled ? 0.45 : 1,
          backgroundColor:
            variant === 'primary'
              ? pressed
                ? theme.color.brandPressed
                : theme.color.brand
              : variant === 'secondary'
                ? theme.color.brandSoft
                : 'transparent',
        },
        variant === 'primary' && !disabled && theme.shadow.soft,
        style,
      ]}
      {...rest}
    >
      {icon}
      <Text
        variant={size === 'sm' ? 'caption' : 'subheading'}
        tone={variant === 'primary' ? 'onBrand' : 'brand'}
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
          backgroundColor: tone === 'brand' ? theme.color.brand : theme.color.surface,
          opacity: pressed ? 0.8 : 1,
        },
        theme.shadow.soft,
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
          height: 56,
          paddingHorizontal: theme.spacing.xl,
          borderRadius: theme.radius.pill,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          backgroundColor: pressed ? theme.color.brandPressed : theme.color.brand,
        },
        theme.shadow.lifted,
      ]}
    >
      {icon}
      <Text variant="subheading" tone="onBrand">
        {label}
      </Text>
    </Pressable>
  );
}
