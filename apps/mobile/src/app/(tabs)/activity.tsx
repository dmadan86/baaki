import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import {
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

import { describeActivity, verbEmoji } from '@/data/activity';
import { fetchRecentActivity } from '@/data/api';
import { FeedSkeleton } from '@/components/Skeletons';
import { useNotifications } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';

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
        ) : entries.length === 0 ? (
          <EmptyState title={t.nothingYet} body={t.tabs.activityEmptyBody} />
        ) : (
          // A single vertical timeline: each event is a node on a connector line
          // running down the left, its icon in a soft circle tinted by the group
          // it belongs to, the sentence beside it and the relative time beneath.
          <View>
            {entries.map((entry, index) => {
              const isLast = index === entries.length - 1;
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
                        paddingLeft: theme.spacing.md,
                        paddingBottom: isLast ? 0 : theme.spacing.xl,
                      }}
                    >
                      <Row style={{ gap: theme.spacing.sm, alignItems: 'flex-start' }}>
                        <Text variant="body" numberOfLines={3} style={{ flex: 1 }}>
                          {describeActivity(entry, myProfileId)}
                        </Text>
                        {typeof entry.payload.amount === 'string' ? (
                          <MoneyText
                            amount={BigInt(entry.payload.amount)}
                            currency={(entry.payload.currency as string) ?? 'INR'}
                            locale={locale}
                            variant="subheading"
                            tone="default"
                          />
                        ) : null}
                      </Row>
                      <Text variant="micro" tone="muted" style={{ marginTop: 2 }}>
                        {relativeTime(locale, entry.created_at)}
                      </Text>
                    </View>
                  </Row>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * "19m ago", "yesterday" — a localized relative time for a timeline entry.
 *
 * Intl.RelativeTimeFormat does the wording and the plural in every locale, and
 * `numeric: 'auto'` is what turns "1 day ago" into "yesterday". The unit is the
 * largest that leaves a count of at least one, so a three-hour-old event reads
 * in hours, not 180 minutes.
 */
function relativeTime(locale: string, iso: string): string {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(seconds / 86400), 'day');
  if (abs < 2629800) return rtf.format(Math.round(seconds / 604800), 'week');
  if (abs < 31557600) return rtf.format(Math.round(seconds / 2629800), 'month');
  return rtf.format(Math.round(seconds / 31557600), 'year');
}
