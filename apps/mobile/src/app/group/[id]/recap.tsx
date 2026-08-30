/**
 * Trip recap: the trip, once it is done, in the numbers people repeat.
 *
 * A read of the ledger the phone already mirrors (ADR-005) — no fetch, works
 * offline. Currencies stay apart (ADR-004): a trip billed in rupees and baht
 * gets a card each, never a single total made up by a rate nobody agreed. The
 * per-member figures are the shares and payments the ledger stored; nothing is
 * re-divided here.
 */

import { useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { recap, resolveCategory, type RecapExpense } from '@waves/core';
import {
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { displayName } from '@/data/types';
import { useGroup } from '@/data/hooks';
import { useAuth } from '@/lib/auth';
import { InsightsSkeleton } from '@/components/Skeletons';
import { useStrings, fill } from '@/i18n';

export default function RecapScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const myProfileId = profile?.id ?? null;

  const nameOf = (memberId: string): string => {
    const member = (members.data ?? []).find((m) => m.id === memberId);
    return member ? displayName(member, myProfileId) : '—';
  };

  // category id → its display meta, so a custom tag names itself rather than
  // folding into "Other". Built once from the ledger.
  const metaByCategory = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveCategory>>();
    for (const expense of expenses.rows) {
      const version = expense.currentVersion;
      if (!version || expense.deleted_at || !version.category) continue;
      if (!map.has(version.category)) {
        map.set(version.category, resolveCategory(version.category, version.category_meta ?? null));
      }
    }
    return map;
  }, [expenses.rows]);

  const categoryLabel = (category: string): string => {
    const resolved = metaByCategory.get(category) ?? resolveCategory(category, null);
    if (resolved.custom) return resolved.label;
    return t.categories[resolved.builtinId ?? 'other'];
  };

  const recapData = useMemo(() => {
    const rows: RecapExpense[] = expenses.rows
      .filter((expense) => expense.currentVersion && !expense.deleted_at)
      .map((expense) => {
        const version = expense.currentVersion!;
        return {
          id: expense.id,
          date: version.expense_date.slice(0, 10),
          description: version.description,
          category: version.category,
          amountMinor: BigInt(version.amount),
          currency: version.currency,
          payers: version.payers.map((payer) => ({
            member: payer.member_id,
            amountMinor: BigInt(payer.amount),
          })),
        };
      });
    return recap({
      expenses: rows,
      startDate: group.data?.start_date?.slice(0, 10) ?? null,
      endDate: group.data?.end_date?.slice(0, 10) ?? null,
    });
  }, [expenses.rows, group.data?.start_date, group.data?.end_date]);

  const loading = group.isLoading || members.isLoading || expenses.isLoading;

  return (
    <Screen>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.tripInsights.recap}</Text>
          <Text variant="micro" tone="muted">
            {group.data?.name}
          </Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <InsightsSkeleton />
        ) : recapData.byCurrency.length === 0 ? (
          <EmptyState title={t.tripInsights.noneYet} body={t.tripInsights.recapSubtitle} />
        ) : (
          recapData.byCurrency.map((block) => (
            <View key={block.currency} style={{ gap: theme.spacing.md }}>
              <Card style={{ alignItems: 'center', gap: theme.spacing.xs }}>
                <MoneyText
                  amount={block.totalMinor}
                  currency={block.currency}
                  locale={locale}
                  variant="display"
                />
                <Text variant="caption" tone="muted">
                  {fill(t.tripInsights.expenseCount, { n: String(block.expenseCount) })}
                </Text>
              </Card>

              <Card style={{ gap: theme.spacing.md }}>
                <RecapRow
                  label={t.tripInsights.perDay}
                  value={
                    <MoneyText
                      amount={block.dailyAverageMinor}
                      currency={block.currency}
                      locale={locale}
                      variant="body"
                      mode="plain"
                    />
                  }
                />
                {block.biggestExpense ? (
                  <RecapRow
                    label={t.tripInsights.biggestBill}
                    detail={block.biggestExpense.description}
                    value={
                      <MoneyText
                        amount={block.biggestExpense.amountMinor}
                        currency={block.currency}
                        locale={locale}
                        variant="body"
                        mode="plain"
                      />
                    }
                  />
                ) : null}
                {block.topCategory ? (
                  <RecapRow
                    label={t.tripInsights.mostSpentOn}
                    detail={categoryLabel(block.topCategory.category)}
                    value={
                      <MoneyText
                        amount={block.topCategory.totalMinor}
                        currency={block.currency}
                        locale={locale}
                        variant="body"
                        mode="plain"
                      />
                    }
                  />
                ) : null}
                {block.topPayer ? (
                  <RecapRow
                    label={t.tripInsights.paidMost}
                    detail={nameOf(block.topPayer.member)}
                    value={
                      <MoneyText
                        amount={block.topPayer.paidMinor}
                        currency={block.currency}
                        locale={locale}
                        variant="body"
                        mode="plain"
                      />
                    }
                  />
                ) : null}
              </Card>
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

function RecapRow({
  label,
  detail,
  value,
}: {
  label: string;
  detail?: string;
  value: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing.md }}>
      <View style={{ flex: 1 }}>
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value}
    </Row>
  );
}
