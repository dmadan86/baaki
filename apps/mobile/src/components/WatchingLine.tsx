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
  onBrand = false,
}: {
  checking: boolean;
  lastCheckedAt: string | null;
  now: number;
  locale: string;
  t: UiStrings;
  onRefresh: () => void;
  /**
   * Drawn on a gradient hero rather than the white body, so the words go white
   * and the dot with them. The state still lives in the words — the dot only
   * agrees — but a positive green pin-prick on indigo reads as a stray pixel,
   * and on a dark wash the one honest "everything is fine" colour is the same
   * white everything else on the panel is wearing.
   */
  onBrand?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  // The screen's clock ticks once a minute; a read writes its timestamp the
  // instant it happens. So for up to a minute after every check, `lastCheckedAt`
  // is *ahead* of `now`, and `relativeTime` — correctly, for a trip date —
  // renders that as the future: "Watching your bank messages · in 1 second".
  //
  // Clamped here rather than in `relativeTime`, which has other callers that do
  // describe things yet to happen. The rule this enforces is narrow and true:
  // a moment the app has already lived through is never in the future, however
  // stale the clock it is being compared against.
  const sinceNow = lastCheckedAt ? Math.max(now, Date.parse(lastCheckedAt) || now) : now;
  const words = checking
    ? t.captures.checkingNow
    : lastCheckedAt
      ? t.captures.watchingSince.replace('{when}', relativeTime(locale, lastCheckedAt, sinceNow))
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
          <Ionicons
            name="sync-outline"
            size={iconSize.xs}
            color={onBrand ? theme.color.onBrand : theme.color.warning}
          />
        ) : (
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: onBrand ? theme.color.onBrand : theme.color.positive,
            }}
          />
        )}
        <Text
          variant="micro"
          tone={onBrand ? 'onBrand' : 'muted'}
          numberOfLines={1}
          style={{ flexShrink: 1, opacity: onBrand ? 0.85 : 1 }}
        >
          {words}
        </Text>
      </Row>
    </Pressable>
  );
}
