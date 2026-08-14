/**
 * Where the money went (M5, TDR §8).
 *
 * Free and basic on purpose (ADR-011): what each category cost, month by
 * month, for the whole group or for you. Nothing here is a balance and nothing
 * here is settled from — it answers "what are we spending on", which is a
 * different question from "what do I owe" and deserves its own screen rather
 * than another number on the group page.
 *
 * Two things it refuses to do, both inherited from the ledger:
 *
 * It never converts between currencies. An expense in euros and one in rupees
 * are two totals, drawn separately, because there is no honest single figure
 * without a rate somebody chose (ADR-003).
 *
 * It never re-divides an expense. The per-member figures are the shares the
 * ledger stored, odd paisa and all — dividing again here would put a number on
 * screen that no row in the database agrees with.
 */

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { categoryOf, format, type CategoryId } from '@baaki/core';
import {
  type BarDatum,
  BarList,
  Callout,
  Card,
  ChipRow,
  ColumnChart,
  type ColumnDatum,
  directionalIcon,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { CategoryBadge } from '@/components/Category';
import { InsightsSkeleton } from '@/components/Skeletons';
import type { SpendingRow } from '@/data/api';
import { useGroup, useGroupSpending } from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

enum Scope {
  Group = 'group',
  Mine = 'mine',
}

/** How many months of columns fit on a phone without becoming a smear. */
const MONTHS_SHOWN = 6;

export default function InsightsScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const spending = useGroupSpending(groupId);

  const [scope, setScope] = useState<Scope>(Scope.Group);

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
  );

  // The group's own currency first; anything else follows it, so a single
  // foreign expense never becomes the headline.
  const groupCurrency = group.data?.default_currency ?? 'INR';

  const rows = useMemo(() => {
    const all = spending.data ?? [];
    if (scope === Scope.Mine) {
      return myMemberId ? all.filter((row) => row.member_id === myMemberId) : [];
    }
    return all;
  }, [spending.data, scope, myMemberId]);

  const currencies = useMemo(() => {
    const seen = [...new Set(rows.map((row) => row.currency))];
    return seen.sort((a, b) =>
      a === groupCurrency ? -1 : b === groupCurrency ? 1 : a.localeCompare(b),
    );
  }, [rows, groupCurrency]);

  const loading = group.isLoading || members.isLoading || spending.isLoading;

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
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.spending}</Text>
            <Text variant="micro" tone="muted">
              {group.data?.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <ChipRow<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: Scope.Group, label: t.extras.theGroup },
            { value: Scope.Mine, label: t.extras.justMe },
          ]}
        />

        {loading ? (
          <InsightsSkeleton />
        ) : currencies.length === 0 ? (
          <EmptyState title={t.nothingYet} body={t.nothingToChart} />
        ) : (
          currencies.map((currency) => (
            <CurrencySection
              key={currency}
              groupId={groupId}
              scope={scope}
              currency={currency}
              locale={locale}
              rows={rows.filter((row) => row.currency === currency)}
              labels={t.categories}
              byCategoryTitle={t.byCategory}
              byMonthTitle={t.byMonth}
              tapHint={t.tapMonthForDays}
            />
          ))
        )}

        {spending.error ? (
          <Callout tone="negative">
            {spending.error instanceof Error ? spending.error.message : String(spending.error)}
          </Callout>
        ) : null}

        <Text variant="micro" tone="faint" align="center">
          {t.misc.insightsLiveNote}
        </Text>
      </ScrollView>
    </Screen>
  );
}

function CurrencySection({
  groupId,
  scope,
  currency,
  locale,
  rows,
  labels,
  byCategoryTitle,
  byMonthTitle,
  tapHint,
}: {
  groupId: string;
  scope: Scope;
  currency: string;
  locale: string;
  rows: SpendingRow[];
  labels: Record<CategoryId, string>;
  byCategoryTitle: string;
  byMonthTitle: string;
  tapHint: string;
}) {
  const theme = useTheme();

  const total = rows.reduce((sum, row) => sum + BigInt(row.share_amount), 0n);

  const categories: BarDatum[] = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      totals.set(row.category, (totals.get(row.category) ?? 0n) + BigInt(row.share_amount));
    }
    return [...totals]
      .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] > a[1] ? 1 : -1))
      .map(([id, value]) => {
        const category = categoryOf(id);
        return {
          key: id,
          label: labels[category.id],
          value,
          formatted: format({ minor: value, currency }, { locale, compactFraction: true }),
          tint: category.tint,
          leading: <CategoryBadge category={id} size={26} />,
        };
      });
  }, [rows, labels, locale, currency]);

  const months: ColumnDatum[] = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      totals.set(row.month, (totals.get(row.month) ?? 0n) + BigInt(row.share_amount));
    }
    return [...totals]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-MONTHS_SHOWN)
      .map(([month, value]) => ({
        key: month,
        // The month is a plain 'YYYY-MM-DD' from Postgres. Reading it with
        // `new Date(...)` would apply the phone's timezone and, east of UTC,
        // label January as December.
        label: monthLabel(month, locale),
        value,
        formatted: format({ minor: value, currency }, { locale, compactFraction: true }),
      }));
  }, [rows, locale, currency]);

  return (
    <View style={{ gap: theme.spacing.lg }}>
      <Card style={{ alignItems: 'center', gap: theme.spacing.xs }}>
        <MoneyText amount={total} currency={currency} locale={locale} variant="display" />
        <Text variant="caption" tone="muted">
          {`${rows.length === 0 ? 'nothing' : 'total'} in ${currency}`}
        </Text>
      </Card>

      <View style={{ gap: theme.spacing.md }}>
        <SectionHeader title={byCategoryTitle} />
        <Card>
          <BarList
            data={categories}
            accessibilityLabelFor={(datum) => `${datum.label}, ${datum.formatted}`}
          />
        </Card>
      </View>

      <View style={{ gap: theme.spacing.md }}>
        <SectionHeader title={byMonthTitle} />
        <Card style={{ gap: theme.spacing.md }}>
          <ColumnChart
            data={months}
            onSelect={(month) =>
              router.push(
                `/group/${groupId}/month?month=${month}&currency=${currency}&scope=${scope}`,
              )
            }
          />
          <Text variant="micro" tone="faint" align="center">
            {tapHint}
          </Text>
        </Card>
      </View>
    </View>
  );
}

/** 'Mar' from '2026-03-01', without letting a timezone move it. */
function monthLabel(month: string, locale: string): string {
  const [year, monthNumber] = month.split('-');
  const date = new Date(Date.UTC(Number(year), Number(monthNumber) - 1, 1));
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date);
}
