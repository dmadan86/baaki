import { useMemo } from 'react';
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
  dayHeading,
  describeActivity,
  groupByDay,
  parseMoney,
  relativeTime,
  verbIcon,
  verbTint,
} from '@/data/activity';
import { useBlockedUsers } from '@/data/blocked';
import { FeedSkeleton } from '@/components/Skeletons';
import { useNotifications, useRecentActivity, type RecentActivityRow } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';
import { SyncStatus, useSync } from '@/sync';

type DaySection = { key: string; first: RecentActivityRow; data: RecentActivityRow[] };

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

  // The whole history is already on the phone (the mirror), so there is no page
  // to fetch — the list is fully known. `SectionList` virtualizes it: only the
  // rows near the viewport are mounted, and they recycle as the feed scrolls, so
  // a heavy account's memory and mount cost stay bounded no matter how far back
  // it goes. (This replaced a plain `ScrollView` that grew a window but never
  // recycled a mounted row.)
  const sections: DaySection[] = useMemo(
    () =>
      groupByDay(allEntries).map((section) => ({
        key: section.key,
        first: section.entries[0]!,
        data: section.entries,
      })),
    [allEntries],
  );

  const notifications = useNotifications();
  const unread = (notifications.data ?? []).filter((row) => row.read_at === null).length;

  const header = (
    <Row style={{ paddingTop: theme.spacing.md, justifyContent: 'space-between' }}>
      <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Ionicons name="pulse" size={iconSize.xl} color={theme.color.brand} />
        <Text variant="title">{t.activity}</Text>
      </Row>
      {/* The feed is what happened in the groups; the inbox is what Baaki said
          to you. Related enough to sit together, different enough not to be
          interleaved. */}
      <IconButton label={t.tabs.inbox} onPress={() => router.push('/inbox' as never)}>
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
        // Recycle offscreen rows rather than keep every scrolled-past one
        // mounted — the point of moving off the old ScrollView.
        removeClippedSubviews
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
        renderItem={({ item: entry }) => {
          const money = parseMoney(entry.payload);
          // A soft rounded-square tile whose tint leans with the verb — the same
          // row the group's Activity tab and the Expenses tab use, so activity
          // reads one way everywhere. No timeline rail; the day headings above
          // do the sectioning, hairlines do the between-row separation.
          const tint = theme.tint[verbTint(entry.verb)];
          const g = entry.group;
          const groupLabel = g
            ? [g.cover_emoji, g.name].filter(Boolean).join(' ').trim() || t.captures.group
            : null;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={describeActivity(entry, myProfileId, blockedIds, t.misc.someone)}
              onPress={() => router.push(`/group/${entry.group_id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
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
                    {describeActivity(entry, myProfileId, blockedIds, t.misc.someone)}
                  </Text>
                  {/* The relative time, plus which group the entry belongs to —
                      this is a cross-group feed, so the row would otherwise not
                      say. An archived group, or one no longer on this device
                      (left or deleted), gets a badge so it is recognisable
                      without opening it. */}
                  <Row
                    style={{
                      gap: theme.spacing.sm,
                      alignItems: 'center',
                      marginTop: 2,
                      flexWrap: 'wrap',
                    }}
                  >
                    <Text variant="caption" tone="muted">
                      {relativeTime(locale, entry.created_at)}
                    </Text>
                    {groupLabel ? (
                      <Text
                        variant="caption"
                        tone="muted"
                        numberOfLines={1}
                        style={{ flexShrink: 1 }}
                      >
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
                {/* `payload` is an untyped JSON blob, so a bad amount must render
                    as no amount, not as a crashed tab. Red like the shares and
                    balances — one money colour across every screen. */}
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
        }}
      />
    </Screen>
  );
}
