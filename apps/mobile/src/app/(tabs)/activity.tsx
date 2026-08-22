import { useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, RefreshControl, SectionList, View } from 'react-native';

import {
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

import { dayHeading, describeActivity, groupByDay, parseMoney, verbIcon } from '@/data/activity';
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

  // One formatter per locale, not one per row per render. Building an
  // `Intl.DateTimeFormat` is costly, and the row clock did it O(rows) times a
  // render — the single most avoidable cost in a long feed.
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
    [locale],
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
        renderItem={({ item: entry, index, section }) => {
          const isLast = index === section.data.length - 1;
          const money = parseMoney(entry.payload);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={describeActivity(entry, myProfileId, blockedIds, t.misc.someone)}
              onPress={() => router.push(`/group/${entry.group_id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Row style={{ alignItems: 'stretch' }}>
                {/* The rail: the node — the dashboard's line glyph in a soft
                    circle — and a thin connector running from it down to the
                    next node, so the day reads as one continuous timeline rather
                    than loose rows. The connector stops at the last node so it
                    ends, not dangles. */}
                <View style={{ width: 42, alignItems: 'center' }}>
                  <View
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 21,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons
                      name={verbIcon(entry.verb)}
                      size={iconSize.xl}
                      color={theme.color.brand}
                    />
                  </View>
                  {!isLast ? (
                    <View
                      style={{
                        flex: 1,
                        width: 2,
                        marginTop: theme.spacing.xs,
                        borderRadius: 1,
                        backgroundColor: theme.color.border,
                      }}
                    />
                  ) : null}
                </View>

                <View
                  style={{
                    flex: 1,
                    paddingStart: theme.spacing.md,
                    paddingBottom: isLast ? 0 : theme.spacing.xl,
                  }}
                >
                  <Row style={{ gap: theme.spacing.sm, alignItems: 'flex-start' }}>
                    <Text variant="body" numberOfLines={3} style={{ flex: 1 }}>
                      {describeActivity(entry, myProfileId, blockedIds, t.misc.someone)}
                    </Text>
                    {/* `payload` is an untyped JSON blob, so a bad amount must
                        render as no amount, not as a crashed tab. */}
                    {money ? (
                      <MoneyText
                        amount={money.amount}
                        currency={money.currency}
                        locale={locale}
                        variant="subheading"
                        tone="default"
                      />
                    ) : null}
                  </Row>
                  {/* The day is the heading's job now, so the row keeps only the
                      clock — "yesterday" printed under a heading that already
                      said it was noise. */}
                  <Text variant="micro" tone="muted" style={{ marginTop: 2 }}>
                    {timeFormat.format(new Date(entry.created_at))}
                  </Text>
                </View>
              </Row>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
