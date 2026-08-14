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
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { renderNotification } from '@baaki/core';
import {
  Button,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  SectionHeader,
  Text,
  tintForKey,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useMarkNotificationsRead, useNotifications } from '@/data/hooks';
import { SkeletonList } from '@/components/Skeletons';
import type { NotificationRow } from '@/data/types';
import { useStrings } from '@/i18n';
import { usePullRefresh } from '@/lib/pullRefresh';

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
  const clearance = useTabBarClearance();
  const pull = usePullRefresh();
  const { t, locale } = useStrings();
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
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.inbox.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {notifications.isLoading ? (
          // Until the fetch answers, `rows` is empty — which is not the same as
          // "you have no notifications". Showing the empty state here told people
          // their inbox was empty while it was still loading.
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader title={t.inbox.recent} />
            <SkeletonList rows={5} trailing={false} />
          </View>
        ) : notifications.isError ? (
          <EmptyState
            title={t.loadError}
            body={t.loadErrorBody}
            action={
              <Button label={t.retry} variant="secondary" onPress={() => notifications.refetch()} />
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState title={t.nothingYet} body={t.inbox.nothingYetBody} />
        ) : (
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader title={t.inbox.recent} />
            <View>
              {rows.map((row, index) => {
                const { title, body } = renderNotification(row.kind, factsOf(row), locale, {
                  title: row.title,
                  body: row.body,
                });
                const unreadRow = row.read_at === null;
                // Flat row: the kind's colour lives in the icon chip on the left,
                // not the whole row. A read one is dimmed.
                const tint = tintForKey(row.kind);
                return (
                  <View key={row.id}>
                    <Pressable
                      accessibilityRole={row.group_id ? 'button' : undefined}
                      accessibilityLabel={title}
                      onPress={
                        row.group_id
                          ? () => router.push(`/group/${row.group_id}` as never)
                          : undefined
                      }
                      style={({ pressed }) => ({
                        opacity: pressed ? 0.6 : unreadRow ? 1 : 0.7,
                      })}
                    >
                      <Row
                        style={{
                          gap: theme.spacing.md,
                          alignItems: 'center',
                          paddingVertical: theme.spacing.md,
                        }}
                      >
                        <View
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: theme.radius.pill,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: theme.tint[tint].bg,
                          }}
                        >
                          <Ionicons
                            name={ICONS[row.kind] ?? 'notifications'}
                            size={iconSize.md}
                            color={theme.tint[tint].ink}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text variant="subheading" numberOfLines={2}>
                            {title}
                          </Text>
                          <Text variant="caption" tone="muted" numberOfLines={2}>
                            {body}
                          </Text>
                        </View>
                        {unreadRow ? (
                          <View
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 4,
                              backgroundColor: theme.color.brand,
                            }}
                          />
                        ) : null}
                      </Row>
                    </Pressable>
                    {index < rows.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        <Text variant="micro" tone="muted" align="center">
          {t.extras.deliveryComesLater}
        </Text>
      </ScrollView>
    </Screen>
  );
}
