/**
 * The "Me" tab — the private personal-finance ledger (A48).
 *
 * A person's own money, nothing shared: this month's income, spend and net at
 * the top; quick ways to add an expense or income; the last few entries; and the
 * doors to the recurring rules, loans and budgets. Everything is read local-first
 * from the mirror and every figure is computed on the device.
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
  iconSize,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import {
  postDueRecurring,
  todayIso,
  usePersonalLedger,
  useUpsertPersonalRecord,
} from '@/data/personal';
import { useDefaultCurrency } from '@/lib/currency';
import { useStrings } from '@/i18n';

export default function MeScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const dc = useDefaultCurrency();
  const ledger = usePersonalLedger();
  const upsert = useUpsertPersonalRecord();

  // Read the clock once, off render (the React Compiler forbids it inline).
  const [today] = useState(() => todayIso());
  const month = today.slice(0, 7);

  // Post due auto-recurring entries when the ledger first has any recurring
  // rules to act on. Waiting for that readiness (rather than firing on the raw
  // mount) means a screen that mounts before the mirror hydrates still posts
  // once the rules arrive. It runs at most once per session, and even if it ran
  // early against a partial ledger the occurrence ids are deterministic
  // (recurringOccurrenceId), so a later real run upserts the same rows — never a
  // duplicate.
  const posted = useRef(false);
  const hasRules = ledger.recurrings.length > 0;
  useEffect(() => {
    if (posted.current || !hasRules) return;
    posted.current = true;
    void postDueRecurring(ledger, today, (input) => upsert.mutateAsync(input));
    // Intentionally keyed on readiness only; `ledger`/`today`/`upsert` are read
    // at fire time and the ref makes it one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRules]);

  const summary = monthlySummary(ledger.txns, month, dc);
  const recent = ledger.txns.slice(0, 6);

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

        {/* This month: income, spend, net — the headline of the ledger. */}
        <Card style={{ gap: theme.spacing.lg }}>
          <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
            {t.personal.thisMonth.toUpperCase()}
          </Text>
          <Row style={{ justifyContent: 'space-between' }}>
            <Metric label={t.personal.income} value={fmt(summary.income)} tone="positive" />
            <Metric label={t.personal.expenses} value={fmt(summary.expense)} tone="text" />
            <Metric
              label={t.personal.net}
              value={`${summary.net < 0n ? '−' : ''}${fmt(summary.net < 0n ? -summary.net : summary.net)}`}
              tone={summary.net < 0n ? 'negative' : 'positive'}
            />
          </Row>
        </Card>

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

        {/* Recent entries. */}
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
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {recent.map((txn, index) => (
                <View key={txn.id}>
                  {index > 0 ? <Divider /> : null}
                  <TxnRow txn={txn} locale={locale} theme={theme} labelFor={labelForCategory(t)} />
                </View>
              ))}
            </Card>
          )}
        </View>

        {/* The three management areas. */}
        <View style={{ gap: theme.spacing.md }}>
          <SectionLink
            label={t.personal.recurring}
            icon="repeat"
            hint={dueCount > 0 ? `${dueCount} ${t.personal.due}` : t.personal.recurringSub}
            emphasise={dueCount > 0}
            onPress={() => router.push('/personal/recurring')}
          />
          <SectionLink
            label={t.personal.loans}
            icon="cash-outline"
            hint={
              activeLoans.length > 0
                ? `${t.personal.outstanding} ${fmt(outstanding)}`
                : t.personal.loansSub
            }
            onPress={() => router.push('/personal/loans')}
          />
          <SectionLink
            label={t.personal.budgets}
            icon="pie-chart-outline"
            hint={overBudgets > 0 ? `${overBudgets} ${t.personal.over}` : t.personal.budgetsSub}
            emphasise={overBudgets > 0}
            onPress={() => router.push('/personal/budgets')}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

// The translated label for a category id (built-in key or custom tag id). Custom
// tags fall back to their own stored label via the badge; here we only need the
// built-in names, so an unknown id returns null and the row shows its note.
function labelForCategory(t: ReturnType<typeof useStrings>['t']) {
  return (id: string | null): string | null =>
    id ? (t.categories[id as keyof typeof t.categories] ?? null) : null;
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'positive' | 'negative' | 'text';
}) {
  const theme = useTheme();
  const color =
    tone === 'positive'
      ? theme.color.positive
      : tone === 'negative'
        ? theme.color.negative
        : theme.color.text;
  return (
    <View style={{ gap: 4 }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="heading" style={{ color }}>
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
  hint,
  emphasise,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  hint: string;
  emphasise?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
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
            <Text variant="caption" tone={emphasise ? 'brand' : 'muted'}>
              {hint}
            </Text>
          </View>
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
        <Text variant="micro" tone="muted">
          {txn.date}
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
