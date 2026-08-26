/**
 * One month of spending, day by day (the drill under the Spending chart).
 *
 * The insights screen answers "what did we spend, month by month". A column
 * there is a total with no way in — this is the way in: tap a month and land
 * on its days, tap an expense and land on the expense. Nothing new is summed
 * server-side; it reads the same local expenses the group page shows and slices
 * them to the month and currency the tapped column stood for.
 *
 * It honours the scope the chart was in. In "group" scope a row is the whole
 * expense; in "mine" scope it is this person's share of it, and expenses they
 * had no share in are not shown — so the day subtotals and the screen total add
 * back up to the column that was tapped, and never to a different number.
 */

import { useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import {
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  TintCard,
  tintForKey,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { memberLookup, useGroup } from '@/data/hooks';
import { expenseTitle } from '@/data/expenseTitle';
import { displayName, groupLabel, type ExpenseRow } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

/** Sum of this member's shares in a version, in minor units. */
function myShare(shares: { member_id: string; amount: string }[], memberId: string | null): bigint {
  if (!memberId) return 0n;
  return shares
    .filter((share) => share.member_id === memberId)
    .reduce((sum, share) => sum + BigInt(share.amount), 0n);
}

export default function SpendingMonthScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const params = useLocalSearchParams<{
    id: string;
    month: string;
    currency: string;
    scope: string;
  }>();
  const groupId = params.id ?? '';
  const month = (params.month ?? '').slice(0, 7); // 'YYYY-MM'
  const currency = params.currency ?? '';
  const mine = params.scope === 'mine';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
  );

  const lookup = memberLookup(members.data);
  const nameOf = (memberId: string | null): string => {
    const member = memberId ? lookup.get(memberId) : undefined;
    return member ? displayName(member, profile?.id) : t.misc.someone;
  };

  // The expenses that make up the tapped column: live, in this currency, in this
  // month, and — in "mine" scope — ones this person actually had a share in.
  // Paired with the amount the row should show, so the day maths never re-reads
  // the scope.
  const rows = useMemo(() => {
    const out: { expense: ExpenseRow; amount: bigint; day: string }[] = [];
    for (const expense of expenses.rows) {
      if (expense.deleted_at) continue;
      const version = expense.currentVersion;
      if (!version || version.currency !== currency) continue;
      if (version.expense_date.slice(0, 7) !== month) continue;
      const amount = mine ? myShare(version.shares, myMemberId) : BigInt(version.amount);
      if (mine && amount === 0n) continue;
      out.push({ expense, amount, day: version.expense_date.slice(0, 10) });
    }
    return out;
  }, [expenses.rows, currency, month, mine, myMemberId]);

  // Newest day first, and newest expense first within a day — a ledger reads
  // most-recent-down, same as the group page.
  const days = useMemo(() => {
    const byDay = new Map<string, { total: bigint; items: typeof rows }>();
    for (const row of rows) {
      const bucket = byDay.get(row.day) ?? { total: 0n, items: [] };
      bucket.total += row.amount;
      bucket.items.push(row);
      byDay.set(row.day, bucket);
    }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  const total = rows.reduce((sum, row) => sum + row.amount, 0n);

  const [year, monthNo] = month.split('-');
  const monthStart = new Date(Date.UTC(Number(year), Number(monthNo) - 1, 1));
  const monthTitle = Number.isNaN(monthStart.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(monthStart);

  // 'YYYY-MM-DD' read with the parts, in UTC, so a phone east of the line does
  // not label the 1st as the last of the month before.
  const dayLabel = (day: string): string => {
    const [y, m, d] = day.split('-');
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))));
  };

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
            <Text variant="heading">{monthTitle}</Text>
            <Text variant="micro" tone="muted">
              {`${mine ? t.extras.justMe : t.extras.theGroup} · ${groupLabel(
                group.data,
                members.data ?? [],
              )}`}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {expenses.isLoading ? (
          <View style={{ padding: theme.spacing.xl }}>
            <ActivityIndicator color={theme.color.brand} />
          </View>
        ) : rows.length === 0 ? (
          <EmptyState title={t.nothingYet} body={t.nothingToChart} />
        ) : (
          <>
            <TintCard
              tint={tintForKey(groupId)}
              style={{
                alignItems: 'center',
                gap: theme.spacing.xs,
                borderRadius: theme.radius.xl,
                padding: theme.spacing.xl,
              }}
            >
              <MoneyText amount={total} currency={currency} locale={locale} variant="display" />
              <Text variant="caption" tone="muted">
                {plural(locale, rows.length, t.importLedger.expenseCount)}
              </Text>
            </TintCard>

            {days.map(([day, bucket]) => (
              <View key={day} style={{ gap: theme.spacing.md }}>
                <Row
                  style={{ justifyContent: 'space-between', paddingHorizontal: theme.spacing.xs }}
                >
                  <Text variant="subheading">{dayLabel(day)}</Text>
                  <MoneyText
                    amount={bucket.total}
                    currency={currency}
                    locale={locale}
                    variant="caption"
                    tone="muted"
                  />
                </Row>

                <View>
                  {bucket.items.map(({ expense, amount }, index, arr) => {
                    const version = expense.currentVersion;
                    const payer = version?.payers[0]?.member_id ?? null;
                    const title = expenseTitle(
                      version?.description,
                      version?.category,
                      t,
                      version?.category_meta,
                    );
                    return (
                      <View key={expense.id}>
                        <Pressable
                          onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
                          accessibilityRole="button"
                          accessibilityLabel={title}
                          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                        >
                          <Row
                            style={{
                              gap: theme.spacing.md,
                              alignItems: 'center',
                              paddingVertical: theme.spacing.md,
                            }}
                          >
                            <CategoryBadge
                              category={version?.category}
                              meta={version?.category_meta}
                              description={version?.description}
                              size={40}
                            />
                            <View style={{ flex: 1 }}>
                              <Text variant="subheading" numberOfLines={1}>
                                {title}
                              </Text>
                              <Text variant="caption" tone="muted" numberOfLines={1}>
                                {fill(t.expense.paidByName, { name: nameOf(payer) })}
                              </Text>
                            </View>
                            <MoneyText
                              amount={amount}
                              currency={currency}
                              locale={locale}
                              tone="default"
                              style={{ fontWeight: '700' }}
                            />
                          </Row>
                        </Pressable>
                        {index < arr.length - 1 ? (
                          <View style={{ height: 1, backgroundColor: theme.color.border }} />
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </View>
            ))}

            {mine ? (
              <Text variant="micro" tone="muted" align="center">
                {t.extras.yourShareNote}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
