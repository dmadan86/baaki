import type { ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  /** Receives the resolved colour so the icon matches the selected state. */
  icon?: (color: string) => ReactNode;
}

export function Chip({ label, selected = false, onPress, icon }: ChipProps) {
  const theme = useTheme();
  const color = selected ? theme.color.onBrand : theme.color.textMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        paddingHorizontal: theme.spacing.lg,
        height: 36,
        borderRadius: theme.radius.pill,
        backgroundColor: selected ? theme.color.brand : theme.color.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {icon ? icon(color) : null}
      <Text variant="caption" tone={selected ? 'onBrand' : 'muted'}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; icon?: (color: string) => ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.xl }}
    >
      {options.map((option) => (
        <Chip
          key={option.value}
          label={option.label}
          icon={option.icon}
          selected={option.value === value}
          onPress={() => onChange(option.value)}
        />
      ))}
    </ScrollView>
  );
}

/** Small status pill — "pending", "settled", "you owe". */
export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'brand';
}) {
  const theme = useTheme();
  const background =
    tone === 'positive'
      ? theme.color.positiveSoft
      : tone === 'negative'
        ? theme.color.negativeSoft
        : tone === 'brand'
          ? theme.color.brandSoft
          : theme.color.surfaceMuted;
  const color =
    tone === 'positive'
      ? theme.color.positive
      : tone === 'negative'
        ? theme.color.negative
        : tone === 'brand'
          ? theme.color.brand
          : theme.color.textMuted;

  return (
    <View
      style={{
        paddingHorizontal: theme.spacing.md,
        paddingVertical: 4,
        borderRadius: theme.radius.pill,
        backgroundColor: background,
      }}
    >
      <Text variant="micro" style={{ color }}>
        {label}
      </Text>
    </View>
  );
}
