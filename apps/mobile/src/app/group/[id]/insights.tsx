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

import { format, resolveCategory, type CategoryId, type CategoryMeta } from '@waves/core';
import {
  BarList,
  Card,
  ChipRow,
  ColumnChart,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  type BarDatum,
  type ColumnDatum,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { InsightsSkeleton } from '@/components/Skeletons';
import type { SpendingRow } from '@/data/api';
import { computeSpendingRows } from '@/data/spending';
import { useGroup } from '@/data/hooks';
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
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);

  // Spending is a read of expenses the phone already mirrors, so it is computed
  // on the device (ADR-005) rather than fetched — the local-first twin of the
  // baaki_group_spending RPC, same rows, and it works with no connection.
  const spendingRows = useMemo(() => computeSpendingRows(expenses.rows), [expenses.rows]);

  const [scope, setScope] = useState<Scope>(Scope.Group);

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
  );

  // The group's own currency first; anything else follows it, so a single
  // foreign expense never becomes the headline.
  const groupCurrency = group.data?.default_currency ?? 'INR';

  const rows = useMemo(() => {
    if (scope === Scope.Mine) {
      return myMemberId ? spendingRows.filter((row) => row.member_id === myMemberId) : [];
    }
    return spendingRows;
  }, [spendingRows, scope, myMemberId]);

  const currencies = useMemo(() => {
    const seen = [...new Set(rows.map((row) => row.currency))];
    return seen.sort((a, b) =>
      a === groupCurrency ? -1 : b === groupCurrency ? 1 : a.localeCompare(b),
    );
  }, [rows, groupCurrency]);

  const loading = group.isLoading || members.isLoading || expenses.isLoading;

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
              totalCaption={t.totalIn}
              nothingCaption={t.nothingIn}
              tapHint={t.tapMonthForDays}
            />
          ))
        )}

        <Text variant="micro" tone="muted" align="center">
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
  totalCaption,
  nothingCaption,
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
  totalCaption: string;
  nothingCaption: string;
  tapHint: string;
}) {
  const theme = useTheme();

  const total = rows.reduce((sum, row) => sum + BigInt(row.share_amount), 0n);

  const categories: BarDatum[] = useMemo(() => {
    const totals = new Map<string, bigint>();
    // A custom tag's display travels on its rows; keep the first seen so its bar
    // shows the tag rather than folding into "Other".
    const metaByCategory = new Map<string, CategoryMeta | null>();
    for (const row of rows) {
      totals.set(row.category, (totals.get(row.category) ?? 0n) + BigInt(row.share_amount));
      if (!metaByCategory.has(row.category)) {
        metaByCategory.set(row.category, row.category_meta ?? null);
      }
    }
    return [...totals]
      .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] > a[1] ? 1 : -1))
      .map(([id, value]) => {
        const meta = metaByCategory.get(id) ?? null;
        const resolved = resolveCategory(id, meta);
        return {
          key: id,
          // A custom tag names itself; a built-in is named through the table.
          label: resolved.custom ? resolved.label : labels[resolved.builtinId ?? 'other'],
          value,
          formatted: format({ minor: value, currency }, { locale, compactFraction: true }),
          tint: resolved.tint,
          leading: <CategoryBadge category={id} meta={meta} size={26} />,
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
          {(rows.length === 0 ? nothingCaption : totalCaption).replace('{currency}', currency)}
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
          <Text variant="micro" tone="muted" align="center">
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
