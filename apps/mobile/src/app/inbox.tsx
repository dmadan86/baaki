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
 * `renderNotification` in @waves/core turns that into a sentence, with the
 * stored English as the fallback for a kind this build has never heard of.
 */

import { useEffect } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { renderNotification } from '@waves/core';
import {
  Button,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  tintForKey,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { dayHeading, dayKey } from '@/data/activity';
import { useMarkNotificationsRead, useNotifications } from '@/data/hooks';
import { SkeletonList } from '@/components/Skeletons';
import type { NotificationRow } from '@/data/types';
import { useStrings } from '@/i18n';
import { usePullRefresh } from '@/lib/pullRefresh';

/**
 * The inbox cut into calendar days, newest first — the same day-heading grouping
 * the Activity feed uses, so the two screens that sit together read the same way.
 * The query already returns rows sorted; this only draws the lines between days.
 */
function groupByDay(rows: readonly NotificationRow[]): { key: string; rows: NotificationRow[] }[] {
  const sections: { key: string; rows: NotificationRow[] }[] = [];
  for (const row of rows) {
    const key = dayKey(row.created_at);
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else sections.push({ key, rows: [row] });
  }
  return sections;
}

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
        {/* A big left-aligned title over its own back row — the modern inbox
            header (Superlist, Linear): the screen name carries the weight, not a
            small centred label squeezed between two chevrons. */}
        <View style={{ paddingTop: theme.spacing.md, gap: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <Text variant="title">{t.inbox.title}</Text>
        </View>

        {notifications.isLoading ? (
          // Until the fetch answers, `rows` is empty — which is not the same as
          // "you have no notifications". Showing the empty state here told people
          // their inbox was empty while it was still loading.
          <SkeletonList rows={6} trailing={false} />
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
          // Grouped by day, newest first. An unread row is a soft brand-tinted
          // card, not a lone dot — the whole row carries the "new" signal, the
          // way Luma and Superlist mark an unread update. A read one drops back
          // to a flat transparent row, so the eye lands on what arrived since.
          <View style={{ gap: theme.spacing.lg }}>
            {groupByDay(rows).map((section) => (
              <View key={section.key} style={{ gap: theme.spacing.xs }}>
                <Text
                  variant="micro"
                  tone="muted"
                  style={{
                    textTransform: 'uppercase',
                    marginBottom: theme.spacing.xs,
                    paddingHorizontal: theme.spacing.sm,
                  }}
                >
                  {dayHeading(locale, section.rows[0]!.created_at)}
                </Text>
                {section.rows.map((row) => {
                  const { title, body } = renderNotification(row.kind, factsOf(row), locale, {
                    title: row.title,
                    body: row.body,
                  });
                  const unreadRow = row.read_at === null;
                  const tint = tintForKey(row.kind);
                  return (
                    <Pressable
                      key={row.id}
                      accessibilityRole={row.group_id ? 'button' : undefined}
                      accessibilityLabel={title}
                      onPress={
                        row.group_id
                          ? () => router.push(`/group/${row.group_id}` as never)
                          : undefined
                      }
                      style={({ pressed }) => ({
                        opacity: pressed ? 0.6 : 1,
                        borderRadius: theme.radius.lg,
                        backgroundColor: unreadRow ? theme.color.brandSoft : 'transparent',
                        paddingHorizontal: theme.spacing.sm,
                        paddingVertical: theme.spacing.md,
                      })}
                    >
                      <Row style={{ gap: theme.spacing.md, alignItems: 'flex-start' }}>
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
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text variant="subheading" numberOfLines={2}>
                            {title}
                          </Text>
                          <Text variant="caption" tone="muted" numberOfLines={2}>
                            {body}
                          </Text>
                        </View>
                        {/* The clock lives on the right, the day is the heading's
                            job — the row says when within the day, not which day. */}
                        <View style={{ alignItems: 'flex-end', gap: 6 }}>
                          <Text variant="micro" tone="muted">
                            {new Intl.DateTimeFormat(locale, {
                              hour: 'numeric',
                              minute: '2-digit',
                            }).format(new Date(row.created_at))}
                          </Text>
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
                        </View>
                      </Row>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        )}

        <Text variant="micro" tone="muted" align="center">
          {t.extras.deliveryComesLater}
        </Text>
      </ScrollView>
    </Screen>
  );
}
