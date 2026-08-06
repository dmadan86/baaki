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

import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ListRow,
  MoneyText,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { fetchPeopleBalances, type PersonBalanceRow } from '@/data/api';
import { useStrings } from '@/i18n';

export default function FriendsScreen() {
  const theme = useTheme();
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
          paddingBottom: 170,
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
        <Text variant="title" style={{ paddingTop: theme.spacing.md }}>
          {t.friends}
        </Text>

        {rows.length === 0 ? (
          <EmptyState
            title="All square"
            body="Nobody owes you anything and you owe nobody. Friends you are settling up with will appear here."
          />
        ) : (
          <>
            <FriendsSection
              title="Owes you"
              rows={owedToYou}
              locale={locale}
              emptyBody="Nobody owes you anything right now."
            />
            <FriendsSection
              title="You owe"
              rows={youOwe}
              locale={locale}
              emptyBody="You are not behind with anyone."
            />

            <Text variant="micro" tone="faint" align="center">
              Amounts are kept per currency, never converted into one total. People without an
              account are counted per group, because two people can share a name.
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

  return (
    <View>
      <SectionHeader title={title} />
      {rows.length === 0 ? (
        <Card>
          <Text variant="caption" tone="muted">
            {emptyBody}
          </Text>
        </Card>
      ) : (
        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          {rows.map((row, index) => (
            <View key={`${row.person_key}-${row.currency}`}>
              <ListRow
                title={row.display_name}
                subtitle={
                  row.group_count === 1 ? 'in one group' : `across ${row.group_count} groups`
                }
                leading={<Avatar name={row.display_name} size={40} />}
                // Only linkable when there is a single group to link to;
                // otherwise this amount is a sum and no one group explains it.
                onPress={
                  row.only_group_id ? () => router.push(`/group/${row.only_group_id}`) : undefined
                }
                trailing={
                  <View style={{ alignItems: 'flex-end', gap: 2 }}>
                    <MoneyText
                      amount={BigInt(row.net)}
                      currency={row.currency}
                      locale={locale}
                      variant="subheading"
                      mode="balance"
                    />
                    {row.is_ghost ? <Badge label="Not joined" /> : null}
                  </View>
                }
              />
              {index < rows.length - 1 ? (
                <View style={{ height: 1, backgroundColor: theme.color.border }} />
              ) : null}
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}
