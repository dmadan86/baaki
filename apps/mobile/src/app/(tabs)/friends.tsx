/**
 * Everybody you are not square with, across every group.
 *
 * Two things this screen refuses to do, because both would put a confident
 * wrong number in front of somebody:
 *
 * It never adds two currencies together. Somebody can owe you ₹500 and be owed
 * €20, and there is no honest single figure without a rate — so they appear as
 * two lines rather than one invented total (ADR-003).
 *
 * It never merges two ghosts with the same name. Nothing proves the Ravi in
 * your Goa group is the Ravi in your flat group, and merging two people's
 * debts is not something you can undo once it is done. Only people with an
 * account are followed across groups, because a profile id is proof.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { fetchPeopleBalances, type PersonBalanceRow } from '@/data/api';
import { PeopleSkeleton } from '@/components/Skeletons';
import { plural, useStrings } from '@/i18n';

export default function FriendsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();

  const people = useQuery({
    queryKey: ['people', 'balances'],
    queryFn: fetchPeopleBalances,
  });
  const rows = people.data ?? [];

  const owedToYou = rows.filter((row) => BigInt(row.net) > 0n);
  const youOwe = rows.filter((row) => BigInt(row.net) < 0n);

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
            refreshing={people.isFetching && !people.isLoading}
            onRefresh={() => void people.refetch()}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ justifyContent: 'space-between', paddingTop: theme.spacing.md }}>
          <Text variant="title">{t.friends}</Text>
          <Button
            label={t.tabs.fromContacts}
            variant="secondary"
            size="sm"
            icon={<Ionicons name="person-add-outline" size={16} color={theme.color.brand} />}
            onPress={() => router.push('/friends/contacts')}
          />
        </Row>

        {people.isLoading ? (
          <PeopleSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState title={t.tabs.allSquare} body={t.tabs.allSquareBody} />
        ) : (
          <>
            <FriendsSection
              title={t.tabs.owesYou}
              rows={owedToYou}
              locale={locale}
              emptyBody={t.tabs.nobodyOwesYou}
            />
            <FriendsSection
              title={t.tabs.youOweThem}
              rows={youOwe}
              locale={locale}
              emptyBody={t.tabs.youAreNotBehind}
            />

            <Text variant="micro" tone="faint" align="center">
              {t.extras.perCurrencyNote}
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function FriendsSection({
  title,
  rows,
  locale,
  emptyBody,
}: {
  title: string;
  rows: PersonBalanceRow[];
  locale: string;
  emptyBody: string;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader title={title} />
      {rows.length === 0 ? (
        <Card>
          <Text variant="caption" tone="muted">
            {emptyBody}
          </Text>
        </Card>
      ) : (
        rows.map((row) => (
          <FriendCard key={`${row.person_key}-${row.currency}`} row={row} locale={locale} t={t} />
        ))
      )}
    </View>
  );
}

function FriendCard({
  row,
  locale,
  t,
}: {
  row: PersonBalanceRow;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
}): React.JSX.Element {
  const theme = useTheme();
  // The card colour is the money colour, used for its one sanctioned meaning:
  // mint when they owe you, pink when you owe them. The section already sorts
  // by that, so the colour never disagrees with the number on it. Ink from the
  // same pair keeps the amount legible without breaking the semantic.
  const owed = BigInt(row.net) > 0n;
  const tint = owed ? 'mint' : 'pink';
  const ink = theme.tint[tint].ink;
  // Only linkable when there is a single group to link to; otherwise this
  // amount is a sum and no one group explains it.
  const onPress = row.only_group_id ? () => router.push(`/group/${row.only_group_id}`) : undefined;

  const body = (
    <TintCard tint={tint} style={{ borderRadius: theme.radius.lg, padding: theme.spacing.lg }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ flex: 1, gap: theme.spacing.md }}>
          <Avatar name={row.display_name} size={40} />
          <View style={{ flex: 1 }}>
            <Text variant="subheading" numberOfLines={1} style={{ color: ink }}>
              {row.display_name}
            </Text>
            <Text variant="caption" style={{ color: ink, opacity: 0.7 }}>
              {row.group_count === 1
                ? t.tabs.inOneGroup
                : plural(locale, row.group_count, t.tabs.acrossGroups)}
            </Text>
          </View>
        </Row>
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <MoneyText
            amount={BigInt(row.net)}
            currency={row.currency}
            locale={locale}
            variant="subheading"
            mode="balance"
            tone="default"
            style={{ color: ink }}
          />
          {row.is_ghost ? (
            // A ghost is somebody you added who has no Baaki account yet, so the
            // badge is the useful action rather than a verdict: send them this
            // group's invite link, which is the same link that lets them claim
            // this very row (A25). Only offered when a single group explains the
            // balance — otherwise there is no one link to share. Its own
            // Pressable so tapping it invites rather than opening the group.
            row.only_group_id ? (
              <Pressable
                onPress={() => router.push(`/group/${row.only_group_id}/invite`)}
                accessibilityRole="button"
                accessibilityLabel={t.people.invite}
                hitSlop={8}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
              >
                <Badge label={t.people.invite} tone="brand" />
              </Pressable>
            ) : (
              <Badge label={t.tabs.notJoined} />
            )
          ) : null}
        </View>
      </Row>
    </TintCard>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={row.display_name}
      style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
    >
      {body}
    </Pressable>
  );
}
