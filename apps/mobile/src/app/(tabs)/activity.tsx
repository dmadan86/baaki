import { memo, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { Pressable, RefreshControl, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';

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
  activityHeadline,
  activityTarget,
  activityTimestamp,
  dayHeading,
  describeActivity,
  filterByDayRange,
  groupByDay,
  parseMoney,
  verbIcon,
  verbTint,
} from '@/data/activity';
import { actorName } from '@/data/types';
import { useBlockedUsers } from '@/data/blocked';
import { ActivityDateFilter, type DateRange } from '@/components/ActivityDateFilter';
import { FeedSkeleton } from '@/components/Skeletons';
import { useGroups, useRecentActivity, type RecentActivityRow } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';
import { SyncStatus, useSync } from '@/sync';

// The day-grouped feed flattened for FlashList, which has no section API: a
// `header` item per day, then that day's `entry` rows. Headers scroll inline
// with their rows (not pinned — sticky headers on this long, variable-height
// feed left blank gaps and misaligned on a fast fling). `firstOfDay` drives the
// between-row hairline so no line falls between a day heading and its first entry.
//
// A row carries a fully pre-computed `RowView`, not the raw entry: the localized
// sentence, actor, group label, relative time, tint and parsed amount are all
// resolved once when the list is built (see `toRowView`), never per render. On a
// fast fling FlashList recycles a cell onto a new row constantly, so the mount
// has to be near-free — recomputing all of that per mount is what let a hard
// fling outrun the recycler into a blank screen.
type RowView = {
  href: Href;
  /** The whole event as one sentence — the spoken (screen-reader) label. */
  label: string;
  /** The visible title, event-first so the feed is skimmable. */
  headline: string;
  who: string | null;
  groupLabel: string | null;
  timestamp: string;
  tintKey: ReturnType<typeof verbTint>;
  icon: ReturnType<typeof verbIcon>;
  money: ReturnType<typeof parseMoney>;
  archived: boolean;
  unavailable: boolean;
};

type FeedRow =
  | { kind: 'header'; key: string; date: string }
  | { kind: 'row'; key: string; firstOfDay: boolean; view: RowView };

type RowContext = {
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
  myProfileId: string | null;
  blockedIds: ReturnType<typeof useBlockedUsers>['blockedIds'];
  rtf: Intl.RelativeTimeFormat | undefined;
};

// Resolve everything a row shows, once, at list-build time. `describeActivity`
// is called once for the spoken label; the visible title uses the lighter
// `activityHeadline`; `rtf` is the hoisted formatter, never rebuilt per row.
function toRowView(entry: RecentActivityRow, ctx: RowContext): RowView {
  const g = entry.group;
  return {
    href: activityTarget(entry) as Href,
    label: describeActivity(entry, ctx.myProfileId, ctx.blockedIds, ctx.t.misc.someone),
    headline: activityHeadline(entry),
    // Nobody did an auto-event, so it carries no actor — omit it rather than say
    // "Someone". A blocked or since-left actor still resolves through actorName.
    who: entry.actor
      ? actorName(entry.actor, ctx.myProfileId, ctx.blockedIds, ctx.t.misc.someone)
      : null,
    groupLabel: g
      ? [g.cover_emoji, g.name].filter(Boolean).join(' ').trim() || ctx.t.captures.group
      : null,
    timestamp: activityTimestamp(ctx.locale, entry.created_at, undefined, ctx.rtf),
    tintKey: verbTint(entry.verb),
    icon: verbIcon(entry.verb),
    money: parseMoney(entry.payload),
    archived: !!g?.archived_at,
    unavailable: !g,
  };
}

/**
 * One row of the virtualized activity feed — purely presentational over a
 * pre-computed `RowView`, and memoized so a recycled cell that lands on the same
 * row does no work. The render is just JSX assembly (no string-building, no
 * parsing), which is what keeps a hard fling from outrunning the recycler.
 */
const ActivityFeedRow = memo(function ActivityFeedRow({
  view,
  locale,
  t,
  theme,
}: {
  view: RowView;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
  theme: ReturnType<typeof useTheme>;
}) {
  // A soft rounded-square tile whose tint leans with the verb — the same row the
  // group's Activity tab and the Expenses tab use, so activity reads one way
  // everywhere. No timeline rail; the day headings above do the sectioning,
  // hairlines do the between-row separation.
  const tint = theme.tint[view.tintKey];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={view.label}
      onPress={() => router.push(view.href)}
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
          <Ionicons name={view.icon} size={iconSize.lg} color={tint.ink} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="body" numberOfLines={2}>
            {view.headline}
          </Text>
          {/* Who · which group · when. The actor sits here now, not in the title;
              the group is named because this is a cross-group feed. An archived
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
            {view.who ? (
              <Text variant="caption" tone="muted">
                {view.who}
              </Text>
            ) : null}
            {view.groupLabel ? (
              <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {`${view.who ? '· ' : ''}${view.groupLabel}`}
              </Text>
            ) : null}
            <Text variant="caption" tone="muted">
              {`${view.who || view.groupLabel ? '· ' : ''}${view.timestamp}`}
            </Text>
            {view.archived ? (
              <Badge label={t.misc.archivedGroup} tone="neutral" />
            ) : view.unavailable ? (
              <Badge label={t.misc.unavailableGroup} tone="neutral" />
            ) : null}
          </Row>
        </View>
        {/* `payload` is an untyped JSON blob, so a bad amount must render as no
            amount, not as a crashed tab. Neutral, not red: this is an expense
            total belonging to nobody in particular, not a balance you owe —
            `mode="plain"` is MoneyText's neutral ink. */}
        {view.money ? (
          <MoneyText
            amount={view.money.amount}
            currency={view.money.currency}
            locale={locale}
            variant="subheading"
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
  // Whether the account has any live group at all — decides the empty-state's
  // next step. A brand-new account with nothing starts a group; an account that
  // has groups but no activity yet wants to add an expense, not make another
  // group. `materialiseGroups` already hides archived trips, so an account left
  // with only archived groups is treated as having none — start-a-group is still
  // the right nudge there.
  const hasGroups = useGroups().data.length > 0;

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

  // One relative-time formatter for the whole feed, rebuilt only when the locale
  // changes — handed to `toRowView` so no `Intl.RelativeTimeFormat` is ever built
  // per row. Declared before the list so the build below can use it.
  const rtf = useMemo(
    () =>
      typeof Intl.RelativeTimeFormat === 'function'
        ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
        : undefined,
    [locale],
  );

  // The whole history is already on the phone (the mirror), so there is no page
  // to fetch — the list is fully known. `FlashList` virtualizes it: only the
  // rows near the viewport are mounted, and they recycle as the feed scrolls, so
  // a heavy account's memory and mount cost stay bounded no matter how far back
  // it goes. FlashList has no sections, so the day cut is flattened into `header`
  // items that scroll inline with their rows (like the group ledger's months).
  //
  // Each row's display is pre-computed here via `toRowView` so a recycled cell
  // mounts with no work. This whole pass only reruns when the data, filter or
  // locale changes — never on scroll — so the up-front cost is paid off-fling.
  const listData = useMemo(() => {
    const ctx: RowContext = { locale, t, myProfileId, blockedIds, rtf };
    const rows: FeedRow[] = [];
    for (const section of groupByDay(visibleEntries)) {
      rows.push({
        kind: 'header',
        key: `day-${section.key}`,
        date: section.entries[0]!.created_at,
      });
      section.entries.forEach((entry, index) => {
        rows.push({
          kind: 'row',
          key: entry.id,
          firstOfDay: index === 0,
          view: toRowView(entry, ctx),
        });
      });
    }
    return rows;
  }, [visibleEntries, locale, t, myProfileId, blockedIds, rtf]);

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
        action={
          hasGroups ? (
            <Button label={t.addExpense} onPress={() => router.push('/capture')} />
          ) : (
            <Button label={t.newGroup} onPress={() => router.push('/new-group')} />
          )
        }
      />
    </View>
  );

  // The range picker, over the feed. Rendered only when open and only when there
  // is a span to clamp to, so it can seed the picker from real dates.
  const picker =
    filterOpen && span ? (
      <ActivityDateFilter
        earliest={span.earliest}
        latest={span.latest}
        locale={locale}
        initial={range}
        onApply={setRange}
        onClear={() => setRange(null)}
        onClose={() => setFilterOpen(false)}
      />
    ) : null;

  // With no rows, FlashList's empty slot renders inside an unbounded scroll view,
  // so a `flex: 1` centre is meaningless there — the header and the centred empty
  // state are laid out directly instead, keeping the same padding the feed uses.
  if (listData.length === 0) {
    return (
      <Screen>
        <View style={{ flex: 1, paddingHorizontal: theme.spacing.xl }}>
          {header}
          {empty}
        </View>
        {picker}
      </Screen>
    );
  }

  return (
    <Screen>
      {/* A feed broken into days: each event is an icon in a soft tile, the
          sentence beside it and the actor/group/time beneath. The day headings
          are what make a long feed skimmable — without them every row had to be
          read to place it in time. */}
      <View style={{ flex: 1 }}>
        {/* The nav header is a fixed sibling above the feed, so only the rows
            scroll under it. Padded to line up with the feed rows below. */}
        <View style={{ paddingHorizontal: theme.spacing.xl }}>{header}</View>
        <FlashList
          data={listData}
          // The row text is locale-formatted, so a language change has to re-run
          // renderItem even though the data array is unchanged.
          extraData={locale}
          keyExtractor={(item) => item.key}
          // Day headings and event rows are structurally different subtrees;
          // typing them lets FlashList recycle like with like.
          getItemType={(item) => item.kind}
          // Render well beyond the viewport so a fast fling never outruns
          // recycling into blank rows (default 250px clears in a frame).
          drawDistance={1500}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: clearance,
          }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={pull.refreshing}
              onRefresh={pull.onRefresh}
              tintColor={theme.color.brand}
            />
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <Text
                variant="micro"
                tone="muted"
                style={{
                  textTransform: 'uppercase',
                  marginTop: theme.spacing.lg,
                  marginBottom: theme.spacing.md,
                }}
              >
                {dayHeading(locale, item.date)}
              </Text>
            ) : (
              // The between-row hairline rides on the row itself — above every row
              // but the day's first, so no line falls under a day heading.
              <View
                style={
                  item.firstOfDay
                    ? undefined
                    : { borderTopWidth: 1, borderTopColor: theme.color.border }
                }
              >
                <ActivityFeedRow view={item.view} locale={locale} t={t} theme={theme} />
              </View>
            )
          }
        />
      </View>
      {picker}
    </Screen>
  );
}
