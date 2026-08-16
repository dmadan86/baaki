/**
 * One person, across every group you share with them.
 *
 * The Friends list rolls a person up into a single balance. When that person is
 * in more than one group the sum has no single group to open, so the row there
 * used to be a dead end. This is where it goes instead: the same person split
 * back out per group, each line a doorway into that group, with the per-currency
 * total restated at the top.
 *
 * It reads from `baaki_person_group_balances`, keyed on the same `person_key`
 * the list uses, so a real person, a merged ghost and a plain ghost all resolve
 * exactly as they do on the list — this only un-collapses the groups.
 */
import { useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import {
  Button,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { fetchPersonGroupBalances, type PersonGroupBalanceRow } from '@/data/api';
import { PeopleSkeleton } from '@/components/Skeletons';
import { useStrings } from '@/i18n';

/** A person's balance in one group: the group, and one net per currency in it. */
interface GroupBlock {
  groupId: string;
  groupName: string | null;
  coverEmoji: string | null;
  lines: PersonGroupBalanceRow[];
}

export default function PersonDetailScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { key, name } = useLocalSearchParams<{ key: string; name?: string }>();

  const person = useQuery({
    queryKey: ['person', key, 'groups'],
    queryFn: () => fetchPersonGroupBalances(key),
    enabled: Boolean(key),
  });

  const rows = useMemo(() => person.data ?? [], [person.data]);
  const title = name ?? rows[0]?.display_name ?? '';

  // One block per group (a group can carry two currencies), and the per-currency
  // total across all of them — the figure the Friends list showed, restated here
  // with the groups it was summed from underneath it.
  const { groups, totals } = useMemo(() => {
    const byGroup = new Map<string, GroupBlock>();
    const byCurrency = new Map<string, bigint>();
    for (const row of rows) {
      const block = byGroup.get(row.group_id) ?? {
        groupId: row.group_id,
        groupName: row.group_name,
        coverEmoji: row.cover_emoji,
        lines: [],
      };
      block.lines.push(row);
      byGroup.set(row.group_id, block);
      byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0n) + BigInt(row.net));
    }
    return { groups: [...byGroup.values()], totals: [...byCurrency.entries()] };
  }, [rows]);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading" numberOfLines={1}>
              {title}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {person.isLoading ? (
          <PeopleSkeleton />
        ) : person.isError ? (
          <EmptyState
            title={t.loadError}
            body={t.loadErrorBody}
            action={<Button label={t.retry} variant="secondary" onPress={() => person.refetch()} />}
          />
        ) : rows.length === 0 ? (
          // Nothing outstanding in any shared group — square, not broken.
          <EmptyState title={t.allSettled} body={t.tabs.allSquareBody} />
        ) : (
          <>
            {/* The totals first: the same per-currency figure the list showed,
                so this screen opens on the number the tap was chasing. */}
            <Card style={{ gap: theme.spacing.md }}>
              {totals.map(([currency, net]) => (
                <Row key={currency} style={{ justifyContent: 'space-between' }}>
                  <Text variant="subheading" tone="muted">
                    {net > 0n ? t.tabs.owesYou : t.tabs.youOweThem}
                  </Text>
                  <MoneyText
                    amount={net}
                    currency={currency}
                    locale={locale}
                    variant="heading"
                    mode="balance"
                  />
                </Row>
              ))}
            </Card>

            <View style={{ gap: theme.spacing.md }}>
              <SectionHeader
                title={
                  groups.length === 1
                    ? t.tabs.inOneGroup
                    : t.tabs.acrossGroups.other.replace('{n}', String(groups.length))
                }
              />
              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {groups.map((group, index) => (
                  <View key={group.groupId}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={group.groupName ?? undefined}
                      onPress={() => router.push(`/group/${group.groupId}`)}
                      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                    >
                      <Row style={{ paddingVertical: theme.spacing.md, alignItems: 'center' }}>
                        <View
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: theme.radius.pill,
                            backgroundColor: theme.color.surfaceMuted,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text style={{ fontSize: 22 }}>{group.coverEmoji ?? '👥'}</Text>
                        </View>
                        <Text
                          variant="subheading"
                          numberOfLines={1}
                          style={{ flex: 1, marginHorizontal: theme.spacing.md }}
                        >
                          {group.groupName ?? t.tabs.group}
                        </Text>
                        <View style={{ alignItems: 'flex-end', gap: 2 }}>
                          {group.lines.map((line) => (
                            <MoneyText
                              key={line.currency}
                              amount={BigInt(line.net)}
                              currency={line.currency}
                              locale={locale}
                              variant="subheading"
                              mode="balance"
                            />
                          ))}
                        </View>
                        <Ionicons
                          name={directionalIcon('chevron-forward')}
                          size={iconSize.md}
                          color={theme.color.textFaint}
                          style={{ marginLeft: theme.spacing.sm }}
                        />
                      </Row>
                    </Pressable>
                    {index < groups.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                ))}
              </Card>
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
