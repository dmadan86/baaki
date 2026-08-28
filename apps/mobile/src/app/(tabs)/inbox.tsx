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
 *
 * The screen is the Activity feed's sibling and is built the same way: one
 * virtualized `SectionList` cut into day headings, its loading / error / empty
 * states carried by `ListEmptyComponent`, and one memoized row so a fast fling
 * mounts nothing it does not have to. What differs is only the content — a
 * notification sentence and a read/unread dot in place of an activity line and
 * its amount.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, RefreshControl, SectionList, View } from 'react-native';

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

import { dayHeading, relativeTime } from '@/data/activity';
import { useCaptures, useMarkNotificationsRead, useNotifications } from '@/data/hooks';
import { groupNotificationsByDay, type NotificationDaySection } from '@/data/inbox';
import { FeedSkeleton } from '@/components/Skeletons';
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

// The tint each kind's tile leans in — the same soft rounded-square tile the
// Activity feed uses (`verbTint`), so the two sibling screens read as one. A
// kind this build has not tinted falls back to the neutral lilac.
type TintKey = 'lilac' | 'pink' | 'mint' | 'peach' | 'sky' | 'coral';
const TINTS: Record<string, TintKey> = {
  settlement_confirmed: 'mint',
  settlement_initiated: 'sky',
  settlement_confirm_request: 'peach',
  trip_nudge_morning: 'peach',
  trip_nudge_evening: 'lilac',
  nudge: 'coral',
  expense_added: 'sky',
  ghost_claimed: 'mint',
  group_invite_accepted: 'mint',
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

/**
 * One row of the virtualized inbox, memoized so a recycled row that lands on the
 * same notification does no work when the parent re-renders — the same pattern
 * `ActivityFeedRow` uses. Every prop is a primitive or a reference the screen
 * keeps stable (`t`/`theme` from context, `rtf` hoisted per locale), so the
 * shallow `memo` compare holds on a fast fling, and `relativeTime` is handed the
 * hoisted `rtf` instead of building an `Intl.RelativeTimeFormat` per row.
 *
 * The row is the Activity feed's, to the letter: a soft rounded-square tile
 * whose tint leans with the kind, the sentence beside it, and a muted meta line
 * (relative time · group). Read/unread is the one thing the feed does not carry,
 * so it lives as a small brand dot on the right rather than a highlighted row —
 * the list stays a clean feed.
 */
const InboxFeedRow = memo(function InboxFeedRow({
  row,
  locale,
  theme,
  rtf,
}: {
  row: NotificationRow;
  locale: string;
  theme: ReturnType<typeof useTheme>;
  rtf: Intl.RelativeTimeFormat | undefined;
}) {
  const facts = factsOf(row);
  const { title, body } = renderNotification(row.kind, facts, locale, {
    title: row.title,
    body: row.body,
  });
  const unreadRow = row.read_at === null;
  const tint = theme.tint[TINTS[row.kind] ?? 'lilac'];
  return (
    <Pressable
      accessibilityRole={row.group_id ? 'button' : undefined}
      accessibilityLabel={title}
      onPress={row.group_id ? () => router.push(`/group/${row.group_id}` as never) : undefined}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Row
        style={{
          gap: theme.spacing.md,
          alignItems: 'center',
          paddingVertical: theme.spacing.sm,
        }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tint.bg,
          }}
        >
          <Ionicons
            name={ICONS[row.kind] ?? 'notifications-outline'}
            size={iconSize.lg}
            color={tint.ink}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="body" numberOfLines={2}>
            {title}
          </Text>
          {body ? (
            <Text variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: 2 }}>
              {body}
            </Text>
          ) : null}
          {/* The relative time, plus which group the notification belongs to —
              the same cross-group meta line the Activity feed carries. */}
          <Row
            style={{
              gap: theme.spacing.sm,
              alignItems: 'center',
              marginTop: 2,
              flexWrap: 'wrap',
            }}
          >
            <Text variant="caption" tone="muted">
              {relativeTime(locale, row.created_at, undefined, rtf)}
            </Text>
            {facts.group ? (
              <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {`· ${facts.group}`}
              </Text>
            ) : null}
          </Row>
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
  );
});

export default function InboxScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const pull = usePullRefresh();
  const { t, locale } = useStrings();
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  // Unassigned captures show as their own card in the header; the count also
  // decides whether an empty notification list is really "nothing yet" or just
  // "nothing but the capture waiting above".
  const captureCount = useCaptures().data?.length ?? 0;

  const rows = notifications.data ?? EMPTY_NOTIFICATIONS;
  const sections = useMemo(() => groupNotificationsByDay(rows), [rows]);

  // One relative-time formatter for the whole list, rebuilt only on a locale
  // change — the same allocation-saving pattern the Activity feed uses so a
  // fast scroll never constructs an `Intl.RelativeTimeFormat` per row.
  const rtf = useMemo(
    () =>
      typeof Intl.RelativeTimeFormat === 'function'
        ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
        : undefined,
    [locale],
  );

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
    <View style={{ gap: theme.spacing.xl, paddingBottom: theme.spacing.lg }}>
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

  // The states the list can be in when there are no rows to show — mounted as
  // the list's empty component so the header, pull-to-refresh and centred layout
  // all still apply exactly as with a feed present, the same way the Activity
  // feed carries its own empty/error/loading states.
  const empty = notifications.isLoading ? (
    // Until the fetch answers, `rows` is empty — which is not the same as "you
    // have no notifications". A feed-shaped skeleton says "what is loading", and
    // its shape matches the real rows so the swap is a fill, not a jump.
    <FeedSkeleton />
  ) : notifications.isError ? (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <EmptyState
        title={t.loadError}
        body={t.loadErrorBody}
        icon={
          <Ionicons name="cloud-offline-outline" size={iconSize.xxl} color={theme.color.brand} />
        }
        action={
          <Button label={t.retry} variant="secondary" onPress={() => notifications.refetch()} />
        }
      />
    </View>
  ) : captureCount > 0 ? (
    // No notifications, but a capture is waiting in the header above — that card
    // is the content, so the "nothing yet" verdict would be wrong here.
    <View />
  ) : (
    // Centred, with a glyph — the "all square" treatment the Activity feed uses,
    // so an empty inbox reads as a state and not a screen that failed to load.
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <EmptyState
        title={t.nothingYet}
        body={t.inbox.nothingYetBody}
        icon={
          <Ionicons name="notifications-outline" size={iconSize.xxl} color={theme.color.brand} />
        }
      />
    </View>
  );

  return (
    <Screen>
      {/* One virtualized list cut into day headings — the Activity feed's exact
          shape. Only the rows near the viewport are mounted and they recycle as
          the inbox scrolls, so a heavy account's memory and mount cost stay
          bounded no matter how far back the history goes. */}
      <SectionList<NotificationRow, NotificationDaySection>
        sections={sections}
        keyExtractor={(row) => row.id}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          // So the empty, error and loading states can take the room the feed is
          // not using and sit centred. With a feed present this changes nothing.
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
        // No `removeClippedSubviews`: on Android it can leave off-screen rows
        // detached after a fast fling, blanking the viewport mid-scroll (the
        // same failure the activity feed hit). `windowSize` bounds what is
        // mounted without the clipping that caused it.
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        // The footnote only earns its place under a real feed; with no rows the
        // empty state owns the screen and a footer beneath it would just clutter.
        ListFooterComponent={
          sections.length > 0 ? (
            <Text
              variant="micro"
              tone="muted"
              align="center"
              style={{ marginTop: theme.spacing.lg }}
            >
              {t.extras.deliveryComesLater}
            </Text>
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.color.brand}
          />
        }
        renderSectionHeader={({ section }) => (
          <Text
            variant="micro"
            tone="muted"
            style={{
              textTransform: 'uppercase',
              marginTop: theme.spacing.lg,
              marginBottom: theme.spacing.md,
              backgroundColor: theme.color.bg,
            }}
          >
            {dayHeading(locale, section.first.created_at)}
          </Text>
        )}
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: theme.color.border }} />
        )}
        renderItem={({ item }) => (
          <InboxFeedRow row={item} locale={locale} theme={theme} rtf={rtf} />
        )}
      />
    </Screen>
  );
}
