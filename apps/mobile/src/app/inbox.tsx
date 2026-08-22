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
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { dayHeading, dayKey } from '@/data/activity';
import { useCaptures, useMarkNotificationsRead, useNotifications } from '@/data/hooks';
import { SkeletonList } from '@/components/Skeletons';
import { UnassignedCapturesCard } from '@/components/UnassignedCapturesCard';
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

// Outline glyphs, to speak the same icon language as the Activity feed and the
// dashboard — the two screens sit together, so they carry one set of marks.
const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  settlement_confirmed: 'checkmark-circle-outline',
  settlement_initiated: 'arrow-forward-circle-outline',
  settlement_confirm_request: 'help-circle-outline',
  trip_nudge_morning: 'sunny-outline',
  trip_nudge_evening: 'moon-outline',
  nudge: 'hand-left-outline',
  expense_added: 'receipt-outline',
  ghost_claimed: 'person-add-outline',
  group_invite_accepted: 'person-add-outline',
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
  // Unassigned captures show as their own card above the list; the count also
  // decides whether an empty notification list is really "nothing yet" or just
  // "nothing but the capture waiting above".
  const captureCount = useCaptures().data?.length ?? 0;

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
          // So the empty and error states take the room the list is not using
          // and sit in the middle of it, the way Friends does. No effect once a
          // list is present.
          flexGrow: 1,
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
        {/* Back chevron because you drilled in here from the Activity bell,
            then the same glyph-plus-big-title mark the Activity feed wears — the
            two screens sit together, so the inbox reads as the sibling it is
            rather than a generic settings page. */}
        <Row style={{ paddingTop: theme.spacing.md, alignItems: 'center', gap: theme.spacing.sm }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <Ionicons name="notifications-outline" size={iconSize.xl} color={theme.color.brand} />
          <Text variant="title">{t.inbox.title}</Text>
        </Row>

        {/* A capture with no group yet is something waiting for you, so it
            belongs here as much as on the dashboard — the two "anything for me?"
            screens. It renders nothing when there is none. */}
        <UnassignedCapturesCard />

        {notifications.isLoading ? (
          // Until the fetch answers, `rows` is empty — which is not the same as
          // "you have no notifications". Showing the empty state here told people
          // their inbox was empty while it was still loading.
          <SkeletonList rows={6} trailing={false} />
        ) : notifications.isError ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              title={t.loadError}
              body={t.loadErrorBody}
              icon={
                <Ionicons
                  name="cloud-offline-outline"
                  size={iconSize.xxl}
                  color={theme.color.brand}
                />
              }
              action={
                <Button
                  label={t.retry}
                  variant="secondary"
                  onPress={() => notifications.refetch()}
                />
              }
            />
          </View>
        ) : rows.length === 0 && captureCount === 0 ? (
          // Centred, with a glyph — the "all square" treatment Friends uses, so an
          // empty inbox reads as a state and not a screen that failed to load.
          // A waiting capture counts as content, so the empty state stands down
          // when the card above is showing.
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              title={t.nothingYet}
              body={t.inbox.nothingYetBody}
              icon={
                <Ionicons
                  name="notifications-outline"
                  size={iconSize.xxl}
                  color={theme.color.brand}
                />
              }
            />
          </View>
        ) : (
          // Grouped by day, newest first. An unread row is a soft brand-tinted
          // card, not a lone dot — the whole row carries the "new" signal, the
          // way Luma and Superlist mark an unread update. A read one drops back
          // to a flat transparent row, so the eye lands on what arrived since.
          <View style={{ gap: theme.spacing.xl }}>
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
                              backgroundColor: theme.color.buttonPrimary,
                            }}
                          >
                            <Ionicons
                              name={ICONS[row.kind] ?? 'notifications-outline'}
                              size={iconSize.lg}
                              color={theme.color.onBrand}
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

            {/* The delivery footnote belongs with the list, not under an empty
                or loading screen where it read as the only thing on the page. */}
            <Text variant="micro" tone="muted" align="center">
              {t.extras.deliveryComesLater}
            </Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
