/**
 * What the app is doing about the network, said plainly.
 *
 * ADR-005 makes offline a normal state rather than an error, so this is not an
 * alarm. It appears only when there is something the user might otherwise
 * wonder about — unsent changes, or a change the server refused — and says what
 * is true: the entry is saved, it just hasn't left the phone yet.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { Card, Row, Text, useTheme } from '@baaki/ui';

import { plural, useStrings } from '@/i18n';

import { SyncNetworkPreference, useSyncNetwork } from '@/lib/syncNetwork';
import { useSync } from '@/sync';

export function SyncBanner({ groupId }: { groupId?: string }) {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { status, queue, rejected, retry, discard, lastError } = useSync();
  const { preference: syncNetwork } = useSyncNetwork();

  const pending = groupId ? queue.filter((item) => item.groupId === groupId) : queue;
  const refused = groupId ? rejected.filter((item) => item.groupId === groupId) : rejected;

  if (refused.length > 0) {
    const first = refused[0];
    return (
      <Card style={{ backgroundColor: theme.color.negativeSoft, gap: theme.spacing.md }}>
        <Row style={{ gap: theme.spacing.sm }}>
          <Ionicons name="alert-circle" size={18} color={theme.color.negative} />
          <Text variant="subheading" tone="negative">
            {t.extras.oneChangeFailed}
          </Text>
        </Row>
        <Text variant="caption" tone="muted">
          {first?.message ?? t.misc.serverRefused}
        </Text>
        <Row style={{ gap: theme.spacing.lg }}>
          <Pressable
            onPress={() => first && void retry(first.clientMutationId)}
            accessibilityRole="button"
          >
            <Text variant="caption" tone="brand">
              {t.extras.tryAgain}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => first && void discard(first.clientMutationId)}
            accessibilityRole="button"
          >
            <Text variant="caption" tone="muted">
              {t.extras.discardIt}
            </Text>
          </Pressable>
        </Row>
      </Card>
    );
  }

  if (pending.length === 0 && status !== 'offline' && status !== 'error') return null;

  // Held back by the network preference: online, but not over a connection the
  // user allows sync on. Say which network it is waiting for, not "offline" —
  // the phone is not offline, it is being polite about data.
  if (status === 'metered') {
    return (
      <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.xs }}>
        <Row style={{ gap: theme.spacing.sm }}>
          <Ionicons name="cloud-offline-outline" size={18} color={theme.color.brand} />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="brand">
              {syncNetwork === SyncNetworkPreference.Cellular
                ? t.sync.waitingCellular
                : t.sync.waitingWifi}
            </Text>
          </View>
        </Row>
      </Card>
    );
  }

  // Three different truths, and saying the wrong one is worse than saying
  // nothing: "syncing…" while every request is failing reads as a hang, and
  // eventually as lost data.
  //
  // The count is pluralised rather than glued together from a number and a
  // word. These four sentences were the last English left in the app after the
  // i18n sweep, and "3 changes" cannot be built by suffixing anything in Tamil,
  // Hindi or Arabic.
  const { icon, message } =
    status === 'offline'
      ? {
          icon: 'cloud-offline-outline' as const,
          message:
            pending.length > 0
              ? plural(locale, pending.length, t.misc.offlineWithCount)
              : t.misc.offlineSaved,
        }
      : status === 'error'
        ? {
            icon: 'cloud-offline-outline' as const,
            message: plural(locale, pending.length, t.misc.cantReachServer),
          }
        : {
            icon: 'sync-outline' as const,
            message: plural(locale, pending.length, t.misc.syncingCount),
          };

  return (
    <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.xs }}>
      <Row style={{ gap: theme.spacing.sm }}>
        <Ionicons name={icon} size={18} color={theme.color.brand} />
        <View style={{ flex: 1 }}>
          <Text variant="caption" tone="brand">
            {message}
          </Text>
        </View>
      </Row>
      {status === 'error' && lastError ? (
        <Text variant="micro" tone="muted">
          {lastError}
        </Text>
      ) : null}
    </Card>
  );
}
