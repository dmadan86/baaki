/**
 * The "Me" tab — the private personal-finance ledger (A48).
 *
 * A person's own money, nothing shared. The screen leads with a month card that
 * wears its verdict — a blue wash when you saved, a red one when you overspent —
 * with income and spend read out beneath a thin spend-against-income bar. Then
 * two quick-add tiles, the three management areas (recurring, loans, budgets)
 * each surfacing its live number, and the recent entries grouped by day the way
 * a bank statement reads. Everything is local-first from the mirror and every
 * figure is computed on the device.
 *
 * Opening the tab also posts any auto-recurring entries that have come due since
 * it was last open (idempotent — see `postDueRecurring`).
 */

import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import {
  format,
  isRecurringDue,
  loanOutstanding,
  money,
  monthlySummary,
  personalBudgetProgress,
  type PersonalTxn,
} from '@waves/core';
import {
  Card,
  Divider,
  Gradient,
  iconSize,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import {
  localIsoDate,
  postDueRecurring,
  todayIso,
  usePersonalLedger,
  useUpsertPersonalRecord,
} from '@/data/personal';
import { useDefaultCurrency } from '@/lib/currency';
import { useSync } from '@/sync';
import { useStrings } from '@/i18n';

export default function MeScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const dc = useDefaultCurrency();
  const { hydrated } = useSync();
  const ledger = usePersonalLedger();
  const upsert = useUpsertPersonalRecord();

  // Read the clock once, off render (the React Compiler forbids it inline).
  const [today] = useState(() => todayIso());
  const month = today.slice(0, 7);

  // Post due auto-recurring entries once the mirror has hydrated from disk and
  // there are recurring rules to act on. Gating on `hydrated` (not the raw mount)
  // means we never latch against a still-loading, empty ledger; gating on
  // local hydration — not a network round-trip — keeps it working offline, which
  // is the whole point of the local-first ledger. `posted` is set only after the
  // catch-up resolves and cleared on failure, so a transient write error can
  // retry on a later run rather than being swallowed for the session. Even a
  // double-fire is harmless: occurrence ids are deterministic
  // (recurringOccurrenceId), so a repeat upserts the same rows, never a dupe.
  const posted = useRef(false);
  const ready = hydrated && ledger.recurrings.length > 0;
  useEffect(() => {
    if (posted.current || !ready) return;
    posted.current = true;
    postDueRecurring(ledger, today, (input) => upsert.mutateAsync(input)).catch(() => {
      posted.current = false;
    });
    // Keyed on readiness only; `ledger`/`today`/`upsert` are read at fire time
    // and the ref makes it one-shot per successful run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const summary = monthlySummary(ledger.txns, month, dc);
  const recent = ledger.txns.slice(0, 8);
  const days = groupByDay(recent, today, dc, t);

  const dueCount = ledger.recurrings.filter((rule) => isRecurringDue(rule, today)).length;
  const activeLoans = ledger.loans.filter((loan) => loan.status === 'active');
  const overBudgets = ledger.budgets.filter(
    (budget) => personalBudgetProgress(budget, ledger.txns, month).remaining < 0n,
  ).length;
  const outstanding = activeLoans
    .filter((loan) => loan.currency === dc)
    .reduce((sum, loan) => sum + loanOutstanding(loan, ledger.txns), 0n);

  const fmt = (amount: bigint): string =>
    format(money(amount, dc), { locale, compactFraction: true });

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
        <View style={{ paddingTop: theme.spacing.md, gap: 2 }}>
          <Text variant="title">{t.personal.title}</Text>
          <Text variant="caption" tone="muted">
            {t.personal.subtitle}
          </Text>
        </View>

        {/* The month, wearing its verdict: blue when you saved, red when you
            overspent. The net is the headline; income and spend sit under a bar
            that fills with the share of income spent. All white ink. */}
        <MonthHero
          net={summary.net}
          income={summary.income}
          expense={summary.expense}
          currency={dc}
          locale={locale}
          t={t}
        />

        <Row style={{ gap: theme.spacing.md }}>
          <QuickAdd
            label={t.personal.addExpense}
            icon="remove-circle-outline"
            tint={theme.color.negative}
            onPress={() =>
              router.push({ pathname: '/personal/entry', params: { kind: 'expense' } })
            }
          />
          <QuickAdd
            label={t.personal.addIncome}
            icon="add-circle-outline"
            tint={theme.color.positive}
            onPress={() => router.push({ pathname: '/personal/entry', params: { kind: 'income' } })}
          />
        </Row>

        {/* The three management areas, each showing its live number. */}
        <View style={{ gap: theme.spacing.md }}>
          <SectionLink
            label={t.personal.recurring}
            icon="repeat"
            value={dueCount > 0 ? String(dueCount) : undefined}
            valueTone="brand"
            hint={dueCount > 0 ? t.personal.due : t.personal.recurringSub}
            onPress={() => router.push('/personal/recurring')}
          />
          <SectionLink
            label={t.personal.loans}
            icon="cash-outline"
            value={activeLoans.length > 0 ? fmt(outstanding) : undefined}
            valueTone="text"
            hint={activeLoans.length > 0 ? t.personal.outstanding : t.personal.loansSub}
            onPress={() => router.push('/personal/loans')}
          />
          <SectionLink
            label={t.personal.budgets}
            icon="pie-chart-outline"
            value={overBudgets > 0 ? String(overBudgets) : undefined}
            valueTone="negative"
            hint={overBudgets > 0 ? t.personal.over : t.personal.budgetsSub}
            onPress={() => router.push('/personal/budgets')}
          />
        </View>

        {/* Recent entries, grouped by day like a statement. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
              {t.personal.recent.toUpperCase()}
            </Text>
            {ledger.txns.length > recent.length ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/personal/transactions')}
              >
                <Text variant="caption" tone="brand">
                  {t.personal.seeAll}
                </Text>
              </Pressable>
            ) : null}
          </Row>

          {recent.length === 0 ? (
            <Card>
              <Text tone="muted" align="center">
                {t.personal.empty}
              </Text>
            </Card>
          ) : (
            days.map((day) => (
              <View key={day.key} style={{ gap: theme.spacing.xs }}>
                {/* Day header: the label on one side, the day's net on the
                    other — the statement's running story. */}
                <Row
                  style={{
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    paddingTop: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.xs,
                  }}
                >
                  <Text variant="micro" tone="muted" style={{ fontWeight: '600' }}>
                    {day.label}
                  </Text>
                  {day.hasNet ? (
                    <Text variant="micro" tone={day.net < 0n ? 'negative' : 'muted'}>
                      {day.net < 0n ? '−' : day.net > 0n ? '+' : ''}
                      {fmt(day.net < 0n ? -day.net : day.net)}
                    </Text>
                  ) : null}
                </Row>
                <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                  {day.txns.map((txn, index) => (
                    <View key={txn.id}>
                      {index > 0 ? <Divider /> : null}
                      <TxnRow
                        txn={txn}
                        locale={locale}
                        theme={theme}
                        labelFor={labelForCategory(t)}
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

interface Day {
  readonly key: string;
  readonly label: string;
  /** Net (income minus spend) of this day's entries in the default currency —
   *  minor units. `hasNet` is false when the day has no entry in that currency,
   *  in which case there is no single figure to show. */
  readonly net: bigint;
  readonly hasNet: boolean;
  readonly txns: readonly PersonalTxn[];
}

// Group already-newest-first txns into contiguous days, each carrying its net.
// The label is Today / Yesterday for the two most recent calendar days,
// otherwise the date as stored. The day net sums only entries in the default
// currency `dc` — money in two currencies does not add, so a mixed day shows
// its rows (each in its own currency) but no single net.
function groupByDay(
  txns: readonly PersonalTxn[],
  today: string,
  dc: string,
  t: ReturnType<typeof useStrings>['t'],
): Day[] {
  // One calendar day back, not 86,400,000 ms — a day is not always that many
  // milliseconds across a DST change.
  const y = new Date(`${today}T00:00:00`);
  y.setDate(y.getDate() - 1);
  const yesterday = localIsoDate(y);
  const labelFor = (date: string): string =>
    date === today ? t.personal.today : date === yesterday ? t.personal.yesterday : date;

  const days: { date: string; txns: PersonalTxn[] }[] = [];
  for (const txn of txns) {
    const last = days[days.length - 1];
    if (last && last.date === txn.date) last.txns.push(txn);
    else days.push({ date: txn.date, txns: [txn] });
  }
  return days.map((day) => {
    const inDc = day.txns.filter((txn) => txn.currency === dc);
    return {
      key: day.date,
      label: labelFor(day.date),
      net: inDc.reduce((sum, txn) => sum + (txn.kind === 'income' ? txn.amount : -txn.amount), 0n),
      hasNet: inDc.length > 0,
      txns: day.txns,
    };
  });
}

// The translated label for a category id (built-in key or custom tag id). Custom
// tags fall back to their own stored label via the badge; here we only need the
// built-in names, so an unknown id returns null and the row shows its note.
function labelForCategory(t: ReturnType<typeof useStrings>['t']) {
  return (id: string | null): string | null =>
    id ? (t.categories[id as keyof typeof t.categories] ?? null) : null;
}

function MonthHero({
  net,
  income,
  expense,
  currency,
  locale,
  t,
}: {
  net: bigint;
  income: bigint;
  expense: bigint;
  currency: string;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
}) {
  const theme = useTheme();
  const saved = net >= 0n;
  const fmt = (amount: bigint): string =>
    format(money(amount, currency), { locale, compactFraction: true });

  // The share of income spent, for the bar. No income yet but money spent reads
  // as fully spent; nothing either way reads as empty.
  const ratio =
    income > 0n ? Math.min(1, Number((expense * 1000n) / income) / 1000) : expense > 0n ? 1 : 0;

  return (
    <Gradient colors={saved ? theme.gradient.positive : theme.gradient.negative}>
      <View style={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="micro" tone="onBrand" style={{ letterSpacing: 0.8, opacity: 0.85 }}>
            {t.personal.thisMonth.toUpperCase()}
          </Text>
          <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }}>
            {saved ? t.personal.saved : t.personal.overspent}
          </Text>
        </Row>

        <Text variant="display" tone="onBrand" numberOfLines={1} adjustsFontSizeToFit>
          {net < 0n ? '−' : ''}
          {fmt(net < 0n ? -net : net)}
        </Text>

        {/* Spend against income. A translucent track with a white fill; over the
            whole width when everything (or more) is spent. */}
        <View
          style={{
            height: 6,
            borderRadius: 3,
            backgroundColor: 'rgba(255,255,255,0.25)',
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.round(ratio * 100)}%`,
              height: 6,
              backgroundColor: theme.color.onBrand,
            }}
          />
        </View>

        <Row style={{ justifyContent: 'space-between' }}>
          <HeroFigure label={t.personal.income} value={fmt(income)} icon="arrow-down" />
          <HeroFigure label={t.personal.expenses} value={fmt(expense)} icon="arrow-up" alignEnd />
        </Row>
      </View>
    </Gradient>
  );
}

function HeroFigure({
  label,
  value,
  icon,
  alignEnd,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
  alignEnd?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4, alignItems: alignEnd ? 'flex-end' : 'flex-start' }}>
      <Row style={{ alignItems: 'center', gap: 4 }}>
        <Ionicons name={icon} size={iconSize.xs} color={theme.color.onBrand} />
        <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }}>
          {label}
        </Text>
      </Row>
      <Text variant="body" tone="onBrand" style={{ fontWeight: '700' }}>
        {value}
      </Text>
    </View>
  );
}

function QuickAdd({
  label,
  icon,
  tint,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.sm,
        paddingVertical: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.color.surface,
        borderWidth: 1,
        borderColor: theme.color.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.md} color={tint} />
      <Text variant="caption" style={{ fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function SectionLink({
  label,
  icon,
  value,
  valueTone,
  hint,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  value?: string;
  valueTone: 'brand' | 'text' | 'negative';
  hint: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const valueColor =
    valueTone === 'brand'
      ? theme.color.brand
      : valueTone === 'negative'
        ? theme.color.negative
        : theme.color.text;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      <Card>
        <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.brandSoft,
            }}
          >
            <Ionicons name={icon} size={iconSize.md} color={theme.color.brand} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="body" style={{ fontWeight: '600' }}>
              {label}
            </Text>
            <Text variant="caption" tone="muted">
              {hint}
            </Text>
          </View>
          {value !== undefined ? (
            <Text variant="body" style={{ fontWeight: '700', color: valueColor }}>
              {value}
            </Text>
          ) : null}
          <Ionicons name="chevron-forward" size={iconSize.md} color={theme.color.textFaint} />
        </Row>
      </Card>
    </Pressable>
  );
}

function TxnRow({
  txn,
  locale,
  theme,
  labelFor,
}: {
  txn: PersonalTxn;
  locale: string;
  theme: ReturnType<typeof useTheme>;
  labelFor: (id: string | null) => string | null;
}) {
  const income = txn.kind === 'income';
  const title = txn.note?.trim() || labelFor(txn.category) || '—';
  const amount = format(money(txn.amount, txn.currency), { locale, compactFraction: true });
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/personal/entry', params: { id: txn.id } })}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      <CategoryBadge category={txn.category ?? 'other'} meta={null} size={32} />
      <View style={{ flex: 1 }}>
        <Text variant="body" numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Text
        variant="body"
        style={{ fontWeight: '700', color: income ? theme.color.positive : theme.color.text }}
      >
        {income ? '+' : '−'}
        {amount}
      </Text>
    </Pressable>
  );
}
