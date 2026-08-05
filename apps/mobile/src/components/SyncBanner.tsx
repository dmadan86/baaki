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

import { useSync } from '@/sync';

export function SyncBanner({ groupId }: { groupId?: string }) {
  const theme = useTheme();
  const { status, queue, rejected, retry, discard } = useSync();

  const pending = groupId ? queue.filter((item) => item.groupId === groupId) : queue;
  const refused = groupId ? rejected.filter((item) => item.groupId === groupId) : rejected;

  if (refused.length > 0) {
    const first = refused[0];
    return (
      <Card style={{ backgroundColor: theme.color.negativeSoft, gap: theme.spacing.md }}>
        <Row style={{ gap: theme.spacing.sm }}>
          <Ionicons name="alert-circle" size={18} color={theme.color.negative} />
          <Text variant="subheading" tone="negative">
            One change could not be saved
          </Text>
        </Row>
        <Text variant="caption" tone="muted">
          {first?.message ?? 'The server refused this change.'}
        </Text>
        <Row style={{ gap: theme.spacing.lg }}>
          <Pressable
            onPress={() => first && void retry(first.clientMutationId)}
            accessibilityRole="button"
          >
            <Text variant="caption" tone="brand">
              Try again
            </Text>
          </Pressable>
          <Pressable
            onPress={() => first && void discard(first.clientMutationId)}
            accessibilityRole="button"
          >
            <Text variant="caption" tone="muted">
              Discard it
            </Text>
          </Pressable>
        </Row>
      </Card>
    );
  }

  if (pending.length === 0 && status !== 'offline') return null;

  const offline = status === 'offline';
  return (
    <Card style={{ backgroundColor: theme.color.brandSoft }}>
      <Row style={{ gap: theme.spacing.sm }}>
        <Ionicons
          name={offline ? 'cloud-offline-outline' : 'sync-outline'}
          size={18}
          color={theme.color.brand}
        />
        <View style={{ flex: 1 }}>
          <Text variant="caption" tone="brand">
            {offline
              ? pending.length > 0
                ? `Offline — ${pending.length} ${pending.length === 1 ? 'change' : 'changes'} saved on this phone`
                : 'Offline — everything here is saved on this phone'
              : `Syncing ${pending.length} ${pending.length === 1 ? 'change' : 'changes'}…`}
          </Text>
        </View>
      </Row>
    </Card>
  );
}
