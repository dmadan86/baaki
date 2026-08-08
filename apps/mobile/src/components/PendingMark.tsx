/**
 * "This one hasn't left the phone yet."
 *
 * Offline is a normal state in Baaki (ADR-005), not an error, so this is a mark
 * rather than a warning: a small outline cloud beside the amount, gone the
 * moment the row syncs.
 *
 * It is deliberately not a colour. Green and red are the ledger's own
 * vocabulary — owed to you, and you owe — and a third colour on the same row
 * would be a second thing to decode on a screen whose whole job is one number.
 * The row is real either way: an unsent expense already counts toward the
 * balance, because the arithmetic is the same on both sides of the wire.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import { useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

export function PendingMark({ size = 14 }: { size?: number }) {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <View
      accessible
      accessibilityLabel={t.misc.notSentYet}
      style={{ alignItems: 'center', justifyContent: 'center' }}
    >
      <Ionicons name="cloud-upload-outline" size={size} color={theme.color.textFaint} />
    </View>
  );
}
