import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import {
  Button,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  tintForKey,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { dayHeading, dayKey, describeActivity, parseMoney, verbEmoji } from '@/data/activity';
import { fetchRecentActivity } from '@/data/api';
import { FeedSkeleton } from '@/components/Skeletons';
import { useNotifications } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';

/**
 * The feed cut into calendar days, newest first, order otherwise untouched — the
 * query already returns it sorted, so this only draws the lines between days.
 */
function groupByDay<T extends { created_at: string }>(
  entries: readonly T[],
): { key: string; entries: T[] }[] {
  const sections: { key: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.created_at);
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else sections.push({ key, entries: [entry] });
  }
  return sections;
}

export default function ActivityScreen() {
  const theme = useTheme();
  const pull = usePullRefresh();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { session } = useAuth();
  const myProfileId = session?.user.id ?? null;

  const activity = useQuery({
    queryKey: ['activity', 'recent'],
    queryFn: () => fetchRecentActivity(),
  });
  const entries = activity.data ?? [];

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

        {activity.isLoading ? (
          <FeedSkeleton />
        ) : activity.isError ? (
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
                <Button label={t.retry} variant="secondary" onPress={() => activity.refetch()} />
              }
            />
          </View>
        ) : entries.length === 0 ? (
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
                  const tint = tintForKey(entry.group_id);
                  return (
                    <Pressable
                      key={entry.id}
                      accessibilityRole="button"
                      accessibilityLabel={describeActivity(entry, myProfileId)}
                      onPress={() => router.push(`/group/${entry.group_id}`)}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Row style={{ alignItems: 'stretch' }}>
                        {/* The rail: the node, then the line running down to the next
                        node — dropped for the last row so it stops, not dangles. */}
                        <View style={{ width: 38, alignItems: 'center' }}>
                          <View
                            style={{
                              width: 38,
                              height: 38,
                              borderRadius: 19,
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: theme.tint[tint].bg,
                            }}
                          >
                            <Text style={{ fontSize: 16 }}>{verbEmoji(entry.verb)}</Text>
                          </View>
                          {!isLast ? (
                            <View
                              style={{
                                flex: 1,
                                width: 2,
                                marginVertical: 2,
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
                              {describeActivity(entry, myProfileId)}
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
