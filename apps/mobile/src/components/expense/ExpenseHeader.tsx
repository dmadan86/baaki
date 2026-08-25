/**
 * The top bar the expense forms share: a close button, a centred receipt icon
 * and title, and a trailing slot.
 *
 * Capture and group add-expense both open with the same header — the only
 * differences are the title, an optional subtitle (the group an expense is
 * being added to), and an optional trailing action (add-expense's "split by
 * item"). Everything else — the close affordance, the brand receipt glyph, the
 * centring, the 44pt spacer that keeps the title optically centred when there is
 * no trailing action — is identical, so it lives here once.
 */

import { type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { View } from 'react-native';

import { directionalIcon, IconButton, iconSize, Row, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

export function ExpenseHeader({
  title,
  subtitle,
  right,
  leading = 'close',
}: {
  title: string;
  subtitle?: string;
  /** A trailing action; a 44pt spacer keeps the title centred when omitted. */
  right?: ReactNode;
  /**
   * The leading affordance. A modal (capture) dismisses with an X; a pushed
   * page (add-expense) goes back with a direction-aware chevron, so the glyph
   * matches how the screen was opened.
   */
  leading?: 'close' | 'back';
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  return (
    <Row style={{ paddingTop: theme.spacing.md }}>
      <IconButton
        label={leading === 'back' ? t.common.back : t.common.close}
        onPress={() => router.back()}
      >
        <Ionicons
          name={leading === 'back' ? directionalIcon('chevron-back') : 'close'}
          size={iconSize.lg}
          color={theme.color.text}
        />
      </IconButton>
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
          <Ionicons name="receipt-outline" size={iconSize.md} color={theme.color.brand} />
          <Text variant="heading">{title}</Text>
        </Row>
        {subtitle ? (
          <Text variant="micro" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? <View style={{ width: 44 }} />}
    </Row>
  );
}
