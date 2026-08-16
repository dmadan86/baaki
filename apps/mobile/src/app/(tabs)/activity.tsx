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

import { describeActivity, relativeTime, verbEmoji } from '@/data/activity';
import { fetchRecentActivity } from '@/data/api';
import { FeedSkeleton } from '@/components/Skeletons';
import { useNotifications } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { usePullRefresh } from '@/lib/pullRefresh';

/** A payload amount only counts if it parses. Anything else renders as nothing. */
function parseMoney(payload: Record<string, unknown>): { amount: bigint; currency: string } | null {
  if (typeof payload.amount !== 'string') return null;
  try {
    return {
      amount: BigInt(payload.amount),
      currency: typeof payload.currency === 'string' ? payload.currency : 'INR',
    };
  } catch {
    return null;
  }
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
          <EmptyState
            title={t.loadError}
            body={t.loadErrorBody}
            action={
              <Button label={t.retry} variant="secondary" onPress={() => activity.refetch()} />
            }
          />
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
