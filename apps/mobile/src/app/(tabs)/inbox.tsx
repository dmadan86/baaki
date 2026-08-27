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

import { useEffect, useMemo, useRef } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, SectionList, View } from 'react-native';

import { renderNotification } from '@waves/core';
import {
  Button,
  EmptyState,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { dayHeading } from '@/data/activity';
import { useCaptures, useMarkNotificationsRead, useNotifications } from '@/data/hooks';
import { groupNotificationsByDay } from '@/data/inbox';
import { SkeletonList } from '@/components/Skeletons';
import { UnassignedCapturesCard } from '@/components/UnassignedCapturesCard';
import type { NotificationRow } from '@/data/types';
import { useStrings } from '@/i18n';
import { usePullRefresh } from '@/lib/pullRefresh';

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

const EMPTY_NOTIFICATIONS: readonly NotificationRow[] = [];

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

  const rows = notifications.data ?? EMPTY_NOTIFICATIONS;
  const sections = useMemo(() => groupNotificationsByDay(rows), [rows]);

  // The latest rows, held in a ref so the focus effect below reads a snapshot
  // without taking `rows` as a dependency (which would re-fire it on every
  // background refetch and fight the user's scroll). The ref is updated in an
  // effect, never during render — the React Compiler forbids ref writes there.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // Opening the inbox is reading it. Leaving a badge up after somebody has
  // looked is how a badge stops meaning anything. Gated on *focus*, not mount:
  // the inbox is a pre-mounted tab now (lazy: false mounts every tab at launch),
  // so marking read on mount would clear the badge before anybody looked at it.
  // The unread snapshot is taken at the moment of focus.
  useFocusEffect(() => {
    const ids = rowsRef.current.filter((row) => row.read_at === null).map((row) => row.id);
    if (ids.length > 0) markRead.mutate(ids);
  });

  const header = (
    <View style={{ gap: theme.spacing.xl }}>
      {/* The same glyph-plus-big-title mark the Activity feed wears — the two
          screens sit together, so the inbox reads as the sibling it is. No
          back chevron: the title sits at the left edge exactly like Activity,
          and the bottom bar carries the way back. */}
      {/* minHeight matches Activity's header, whose two IconButtons stand it at
          44 — without it this button-less title row is ~14px shorter, so the
          title and the whole body jump up when you cross from Activity to here
          and back. */}
      <Row
        style={{
          paddingTop: theme.spacing.md,
          minHeight: 44 + theme.spacing.md,
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Ionicons name="notifications-outline" size={iconSize.xl} color={theme.color.brand} />
        <Text variant="title">{t.inbox.title}</Text>
      </Row>

      {/* A capture with no group yet is something waiting for you, so it
          belongs here as much as on the dashboard — the two "anything for me?"
          screens. It renders nothing when there is none. */}
      <UnassignedCapturesCard />
    </View>
  );

  return (
    <Screen>
      {notifications.isLoading ? (
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: clearance,
            gap: theme.spacing.xl,
          }}
        >
          {header}
          {/* Until the fetch answers, `rows` is empty — which is not the same as
              "you have no notifications". Showing the empty state here told people
              their inbox was empty while it was still loading. */}
          <SkeletonList rows={6} trailing={false} />
        </View>
      ) : notifications.isError ? (
        <View
          style={{
            flex: 1,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: clearance,
            gap: theme.spacing.xl,
          }}
        >
          {header}
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
        </View>
      ) : rows.length === 0 && captureCount === 0 ? (
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
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
          {header}
          {/* Centred, with a glyph — the "all square" treatment Friends uses, so an
              empty inbox reads as a state and not a screen that failed to load.
              A waiting capture counts as content, so the empty state stands down
              when the card above is showing. */}
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
        </ScrollView>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(row) => row.id}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
          // No `removeClippedSubviews`: on Android it can leave off-screen rows
          // detached after a fast fling, blanking the viewport mid-scroll (the
          // same failure the activity feed hit). `windowSize` bounds what is
          // mounted without the clipping that caused it.
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={7}
          // No `gap` here on purpose: on a VirtualizedList it would stack on top
          // of the Section/Item separators below and double the spacing. The
          // separators own the space between rows and sections; the header gets
          // its own bottom padding so it does not butt against the first section.
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: clearance,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl
              refreshing={pull.refreshing}
              onRefresh={pull.onRefresh}
              tintColor={theme.color.brand}
            />
          }
          ListHeaderComponent={<View style={{ paddingBottom: theme.spacing.lg }}>{header}</View>}
          renderSectionHeader={({ section }) => (
            <Text
              variant="micro"
              tone="muted"
              style={{
                textTransform: 'uppercase',
                marginBottom: theme.spacing.xs,
                paddingHorizontal: theme.spacing.sm,
              }}
            >
              {dayHeading(locale, section.first.created_at)}
            </Text>
          )}
          SectionSeparatorComponent={() => <View style={{ height: theme.spacing.lg }} />}
          ItemSeparatorComponent={() => <View style={{ height: theme.spacing.xs }} />}
          renderItem={({ item: row }) => {
            const { title, body } = renderNotification(row.kind, factsOf(row), locale, {
              title: row.title,
              body: row.body,
            });
            const unreadRow = row.read_at === null;
            return (
              <Pressable
                accessibilityRole={row.group_id ? 'button' : undefined}
                accessibilityLabel={title}
                onPress={
                  row.group_id ? () => router.push(`/group/${row.group_id}` as never) : undefined
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
          }}
          ListFooterComponent={
            <Text variant="micro" tone="muted" align="center">
              {t.extras.deliveryComesLater}
            </Text>
          }
        />
      )}
    </Screen>
  );
}
