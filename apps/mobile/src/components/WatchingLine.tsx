/**
 * "● Watching your bank messages · 2 min ago".
 *
 * This one line replaced a paragraph of instructions at the top of Review. The
 * paragraph was not badly written — it was the wrong object. An instruction is
 * what you show somebody you are about to make work; when the app is doing the
 * work, the honest thing to show is a **state**. Two seconds to read, and it
 * earns trust instead of spending attention.
 *
 * Three rules it keeps:
 *
 *   * It is never rendered unless something really is reading. The caller checks
 *     `useSmsAutoRead().enabled` — a line claiming to watch while nothing did
 *     would be worse than no line at all.
 *   * The state is in the words, not in the dot. The dot agrees with them; it is
 *     never the only thing that says which state this is (#191).
 *   * It is tappable, and tapping it looks again. A status a person cannot act
 *     on is a status they learn to ignore.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { iconSize, Row, Text, useTheme } from '@waves/ui';

import { relativeTime } from '@/data/activity';
import type { UiStrings } from '@/i18n';

export function WatchingLine({
  checking,
  lastCheckedAt,
  /** The clock the caller already holds — never `Date.now()` read in a render. */
  now,
  locale,
  t,
  onRefresh,
}: {
  checking: boolean;
  lastCheckedAt: string | null;
  now: number;
  locale: string;
  t: UiStrings;
  onRefresh: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const words = checking
    ? t.captures.checkingNow
    : lastCheckedAt
      ? t.captures.watchingSince.replace('{when}', relativeTime(locale, lastCheckedAt, now))
      : t.captures.watching;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${words}. ${t.captures.checkNow}`}
      accessibilityState={{ busy: checking }}
      onPress={onRefresh}
      hitSlop={8}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, alignSelf: 'flex-start' })}
    >
      <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
        {checking ? (
          <Ionicons name="sync-outline" size={iconSize.xs} color={theme.color.warning} />
        ) : (
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: theme.color.positive,
            }}
          />
        )}
        <Text variant="micro" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {words}
        </Text>
      </Row>
    </Pressable>
  );
}
