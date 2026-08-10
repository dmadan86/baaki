import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import {
  Avatar,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
  tintForKey,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { describeActivity } from '@/data/activity';
import { fetchRecentActivity } from '@/data/api';
import { FeedSkeleton } from '@/components/Skeletons';
import { useNotifications } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function ActivityScreen() {
  const theme = useTheme();
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

  const byDay = entries.reduce<Record<string, typeof entries>>((groups, entry) => {
    const day = entry.created_at.slice(0, 10);
    groups[day] = [...(groups[day] ?? []), entry];
    return groups;
  }, {});

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
            refreshing={activity.isFetching && !activity.isLoading}
            onRefresh={() => void activity.refetch()}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ paddingTop: theme.spacing.md, justifyContent: 'space-between' }}>
          <Text variant="title">{t.activity}</Text>
          {/* The feed is what happened in the groups; the inbox is what Baaki
              said to you. Related enough to sit together, different enough not
              to be interleaved. */}
          <IconButton label={t.tabs.inbox} onPress={() => router.push('/inbox' as never)}>
            <Ionicons name="notifications-outline" size={20} color={theme.color.text} />
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
          Object.entries(byDay).map(([day, dayEntries]) => (
            <View key={day}>
              <SectionHeader
                title={new Intl.DateTimeFormat(locale, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                }).format(new Date(day))}
              />
              <View style={{ gap: theme.spacing.md }}>
                {dayEntries.map((entry) => {
                  // The entry wears its group's colour, tying the feed back to
                  // the group cards on home. The amount is a recorded figure,
                  // not a balance, so it is neutral in the tint's ink.
                  const tint = tintForKey(entry.group_id);
                  const ink = theme.tint[tint].ink;
                  return (
                    <Pressable
                      key={entry.id}
                      accessibilityRole="button"
                      accessibilityLabel={describeActivity(entry, myProfileId)}
                      onPress={() => router.push(`/group/${entry.group_id}`)}
                      style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
                    >
                      <TintCard
                        tint={tint}
                        style={{ borderRadius: theme.radius.lg, padding: theme.spacing.lg }}
                      >
                        <Row style={{ gap: theme.spacing.md, alignItems: 'flex-start' }}>
                          <Avatar
                            name={entry.group?.name ?? t.tabs.group}
                            emoji={entry.group?.cover_emoji ?? undefined}
                            size={40}
                          />
                          <View style={{ flex: 1 }}>
                            <Text variant="subheading" style={{ color: ink }}>
                              {describeActivity(entry, myProfileId)}
                            </Text>
                            <Text variant="caption" style={{ color: ink, opacity: 0.7 }}>
                              {`${entry.group?.name ?? t.tabs.group} · ${new Intl.DateTimeFormat(
                                locale,
                                { hour: 'numeric', minute: '2-digit' },
                              ).format(new Date(entry.created_at))}`}
                            </Text>
                          </View>
                          {typeof entry.payload.amount === 'string' ? (
                            <MoneyText
                              amount={BigInt(entry.payload.amount)}
                              currency={(entry.payload.currency as string) ?? 'INR'}
                              locale={locale}
                              variant="subheading"
                              tone="default"
                              style={{ color: ink }}
                            />
                          ) : null}
                        </Row>
                      </TintCard>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
