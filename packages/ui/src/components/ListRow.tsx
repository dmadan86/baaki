import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /**
   * Colours the title with the negative tone, for rows that end something —
   * signing out, erasing an account. Only the title: a red subtitle would make
   * the row shout twice and the explanation harder to read.
   */
  destructive?: boolean;
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  accessibilityLabel,
  destructive = false,
}: ListRowProps) {
  const theme = useTheme();
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      {leading}
      <View style={{ flex: 1 }}>
        <Text variant="subheading" tone={destructive ? 'negative' : undefined} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `${title}${subtitle ? `, ${subtitle}` : ''}`}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {content}
    </Pressable>
  );
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  /**
   * A glyph above the words, in a soft brand-tinted square. An empty screen is
   * mostly air, and a page of two grey sentences in the middle of it reads as a
   * screen that failed rather than one with nothing in it yet. The mark is
   * decoration in the exact sense that matters here: it says "this is a state,
   * not an error" before the sentence is read. Optional, because a short-lived
   * empty inside a list (a filtered tab) does not want the ceremony.
   */
  icon?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{ alignItems: 'center', paddingVertical: theme.spacing.xxxl, gap: theme.spacing.sm }}
    >
      {icon ? (
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: theme.radius.lg,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.brandSoft,
            marginBottom: theme.spacing.sm,
          }}
        >
          {icon}
        </View>
      ) : null}
      <Text variant="heading" align="center">
        {title}
      </Text>
      <Text variant="caption" tone="muted" align="center">
        {body}
      </Text>
      {action ? <View style={{ marginTop: theme.spacing.md }}>{action}</View> : null}
    </View>
  );
}
