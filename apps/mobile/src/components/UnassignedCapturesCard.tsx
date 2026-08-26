/**
 * The "expenses caught without a group yet" card (A34).
 *
 * A capture with no home is easy to forget, so the one place it must never be
 * is out of sight. It shows on the dashboard, near the top, and in the inbox —
 * the two screens a person opens to answer "is there anything for me?" — so a
 * waiting capture is found from either. Self-contained: it reads the count
 * itself and renders nothing when there is none, so a caller drops it in without
 * a guard of its own.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Card, iconSize, Text, useTheme } from '@waves/ui';

import { useCaptures } from '@/data/hooks';
import { plural, useStrings } from '@/i18n';
import { foldedCaptureCount } from '@/lib/captureBatch';

export function UnassignedCapturesCard() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const captures = useCaptures();
  // A voice batch is one draft, not one per item spoken — fold before counting.
  const count = foldedCaptureCount(captures.data ?? []);

  if (count === 0) return null;

  return (
    <Pressable
      accessibilityRole="button"
      // Both halves the card shows, so the spoken name carries the count a
      // sighted reader gets from the body line, not just "Unassigned".
      accessibilityLabel={`${t.captures.unassigned}. ${plural(locale, count, t.captures.unassignedBody)}`}
      onPress={() => router.push('/captures')}
    >
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.buttonPrimary,
          }}
        >
          <Ionicons name="file-tray-full-outline" size={iconSize.xl} color={theme.color.onBrand} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="subheading">{t.captures.unassigned}</Text>
          <Text variant="caption" tone="muted">
            {plural(locale, count, t.captures.unassignedBody)}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.lg} color={theme.color.textFaint} />
      </Card>
    </Pressable>
  );
}
