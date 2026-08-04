import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';

import { format } from '@baaki/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  tintForKey,
  useTheme,
} from '@baaki/ui';

import { useGroups, useHomeSummary } from '@/data/hooks';
import { fill, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function HomeScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { profile, isGuest } = useAuth();

  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);

  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

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
            refreshing={(groups.isFetching || summary.isFetching) && !loading}
            onRefresh={() => {
              void groups.refetch();
              summary.refetch();
            }}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <Avatar name={profile?.display_name ?? 'You'} size={46} />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              {t.greeting},
            </Text>
            <Text variant="heading" numberOfLines={1}>
              {profile?.display_name ?? 'You'}
            </Text>
          </View>
          <IconButton label={t.newGroup} onPress={() => router.push('/new-group')}>
            <Ionicons name="add" size={22} color={theme.color.text} />
          </IconButton>
        </Row>

        {isGuest ? (
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">
              You are using Baaki as a guest
            </Text>
            <Text variant="caption" tone="muted">
              Add a phone number in Account whenever you like — everything you have entered comes
              with you.
            </Text>
          </Card>
        ) : null}

        {/* Headline: one glance answers "am I up or down?" */}
        <Card style={{ backgroundColor: theme.color.brand, gap: theme.spacing.lg }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="onBrand" style={{ opacity: 0.8 }}>
              {t.yourBaaki}
            </Text>
            <Text variant="micro" tone="onBrand" style={{ opacity: 0.8 }}>
              {fill(t.acrossGroups, { count: list.length })}
            </Text>
          </Row>

          <View>
            <Text
              tone="onBrand"
              tabular
              style={{ fontSize: 40, lineHeight: 46, fontWeight: '700' }}
            >
              {format(
                {
                  minor: summary.totals.net < 0n ? -summary.totals.net : summary.totals.net,
                  currency: 'INR',
                },
                { locale, compactFraction: true },
              )}
            </Text>
            <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
              {summary.totals.net === 0n
                ? t.allSettled
                : summary.totals.net > 0n
                  ? t.overallOwed
                  : t.overallOwe}
            </Text>
          </View>

          <Row style={{ gap: theme.spacing.xxl }}>
            <View>
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.75 }}>
                {t.youAreOwed}
              </Text>
              <Text variant="subheading" tone="onBrand" tabular>
                {format(
                  { minor: summary.totals.owed, currency: 'INR' },
                  { locale, compactFraction: true },
                )}
              </Text>
            </View>
            <View>
              <Text variant="micro" tone="onBrand" style={{ opacity: 0.75 }}>
                {t.youOwe}
              </Text>
              <Text variant="subheading" tone="onBrand" tabular>
                {format(
                  { minor: summary.totals.owing, currency: 'INR' },
                  { locale, compactFraction: true },
                )}
              </Text>
            </View>
          </Row>
        </Card>

        {loading ? (
          <Card>
            <Text variant="caption" tone="muted">
              Loading your groups…
            </Text>
          </Card>
        ) : list.length === 0 ? (
          <EmptyState
            title="No groups yet"
            body="Start one for a trip, a flat, or the two of you. Adding expenses is free and unlimited, forever."
            action={<Button label={t.newGroup} onPress={() => router.push('/new-group')} />}
          />
        ) : (
          <View>
            <SectionHeader
              title={t.yourGroups}
              action={
                <Text variant="caption" tone="brand" onPress={() => router.push('/new-group')}>
                  {t.newGroup}
                </Text>
              }
            />
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {list.map((group, index) => (
                <View key={group.id}>
                  <ListRow
                    title={group.name}
                    subtitle={`${summary.memberCountFor(group.id)} ${t.members}`}
                    leading={
                      <Avatar
                        name={group.name}
                        emoji={group.cover_emoji ?? undefined}
                        tint={tintForKey(group.id)}
                      />
                    }
                    onPress={() => router.push(`/group/${group.id}`)}
                    trailing={
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <MoneyText
                          amount={summary.balanceFor(group.id)}
                          currency={group.default_currency}
                          locale={locale}
                          mode="balance"
                        />
                        {summary.hasPending(group.id) ? (
                          <Badge label={t.pendingConfirmation} tone="brand" />
                        ) : null}
                      </View>
                    }
                  />
                  {index < list.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              ))}
            </Card>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
