import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';

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
import { useNotifications, useRecentActivity } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';
import { useSync } from '@/sync';

// How many rows the feed shows at first, and how many more each time the scroll
// nears the bottom. The whole history is already on the phone (the mirror), so
// this only bounds how much is mounted at once — a cheap window, not a fetch.
const PAGE = 25;
// Grow the window a little before the very end scrolls into view, so more rows
// are already there rather than appearing under the thumb.
const LOAD_AHEAD_PX = 600;

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
  // on-disk mirror at cold start, not a network call.
  const { hydrated } = useSync();
  const allEntries = useRecentActivity();

  // Infinite scroll over the local list: show `visible` rows, grow the window as
  // the scroll nears the bottom. No page is ever fetched — the rows are already
  // on the phone.
  const [visible, setVisible] = useState(PAGE);
  const entries = allEntries.slice(0, visible);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const nearBottom =
      layoutMeasurement.height + contentOffset.y >= contentSize.height - LOAD_AHEAD_PX;
    if (nearBottom && visible < allEntries.length) {
      setVisible((current) => Math.min(current + PAGE, allEntries.length));
    }
  };

  const notifications = useNotifications();
  const unread = (notifications.data ?? []).filter((row) => row.read_at === null).length;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
          // So the empty and error states can take the room the feed is not using
          // and sit centred, the same way the Friends screen does. With a feed
          // present this changes nothing.
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ paddingTop: theme.spacing.md, justifyContent: 'space-between' }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <Ionicons name="pulse" size={iconSize.xl} color={theme.color.brand} />
            <Text variant="title">{t.activity}</Text>
          </Row>
          {/* The feed is what happened in the groups; the inbox is what Baaki
              said to you. Related enough to sit together, different enough not
              to be interleaved. */}
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

        {!hydrated && allEntries.length === 0 ? (
          // The only wait is the first read of the on-disk mirror. There is no
          // error branch: a mirror read cannot fail the way a network call can,
          // and an empty feed after hydration is "nothing yet", not "failed".
          <FeedSkeleton />
        ) : allEntries.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              title={t.nothingYet}
              body={t.tabs.activityEmptyBody}
              icon={<Ionicons name="pulse" size={iconSize.xxl} color={theme.color.brand} />}
              action={<Button label={t.newGroup} onPress={() => router.push('/new-group')} />}
            />
          </View>
        ) : (
          // A vertical timeline broken into days: each event is a node on a
          // connector line running down the left, its icon in a soft circle
          // tinted by the group it belongs to, the sentence beside it and the
          // time beneath. The day headings are what make forty rows skimmable —
          // without them every row had to be read to place it in time.
          <View style={{ gap: theme.spacing.lg }}>
            {groupByDay(entries).map((section) => (
              <View key={section.key}>
                <Text
                  variant="micro"
                  tone="muted"
                  style={{ textTransform: 'uppercase', marginBottom: theme.spacing.md }}
                >
                  {dayHeading(locale, section.entries[0]!.created_at)}
                </Text>
                {section.entries.map((entry, index) => {
                  const isLast = index === section.entries.length - 1;
                  return (
                    <Pressable
                      key={entry.id}
                      accessibilityRole="button"
                      accessibilityLabel={describeActivity(
                        entry,
                        myProfileId,
                        blockedIds,
                        t.misc.someone,
                      )}
                      onPress={() => router.push(`/group/${entry.group_id}`)}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Row style={{ alignItems: 'stretch' }}>
                        {/* The rail: the node — the dashboard's line glyph in a
                        soft-brand circle — and a thin connector running from it
                        down to the next node, so the day reads as one continuous
                        timeline (Oura, Airwallex) rather than loose rows. The
                        connector is a hairline in brandSoft, centred on the
                        circle, and it stops at the last node so it ends, not
                        dangles. */}
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
                            {/* `payload` is an untyped JSON blob, so a bad amount
                            must render as no amount, not as a crashed tab. */}
                            {(() => {
                              const money = parseMoney(entry.payload);
                              if (!money) return null;
                              return (
                                <MoneyText
                                  amount={money.amount}
                                  currency={money.currency}
                                  locale={locale}
                                  variant="subheading"
                                  tone="default"
                                />
                              );
                            })()}
                          </Row>
                          {/* The day is the heading's job now, so the row keeps only
                          the clock — "yesterday" printed forty times under a
                          heading that already said it was noise. */}
                          <Text variant="micro" tone="muted" style={{ marginTop: 2 }}>
                            {new Intl.DateTimeFormat(locale, {
                              hour: 'numeric',
                              minute: '2-digit',
                            }).format(new Date(entry.created_at))}
                          </Text>
                        </View>
                      </Row>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
