import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
  Avatar,
  Card,
  EmptyState,
  ListRow,
  MoneyText,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { fetchRecentActivity } from '@/data/api';
import { useStrings } from '@/i18n';

export default function ActivityScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();

  const activity = useQuery({
    queryKey: ['activity', 'recent'],
    queryFn: () => fetchRecentActivity(),
  });
  const entries = activity.data ?? [];

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
          paddingBottom: 170,
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
        <Text variant="title" style={{ paddingTop: theme.spacing.md }}>
          {t.activity}
        </Text>

        {entries.length === 0 ? (
          <EmptyState
            title={t.nothingYet}
            body="Every expense, edit, deletion and settlement lands here — for everyone in the group."
          />
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
              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {dayEntries.map((entry, index) => (
                  <View key={entry.id}>
                    <ListRow
                      title={describe(entry.verb, entry.object_type, entry.payload)}
                      subtitle={`${entry.group?.name ?? 'Group'} · ${new Intl.DateTimeFormat(
                        locale,
                        {
                          hour: 'numeric',
                          minute: '2-digit',
                        },
                      ).format(new Date(entry.created_at))}`}
                      leading={
                        <Avatar
                          name={entry.group?.name ?? 'Group'}
                          emoji={entry.group?.cover_emoji ?? undefined}
                          size={40}
                        />
                      }
                      onPress={() => router.push(`/group/${entry.group_id}`)}
                      trailing={
                        typeof entry.payload.amount === 'string' ? (
                          <MoneyText
                            amount={BigInt(entry.payload.amount)}
                            currency={(entry.payload.currency as string) ?? 'INR'}
                            locale={locale}
                            variant="subheading"
                          />
                        ) : null
                      }
                    />
                    {index < dayEntries.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                ))}
              </Card>
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

function describe(verb: string, objectType: string, payload: Record<string, unknown>): string {
  const description = typeof payload.description === 'string' ? payload.description : null;
  switch (verb) {
    case 'added':
      return description ?? 'New expense';
    case 'edited':
      return `Edited ${description ?? 'an expense'}`;
    case 'deleted':
      return `Deleted ${description ?? 'an expense'}`;
    case 'restored':
      return `Restored ${description ?? 'an expense'}`;
    case 'settled':
      return 'Settlement recorded';
    case 'confirmed':
      return 'Settlement confirmed';
    case 'created':
      return `Group created`;
    default:
      return `${verb} ${objectType}`;
  }
}
