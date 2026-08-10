/**
 * A section's heading with its explanation folded behind an info icon.
 *
 * The settings and new-group screens had grown a paragraph under every heading,
 * and a page that explains itself a dozen times is a page nobody reads. The
 * words are kept for the one time somebody wants them — tap the ⓘ — but the
 * resting state is just the title and whatever control sits beside it.
 *
 * `right` is that control (a Toggle, usually); it stays on the title row so the
 * thing you act on never moves when the explanation opens or closes.
 */

import { useState, type ReactNode } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { Row, Text, useTheme } from '@baaki/ui';

export function InfoDisclosure({
  title,
  info,
  right,
  titleVariant = 'subheading',
}: {
  title: string;
  info: string;
  right?: ReactNode;
  /** 'subheading' for a card heading, 'caption' for a muted field label. */
  titleVariant?: 'subheading' | 'caption';
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Row style={{ justifyContent: 'space-between', gap: theme.spacing.md }}>
        <Row style={{ gap: theme.spacing.sm, flex: 1 }}>
          {titleVariant === 'caption' ? (
            <Text variant="caption" tone="muted">
              {title}
            </Text>
          ) : (
            <Text variant="subheading">{title}</Text>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`About ${title}`}
            hitSlop={8}
            onPress={() => setOpen((value) => !value)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Ionicons
              name={open ? 'information-circle' : 'information-circle-outline'}
              size={18}
              color={open ? theme.color.brand : theme.color.textFaint}
            />
          </Pressable>
        </Row>
        {right}
      </Row>
      {open ? (
        <Text variant="caption" tone="muted">
          {info}
        </Text>
      ) : null}
    </View>
  );
}
