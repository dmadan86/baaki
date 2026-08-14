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
  directionalIcon,
  EmptyState,
  IconButton,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
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
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
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
        ) : rows.length === 0 ? (
          <EmptyState title={t.nothingYet} body={t.inbox.nothingYetBody} />
        ) : (
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader title={t.inbox.recent} />
            {rows.map((row) => {
              const { title, body } = renderNotification(row.kind, factsOf(row), locale, {
                title: row.title,
                body: row.body,
              });
              const unreadRow = row.read_at === null;
              // Each notice is a card in a stable colour for its kind, so a run
              // of the same kind reads as a run. A read one is dimmed; the icon
              // sits in a white chip with the tint's ink.
              const tint = tintForKey(row.kind);
              const ink = theme.tint[tint].ink;
              const inkMuted = theme.tint[tint].inkMuted;
              return (
                <Pressable
                  key={row.id}
                  accessibilityRole={row.group_id ? 'button' : undefined}
                  accessibilityLabel={title}
                  onPress={
                    row.group_id ? () => router.push(`/group/${row.group_id}` as never) : undefined
                  }
                  style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
                >
                  <TintCard
                    tint={tint}
                    style={{
                      borderRadius: theme.radius.lg,
                      padding: theme.spacing.lg,
                      opacity: unreadRow ? 1 : 0.7,
                    }}
                  >
                    <Row style={{ gap: theme.spacing.md, alignItems: 'flex-start' }}>
                      <View
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: theme.radius.pill,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: theme.color.surface,
                        }}
                      >
                        <Ionicons name={ICONS[row.kind] ?? 'notifications'} size={18} color={ink} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text variant="subheading" style={{ color: ink }}>
                          {title}
                        </Text>
                        <Text variant="caption" style={{ color: inkMuted }}>
                          {body}
                        </Text>
                      </View>
                      {unreadRow ? (
                        <View
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 4,
                            marginTop: 6,
                            backgroundColor: ink,
                          }}
                        />
                      ) : null}
                    </Row>
                  </TintCard>
                </Pressable>
              );
            })}
          </View>
        )}

        <Text variant="micro" tone="faint" align="center">
          {t.extras.deliveryComesLater}
        </Text>
      </ScrollView>
    </Screen>
  );
}
