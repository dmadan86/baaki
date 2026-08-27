import { memo, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, RefreshControl, SectionList, View } from 'react-native';

import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import {
  activityDateSpan,
  dayHeading,
  describeActivity,
  filterByDayRange,
  groupByDay,
  parseMoney,
  relativeTime,
  verbIcon,
  verbTint,
} from '@/data/activity';
import { useBlockedUsers } from '@/data/blocked';
import { ActivityDateFilter, type DateRange } from '@/components/ActivityDateFilter';
import { FeedSkeleton } from '@/components/Skeletons';
import { useNotifications, useRecentActivity, type RecentActivityRow } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';
import { SyncStatus, useSync } from '@/sync';

type DaySection = { key: string; first: RecentActivityRow; data: RecentActivityRow[] };

/**
 * One row of the virtualized activity feed, memoized so a recycled row that
 * lands on the same entry does no work when the parent re-renders — the same
 * pattern the expense feed uses. Every prop is a primitive or a reference the
 * screen keeps stable (`t`/`theme` from context, `rtf` hoisted per locale), so
 * the shallow `memo` compare holds on a fast fling.
 *
 * `describeActivity` is called once here, not twice (spoken label + visible
 * line), and `relativeTime` is handed the hoisted `rtf` instead of building an
 * `Intl.RelativeTimeFormat` per row — the two allocations that made this feed
 * heavier to scroll than the expense feed it mirrors.
 */
const ActivityFeedRow = memo(function ActivityFeedRow({
  entry,
  locale,
  t,
  theme,
  myProfileId,
  blockedIds,
  rtf,
}: {
  entry: RecentActivityRow;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
  theme: ReturnType<typeof useTheme>;
  myProfileId: string | null;
  blockedIds: ReturnType<typeof useBlockedUsers>['blockedIds'];
  rtf: Intl.RelativeTimeFormat | undefined;
}) {
  const money = parseMoney(entry.payload);
  // A soft rounded-square tile whose tint leans with the verb — the same row the
  // group's Activity tab and the Expenses tab use, so activity reads one way
  // everywhere. No timeline rail; the day headings above do the sectioning,
  // hairlines do the between-row separation.
  const tint = theme.tint[verbTint(entry.verb)];
  const g = entry.group;
  const groupLabel = g
    ? [g.cover_emoji, g.name].filter(Boolean).join(' ').trim() || t.captures.group
    : null;
  const label = describeActivity(entry, myProfileId, blockedIds, t.misc.someone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push(`/group/${entry.group_id}`)}
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
          <Ionicons name={verbIcon(entry.verb)} size={iconSize.lg} color={tint.ink} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="body" numberOfLines={2}>
            {label}
          </Text>
          {/* The relative time, plus which group the entry belongs to — this is a
              cross-group feed, so the row would otherwise not say. An archived
              group, or one no longer on this device (left or deleted), gets a
              badge so it is recognisable without opening it. */}
          <Row
            style={{
              gap: theme.spacing.sm,
              alignItems: 'center',
              marginTop: 2,
              flexWrap: 'wrap',
            }}
          >
            <Text variant="caption" tone="muted">
              {relativeTime(locale, entry.created_at, undefined, rtf)}
            </Text>
            {groupLabel ? (
              <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {`· ${groupLabel}`}
              </Text>
            ) : null}
            {g?.archived_at ? (
              <Badge label={t.misc.archivedGroup} tone="neutral" />
            ) : !g ? (
              <Badge label={t.misc.unavailableGroup} tone="neutral" />
            ) : null}
          </Row>
        </View>
        {/* `payload` is an untyped JSON blob, so a bad amount must render as no
            amount, not as a crashed tab. Red like the shares and balances — one
            money colour across every screen. */}
        {money ? (
          <MoneyText
            amount={money.amount}
            currency={money.currency}
            locale={locale}
            variant="subheading"
            tone="negative"
          />
        ) : null}
      </Row>
    </Pressable>
  );
});

export default function ActivityScreen() {
  const theme = useTheme();
  const pull = usePullRefresh();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { session } = useAuth();
  const myProfileId = session?.user.id ?? null;
  const { blockedIds } = useBlockedUsers();

  // The feed is read straight from the mirror, so it is here offline and the
  // moment the screen opens; `hydrated` is the one wait — the first read of the
  // on-disk mirror at cold start, not a network call. If that read itself fails
  // (`status` goes to Error while still unhydrated), a retry re-runs it via
  // `flush`, so the screen offers a way out rather than a skeleton forever.
  const { hydrated, status, flush } = useSync();
  const allEntries = useRecentActivity();

  // Filtering a long feed to a date span. The whole history is on the phone, so
  // this is a pure client-side cut — no fetch. `range` is the committed filter
  // (null = the full feed); `filterOpen` toggles the range-picker sheet.
  const [range, setRange] = useState<DateRange | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  // The feed's own start and end, in the phone's timezone. Clamps the picker so
  // a day outside the activity's span cannot be chosen. Null when the feed is
  // empty — there is then nothing to filter and no button to offer.
  const span = useMemo(() => activityDateSpan(allEntries), [allEntries]);

  // The rows actually shown: the whole feed, or the slice inside the range.
  const visibleEntries = useMemo(
    () => (range ? filterByDayRange(allEntries, range.start, range.end) : allEntries),
    [allEntries, range],
  );

  // The whole history is already on the phone (the mirror), so there is no page
  // to fetch — the list is fully known. `SectionList` virtualizes it: only the
  // rows near the viewport are mounted, and they recycle as the feed scrolls, so
  // a heavy account's memory and mount cost stay bounded no matter how far back
  // it goes. (This replaced a plain `ScrollView` that grew a window but never
  // recycled a mounted row.)
  const sections: DaySection[] = useMemo(
    () =>
      groupByDay(visibleEntries).map((section) => ({
        key: section.key,
        first: section.entries[0]!,
        data: section.entries,
      })),
    [visibleEntries],
  );

  // The active range worded for the chip: one date when start and end share a
  // day, "start – end" otherwise. Formatted in the current locale.
  const showDay = (value: Date): string =>
    value.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const rangeLabel = range
    ? sameDay(range.start, range.end)
      ? showDay(range.start)
      : `${showDay(range.start)} – ${showDay(range.end)}`
    : '';

  // One relative-time formatter for the whole feed, rebuilt only when the locale
  // changes — handed to every row so a fast scroll never constructs an
  // `Intl.RelativeTimeFormat` per recycled row.
  const rtf = useMemo(
    () =>
      typeof Intl.RelativeTimeFormat === 'function'
        ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
        : undefined,
    [locale],
  );

  const notifications = useNotifications();
  const unread = (notifications.data ?? []).filter((row) => row.read_at === null).length;

  const header = (
    <View>
      <Row style={{ paddingTop: theme.spacing.md, justifyContent: 'space-between' }}>
        <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          <Ionicons name="pulse" size={iconSize.xl} color={theme.color.brand} />
          <Text variant="title">{t.activity}</Text>
        </Row>
        <Row style={{ alignItems: 'center' }}>
          {/* A long feed is easier to read a day or a span at a time — the
              calendar opens a range picker clamped to the feed's own start and
              end. Only offered once there is a feed to narrow. A filled glyph in
              the brand tint marks an active filter, matching the app's
              filled/outline idiom. */}
          {span ? (
            <IconButton label={t.activityFilter.open} onPress={() => setFilterOpen(true)}>
              <Ionicons
                name={range ? 'calendar' : 'calendar-outline'}
                size={iconSize.lg}
                color={range ? theme.color.brand : theme.color.text}
              />
            </IconButton>
          ) : null}
          {/* The feed is what happened in the groups; the inbox is what Baaki
              said to you. Related enough to sit together, different enough not
              to be interleaved. */}
          <IconButton label={t.tabs.inbox} onPress={() => router.navigate('/inbox')}>
            <Ionicons name="notifications-outline" size={iconSize.lg} color={theme.color.text} />
            {unread > 0 ? (
              <View
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                  backgroundColor: theme.color.brand,
                }}
              />
            ) : null}
          </IconButton>
        </Row>
      </Row>

      {/* The active range as a clearable pill: tap the body to adjust it, the ✕
          to drop back to the full feed. Visible state so a narrowed feed never
          looks like a short one. */}
      {range ? (
        <Row style={{ marginTop: theme.spacing.sm }}>
          <Row
            style={{
              alignItems: 'center',
              gap: theme.spacing.xs,
              paddingLeft: theme.spacing.md,
              paddingRight: theme.spacing.xs,
              paddingVertical: 4,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.color.brandSoft,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t.activityFilter.open}: ${rangeLabel}`}
              onPress={() => setFilterOpen(true)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.xs,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Ionicons name="calendar" size={iconSize.sm} color={theme.color.brand} />
              <Text variant="caption" style={{ color: theme.color.brand }}>
                {rangeLabel}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.activityFilter.clearFilter}
              onPress={() => setRange(null)}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Ionicons name="close-circle" size={iconSize.md} color={theme.color.brand} />
            </Pressable>
          </Row>
        </Row>
      ) : null}
    </View>
  );

  // The states the feed can be in when there are no rows to show — mounted as
  // the list's empty component so the header, pull-to-refresh and centred layout
  // all still apply exactly as with a feed present.
  const empty = !hydrated ? (
    status === SyncStatus.Error ? (
      // The mirror read itself failed (a corrupt or unreadable local DB). Rare,
      // but without this branch the skeleton would sit forever — so offer a
      // retry, which re-runs hydration through a flush.
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <EmptyState
          title={t.loadError}
          body={t.loadErrorBody}
          icon={
            <Ionicons name="cloud-offline-outline" size={iconSize.xxl} color={theme.color.brand} />
          }
          action={<Button label={t.retry} variant="secondary" onPress={() => void flush()} />}
        />
      </View>
    ) : (
      // The ordinary wait: the first read of the on-disk mirror at cold start.
      // An empty feed after it lands is "nothing yet", not "failed".
      <FeedSkeleton />
    )
  ) : range ? (
    // A range is in force and nothing fell in it — distinct from "nothing yet",
    // and the way out is to widen or clear the filter, not to start a group.
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <EmptyState
        title={t.activityFilter.noneTitle}
        body={t.activityFilter.noneBody}
        icon={<Ionicons name="calendar-outline" size={iconSize.xxl} color={theme.color.brand} />}
        action={
          <Button
            label={t.activityFilter.clear}
            variant="secondary"
            onPress={() => setRange(null)}
          />
        }
      />
    </View>
  ) : (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <EmptyState
        title={t.nothingYet}
        body={t.tabs.activityEmptyBody}
        icon={<Ionicons name="pulse" size={iconSize.xxl} color={theme.color.brand} />}
        action={<Button label={t.newGroup} onPress={() => router.push('/new-group')} />}
      />
    </View>
  );

  return (
    <Screen>
      {/* A vertical timeline broken into days: each event is a node on a
          connector line running down the left, its icon in a soft circle, the
          sentence beside it and the time beneath. The day headings are what make
          a long feed skimmable — without them every row had to be read to place
          it in time. */}
      <SectionList<RecentActivityRow, DaySection>
        sections={sections}
        keyExtractor={(entry) => entry.id}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          // So the empty and error states can take the room the feed is not
          // using and sit centred. With a feed present this changes nothing.
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        // No `removeClippedSubviews`: on Android it detaches off-screen subviews
        // and, on a fast fling of this SectionList, fails to re-attach them —
        // the whole viewport blanks out mid-scroll (rows vanish, only the
        // scrollbar remains). `windowSize` already bounds how much is mounted, so
        // virtualization holds without the clipping that caused the blanking.
        initialNumToRender={12}
        windowSize={9}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
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
          <ActivityFeedRow
            entry={item}
            locale={locale}
            t={t}
            theme={theme}
            myProfileId={myProfileId}
            blockedIds={blockedIds}
            rtf={rtf}
          />
        )}
      />
      {/* The range picker, over the feed. Rendered only when open and only when
          there is a span to clamp to, so it can seed the picker from real dates. */}
      {filterOpen && span ? (
        <ActivityDateFilter
          earliest={span.earliest}
          latest={span.latest}
          locale={locale}
          initial={range}
          onApply={setRange}
          onClear={() => setRange(null)}
          onClose={() => setFilterOpen(false)}
        />
      ) : null}
    </Screen>
  );
}
