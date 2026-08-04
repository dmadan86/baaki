import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

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

import { useStrings } from '@/i18n';
import { activityFeed } from '@/mocks/data';

export default function ActivityScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const entries = activityFeed();

  const byDay = entries.reduce<Record<string, typeof entries>>((groups, entry) => {
    const day = entry.at.slice(0, 10);
    groups[day] = [...(groups[day] ?? []), entry];
    return groups;
  }, {});

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: 140,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="title" style={{ paddingTop: theme.spacing.md }}>
          {t.activity}
        </Text>

        {entries.length === 0 ? (
          <EmptyState title={t.nothingYet} body={t.nothingYetBody} />
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
                      title={entry.title}
                      subtitle={entry.subtitle}
                      leading={<Avatar name={entry.groupName} emoji={entry.emoji} size={40} />}
                      onPress={() => router.push(`/group/${entry.groupId}`)}
                      trailing={
                        <MoneyText
                          amount={entry.amount}
                          currency={entry.currency}
                          locale={locale}
                          variant="subheading"
                        />
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
