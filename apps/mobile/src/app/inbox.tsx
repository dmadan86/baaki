/**
 * The inbox — everything Baaki has told you, whether or not a push arrived.
 *
 * TDR §7.1 calls this the ledger of record for what we sent, and that is the
 * point: a push dropped by the phone, silenced by Do Not Disturb, or sent while
 * notifications were off is still here. "Your settlement auto-confirmed" is not
 * something somebody should find out from their balance changing.
 *
 * The wording is built here rather than read off the row. The server wrote
 * `kind` and a payload without knowing who would read it or in which language;
 * `renderNotification` in @baaki/core turns that into a sentence, with the
 * stored English as the fallback for a kind this build has never heard of.
 */

import { useEffect } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';

import { renderNotification } from '@baaki/core';
import {
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { useMarkNotificationsRead, useNotifications } from '@/data/hooks';
import type { NotificationRow } from '@/data/types';
import { useStrings } from '@/i18n';

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  settlement_confirmed: 'checkmark-circle',
  settlement_initiated: 'arrow-forward-circle',
  settlement_confirm_request: 'help-circle',
  trip_nudge_morning: 'sunny',
  trip_nudge_evening: 'moon',
  nudge: 'hand-left',
  expense_added: 'receipt',
  ghost_claimed: 'person-add',
  group_invite_accepted: 'person-add',
};

function factsOf(row: NotificationRow): Record<string, string | undefined> {
  const payload = row.payload ?? {};
  const text = (key: string): string | undefined =>
    typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
  return {
    amount: text('amount'),
    currency: text('currency'),
    counterparty: text('counterparty'),
    group: text('group'),
    description: text('description'),
    count: text('count'),
  };
}

export default function InboxScreen() {
  const theme = useTheme();
  const { locale } = useStrings();
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();

  const rows = notifications.data ?? [];
  const unread = rows.filter((row) => row.read_at === null);

  // Opening the inbox is reading it. Leaving a badge up after somebody has
  // looked is how a badge stops meaning anything.
  useEffect(() => {
    if (unread.length === 0) return;
    markRead.mutate(unread.map((row) => row.id));
    // Only on the ids present when the screen opened; re-running as the list
    // refetches would fight the user's scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications.isSuccess]);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={notifications.isFetching && !notifications.isLoading}
            onRefresh={() => void notifications.refetch()}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">Inbox</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            body="Reminders, settlement confirmations and anything else Baaki tells you collect here — even when the notification never reached your phone."
          />
        ) : (
          <View>
            <SectionHeader title="Recent" />
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {rows.map((row, index) => {
                const { title, body } = renderNotification(row.kind, factsOf(row), locale, {
                  title: row.title,
                  body: row.body,
                });
                const unreadRow = row.read_at === null;
                return (
                  <View key={row.id}>
                    <ListRow
                      title={title}
                      subtitle={body}
                      onPress={
                        row.group_id
                          ? () => router.push(`/group/${row.group_id}` as never)
                          : undefined
                      }
                      leading={
                        <View
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: theme.radius.pill,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: unreadRow
                              ? theme.color.brandSoft
                              : theme.color.surfaceMuted,
                          }}
                        >
                          <Ionicons
                            name={ICONS[row.kind] ?? 'notifications'}
                            size={18}
                            color={unreadRow ? theme.color.brand : theme.color.textMuted}
                          />
                        </View>
                      }
                      trailing={
                        unreadRow ? (
                          <View
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 4,
                              backgroundColor: theme.color.brand,
                            }}
                          />
                        ) : null
                      }
                    />
                    {index < rows.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                );
              })}
            </Card>
          </View>
        )}

        <Text variant="micro" tone="faint" align="center">
          Push and email delivery come with M4. Until then this is where everything lands.
        </Text>
      </ScrollView>
    </Screen>
  );
}
