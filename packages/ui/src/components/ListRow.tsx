import type { ReactNode } from 'react';
import { Pressable, View, type AccessibilityRole, type AccessibilityState } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './Text';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** The row's a11y role — defaults to "button"; pass "radio" in a picker. */
  accessibilityRole?: AccessibilityRole;
  /** The row's a11y state — e.g. `{ selected }` for a chosen radio row. */
  accessibilityState?: AccessibilityState;
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
  accessibilityRole = 'button',
  accessibilityState,
  destructive = false,
}: ListRowProps) {
  const theme = useTheme();
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        // WhatsApp-density list rows across the app: a tight vertical rhythm
        // (the leading avatar/badge sets the height), one shared value so every
        // list reads the same. `minHeight` floors a leading-less, single-line
        // row at the 44pt touch target — a tall avatar row already clears it, so
        // this only lifts the short ones the tight padding would leave too small.
        paddingVertical: theme.spacing.sm,
        minHeight: 44,
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
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityState}
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
  /** The line under the title. Omit for a title-only empty state. */
  body?: string;
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
      {body ? (
        <Text variant="caption" tone="muted" align="center">
          {body}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: theme.spacing.md }}>{action}</View> : null}
    </View>
  );
}
