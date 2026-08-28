/**
 * The "Me" tab — the private personal-finance ledger (A48).
 *
 * A person's own money, nothing shared. It wears the same clothes as the
 * dashboard: an edge-to-edge saturated hero that runs up under the status bar,
 * a swipeable deck of figures inside it (this month's net, what you spent, the
 * share you kept), the add actions on the hero itself, and a dot pager for the
 * swipe. A month switcher in the hero header steps back through past months so
 * the ledger is a record you can browse, not just a snapshot of today.
 *
 * Below the hero, the white body: three stat tiles for the management areas
 * (recurring, loans, budgets) and the month's entries grouped by day the way a
 * bank statement reads. Everything is local-first from the mirror and every
 * figure is computed on the device.
 *
 * Opening the tab also posts any auto-recurring entries that have come due since
 * it was last open (idempotent — see `postDueRecurring`).
 */

import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  cashflowTrend,
  categoryBreakdown,
  dayDelta,
  format,
  isRecurringDue,
  loanOutstanding,
  money,
  monthlySummary,
  nextRecurring,
  personalBudgetProgress,
  recentMonths,
  resolveCategory,
  savingsRate,
  worstOverBudget,
  type MonthCashflow,
  type PersonalTxn,
} from '@waves/core';
import {
  BarList,
  Card,
  directionalIcon,
  Divider,
  Gradient,
  iconSize,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
  type BarDatum,
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

// One saturated wash per hero slide (net, spent, savings), dark corner to light,
// each deep enough to hold white ink on every corner like a bank card. The net
// slide's wash is swapped for its verdict at render — blue when you saved, red
// when you overspent — so the hero opens on the colour of how the month went.
const SAVED_WASH = ['#1E5A8C', '#0C2E4A'] as const; // blue — money kept
const OVERSPENT_WASH = ['#8C1D3F', '#4A0F20'] as const; // red — money lost
const SPENT_WASH = ['#463F86', '#221C46'] as const; // indigo — what went out
const SAVINGS_WASH = ['#12667A', '#06323D'] as const; // teal — the rate you kept

// One faint watermark glyph per slide, in the same order, bled off the corner
// and crossfading on the same scroll value as the wash.
const SLIDE_ICONS = ['wallet-outline', 'card-outline', 'trending-up-outline'] as const;

const HERO_CONTROL_BG = 'rgba(255, 255, 255, 0.16)';

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
  const currentMonth = today.slice(0, 7);

  // Which month the hero and the list are showing. 0 is the current month; each
  // step back subtracts a month. You cannot step past the current month, nor
  // back before the first month you have any entry in — wandering into unbounded
  // empty past months is not browsing a record. The ledger comes newest-first,
  // so the last txn's month is the earliest represented.
  const [monthsBack, setMonthsBack] = useState(0);
  const earliestMonth =
    ledger.txns.length > 0 ? ledger.txns[ledger.txns.length - 1]!.date.slice(0, 7) : currentMonth;
  const maxBack = Math.max(0, monthsBetween(earliestMonth, currentMonth));
  const month = monthsBack === 0 ? currentMonth : shiftMonth(currentMonth, -monthsBack);

  // Post due auto-recurring entries once the mirror has hydrated from disk and
  // there are recurring rules to act on. Gating on `hydrated` (not the raw mount)
  // means we never latch against a still-loading, empty ledger; gating on
  // local hydration — not a network round-trip — keeps it working offline, which
  // is the whole point of the local-first ledger. `posted` is set only after the
  // catch-up resolves and cleared on failure, so a transient write error can
  // retry on a later run rather than being swallowed for the session. Even a
  // double-fire is harmless: occurrence ids are deterministic
  // (recurringOccurrenceId), so a repeat upserts the same rows, never a dupe.
  // Always keyed on `today`, never the browsed month.
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
  const rate = savingsRate(summary.income, summary.expense);

  // The list follows the hero's month: the entries made in it, grouped by day.
  const monthTxns = ledger.txns.filter((txn) => txn.date.slice(0, 7) === month);
  const days = groupByDay(monthTxns, today, dc, t);

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

  // Where the month's money went — the biggest categories, each with its share,
  // capped so the list stays a glance rather than a scroll. Personal txns carry
  // no category-meta snapshot, so unknown/custom-tag ids all resolve to the same
  // built-in "Other"; fold them into one bucket (summing spend and share) BEFORE
  // sorting and slicing, or several look-alike "Other" rows would crowd real
  // categories out of the top six.
  const catLabel = labelForCategory(t);
  const buckets = new Map<string, { spent: bigint; share: number }>();
  for (const row of categoryBreakdown(ledger.txns, month, dc)) {
    const key = resolveCategory(row.category, null).builtinId ?? 'other';
    const prev = buckets.get(key);
    buckets.set(key, {
      spent: (prev?.spent ?? 0n) + row.spent,
      share: (prev?.share ?? 0) + row.share,
    });
  }
  const breakdownBars: BarDatum[] = [...buckets]
    .sort((a, b) =>
      b[1].spent === a[1].spent ? (a[0] < b[0] ? -1 : 1) : b[1].spent > a[1].spent ? 1 : -1,
    )
    .slice(0, 6)
    .map(([key, agg]) => ({
      key,
      label: catLabel(key) ?? t.categories.other,
      value: agg.spent,
      formatted: `${fmt(agg.spent)} · ${Math.round(agg.share * 100)}%`,
      tint: resolveCategory(key, null).tint,
      leading: <CategoryBadge category={key} meta={null} size={26} />,
    }));

  // The soonest upcoming recurring item, previewed by name and when.
  const upcoming = nextRecurring(ledger.recurrings, today);
  const upcomingName = upcoming
    ? upcoming.rule.note?.trim() || catLabel(upcoming.rule.category) || t.personal.recurring
    : '';
  const upcomingWhen = upcoming
    ? whenLabel(dayDelta(today, upcoming.date), upcoming.date, locale, t)
    : '';

  // The single worst over-budget category, named — more useful than the count.
  const worstOver = worstOverBudget(ledger.budgets, ledger.txns, month, dc);
  const overName = worstOver
    ? worstOver.budget.category
      ? (catLabel(worstOver.budget.category) ?? t.categories.other)
      : t.personal.overall
    : '';

  // The last three months of cash flow, ending on the browsed month. Hidden
  // until there is something in the window to draw.
  const trend = cashflowTrend(ledger.txns, recentMonths(month, 3), dc);
  const trendActive = trend.some((m) => m.income > 0n || m.expense > 0n);

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: clearance }}
        showsVerticalScrollIndicator={false}
      >
        <MeHero
          net={summary.net}
          income={summary.income}
          expense={summary.expense}
          rate={rate}
          currency={dc}
          locale={locale}
          t={t}
          monthLabel={monthLabel(month, locale)}
          canGoForward={monthsBack > 0}
          canGoBack={monthsBack < maxBack}
          onPrevMonth={() => setMonthsBack((back) => Math.min(maxBack, back + 1))}
          onNextMonth={() => setMonthsBack((back) => Math.max(0, back - 1))}
        />

        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.xl,
            gap: theme.spacing.xl,
          }}
        >
          {/* The three management areas as a compact stat row. Each tile's big
              figure is the size of that collection — how many recurring rules, how
              much is owed, how many budgets — so the number answers "how many/how
              much" on its own. A coloured qualifier line carries the one thing that
              wants attention (N due, N active, N over), shown only when there is
              one; the figure itself stays neutral. */}
          <Row style={{ gap: theme.spacing.md }}>
            <StatTile
              icon="repeat"
              value={String(ledger.recurrings.length)}
              hint={dueCount > 0 ? `${dueCount} ${t.personal.due.toLowerCase()}` : undefined}
              label={t.personal.recurring}
              onPress={() => router.push('/personal/recurring')}
            />
            <StatTile
              icon="cash-outline"
              value={activeLoans.length > 0 ? fmt(outstanding) : '—'}
              hint={
                activeLoans.length > 0
                  ? `${activeLoans.length} ${t.personal.active.toLowerCase()}`
                  : undefined
              }
              label={t.personal.loans}
              onPress={() => router.push('/personal/loans')}
            />
            <StatTile
              icon="pie-chart-outline"
              value={String(ledger.budgets.length)}
              hint={overBudgets > 0 ? `${overBudgets} ${t.personal.over}` : undefined}
              tone={overBudgets > 0 ? 'negative' : undefined}
              label={t.personal.budgets}
              onPress={() => router.push('/personal/budgets')}
            />
          </Row>

          {/* Two quiet contextual lines: what recurring item is next, and the
              category that has run furthest past its cap this month. */}
          {upcoming || worstOver ? (
            <View style={{ gap: theme.spacing.sm }}>
              {upcoming ? (
                <SignalRow
                  icon="repeat"
                  tone="brand"
                  label={t.personal.upcoming}
                  title={upcomingName}
                  value={upcomingWhen}
                  onPress={() => router.push('/personal/recurring')}
                />
              ) : null}
              {worstOver ? (
                <SignalRow
                  icon="alert-circle-outline"
                  tone="negative"
                  label={t.personal.overBudget}
                  title={overName}
                  value={`+${fmt(worstOver.over)}`}
                  onPress={() => router.push('/personal/budgets')}
                />
              ) : null}
            </View>
          ) : null}

          {/* Where the money went — a ranked bar list of the month's categories. */}
          {breakdownBars.length > 0 ? (
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
                {t.personal.whereMoneyWent.toUpperCase()}
              </Text>
              <Card>
                <BarList
                  data={breakdownBars}
                  accessibilityLabelFor={(d) => `${d.label}, ${d.formatted}`}
                />
              </Card>
            </View>
          ) : null}

          {/* Cash flow over the last three months — a small saved/spent trend. */}
          {trendActive ? (
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
                {t.personal.last3Months.toUpperCase()}
              </Text>
              <Card>
                <CashflowStrip trend={trend} currency={dc} locale={locale} />
              </Card>
            </View>
          ) : null}

          {/* The month's entries, grouped by day like a statement. */}
          <View style={{ gap: theme.spacing.sm }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
                {monthLabel(month, locale).toUpperCase()}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push('/personal/transactions')}
              >
                <Text variant="caption" tone="brand">
                  {t.personal.seeAll}
                </Text>
              </Pressable>
            </Row>

            {days.length === 0 ? (
              <Card>
                <Text tone="muted" align="center">
                  {t.personal.empty}
                </Text>
              </Card>
            ) : (
              days.map((day) => (
                <View key={day.key} style={{ gap: theme.spacing.xs }}>
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

          {/* A quiet reassurance: this ledger is the person's alone. */}
          <Row style={{ justifyContent: 'center', gap: theme.spacing.xs }}>
            <Ionicons name="lock-closed-outline" size={iconSize.xs} color={theme.color.textFaint} />
            <Text variant="micro" tone="faint">
              {t.personal.privateNote}
            </Text>
          </Row>
        </View>
      </ScrollView>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────── month ──

// Shift a YYYY-MM by whole calendar months. Date maths on the first of the month
// so day-of-month can never overflow (Date arg, never a bare `new Date()`).
function shiftMonth(month: string, delta: number): string {
  const d = new Date(`${month}-01T00:00:00`);
  d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Whole months from `from` to `to` (both YYYY-MM); negative if `to` precedes
// `from`. Used to bound backward month navigation to the earliest entry.
function monthsBetween(from: string, to: string): number {
  const [fy = 0, fm = 0] = from.split('-').map(Number);
  const [ty = 0, tm = 0] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// The month for the header — the reader's own calendar name, or the raw YYYY-MM
// if the platform has no Intl month names.
function monthLabel(month: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
      new Date(`${month}-01T00:00:00`),
    );
  } catch {
    return month;
  }
}

// When an upcoming item falls, in words: overdue / today / tomorrow, else the
// short calendar date (Sep 3). `days` is signed days from today to the date.
function whenLabel(
  days: number,
  date: string,
  locale: string,
  t: ReturnType<typeof useStrings>['t'],
): string {
  if (days < 0) return t.personal.overdue;
  if (days === 0) return t.personal.today;
  if (days === 1) return t.personal.tomorrow;
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
      new Date(`${date}T00:00:00`),
    );
  } catch {
    return date;
  }
}

// ─────────────────────────────────────────────────────────────── hero ──

/**
 * The edge-to-edge hero: a swipeable deck of three figures on a saturated wash,
 * the add actions, and a dot pager — the dashboard's account panel, told for a
 * private ledger. The carousel's live scroll offset drives the wash crossfade and
 * the pager, so colour, corner glyph and dots all move with the finger; it owns
 * that value itself since every piece that reads it lives inside the hero.
 */
function MeHero({
  net,
  income,
  expense,
  rate,
  currency,
  locale,
  t,
  monthLabel: label,
  canGoForward,
  canGoBack,
  onPrevMonth,
  onNextMonth,
}: {
  net: bigint;
  income: bigint;
  expense: bigint;
  rate: number | null;
  currency: string;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
  monthLabel: string;
  canGoForward: boolean;
  canGoBack: boolean;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // The deck's scroll offset, owned here so the wash, the corner glyph and the
  // dot pager all ride one value. Lazy-init, never read through `.current` in
  // render (the ref lint the compiler enforces).
  const [scrollX] = useState(() => new Animated.Value(0));
  // Each slide fills the hero's inner width; its snap point is that plus the gap.
  const cardWidth = width - theme.spacing.xl * 2;
  const gap = theme.spacing.md;
  const snap = cardWidth + gap;

  const saved = net >= 0n;
  const fmt = (amount: bigint): string =>
    format(money(amount, currency), { locale, compactFraction: true });

  // The net slide shows its figure as an absolute value, so the saved/overspent
  // direction lives in the label — the only slide whose sign carries meaning.
  const washes = [saved ? SAVED_WASH : OVERSPENT_WASH, SPENT_WASH, SAVINGS_WASH];
  const slides = [
    {
      key: 'net',
      label: `${saved ? t.personal.saved : t.personal.overspent} · ${currency}`,
      value: `${net < 0n ? '−' : ''}${fmt(net < 0n ? -net : net)}`,
    },
    {
      key: 'spent',
      label: `${t.personal.expenses} · ${currency}`,
      value: fmt(expense),
    },
    {
      key: 'savings',
      label: t.personal.savingsRate,
      value: rate === null ? '—' : `${Math.round(rate * 100)}%`,
    },
  ];

  // Share of income spent, for the persistent bar under the deck.
  const ratio =
    income > 0n ? Math.min(1, Number((expense * 1000n) / income) / 1000) : expense > 0n ? 1 : 0;

  const rangeFor = (index: number): number[] => [
    (index - 1) * snap,
    index * snap,
    (index + 1) * snap,
  ];

  return (
    <View
      style={{
        paddingTop: insets.top + theme.spacing.md,
        paddingHorizontal: theme.spacing.xl,
        paddingBottom: theme.spacing.lg,
        borderBottomLeftRadius: theme.radius.xxl,
        borderBottomRightRadius: theme.radius.xxl,
        gap: theme.spacing.lg,
        overflow: 'hidden',
      }}
    >
      {/* One wash layer per slide, stacked and crossfading on the scroll value —
          the first sits opaque as the base, the rest fade in at their own snap. */}
      {washes.map((colors, index) => (
        <Animated.View
          key={slides[index]?.key ?? index}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            index === 0
              ? null
              : {
                  opacity: scrollX.interpolate({
                    inputRange: rangeFor(index),
                    outputRange: [0, 1, 0],
                    extrapolate: 'clamp',
                  }),
                },
          ]}
        >
          <Gradient colors={colors} radius={0} style={{ flex: 1 }} />
        </Animated.View>
      ))}
      <HeroBackdrop scrollX={scrollX} snap={snap} />

      {/* Month switcher — the hero's header, centred, ‹ August 2026 ›. */}
      <Row style={{ alignItems: 'center', justifyContent: 'center', gap: theme.spacing.md }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.personal.prevMonth}
          accessibilityState={{ disabled: !canGoBack }}
          disabled={!canGoBack}
          onPress={onPrevMonth}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: !canGoBack ? 0.35 : pressed ? 0.5 : 1 })}
        >
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.onBrand}
          />
        </Pressable>
        <Text variant="subheading" tone="onBrand" numberOfLines={1}>
          {label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.personal.nextMonth}
          accessibilityState={{ disabled: !canGoForward }}
          disabled={!canGoForward}
          onPress={onNextMonth}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: !canGoForward ? 0.35 : pressed ? 0.5 : 1 })}
        >
          <Ionicons
            name={directionalIcon('chevron-forward')}
            size={iconSize.lg}
            color={theme.color.onBrand}
          />
        </Pressable>
      </Row>

      {/* The swipeable figures. Full-width slides, no peek — they ride transparent
          on the wash, so a peek would show floating text with no card edge; the
          dot pager carries the "swipe me" signal instead. */}
      <Animated.ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={snap}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        scrollEventThrottle={16}
        contentContainerStyle={{ gap }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
          useNativeDriver: true,
        })}
      >
        {slides.map((slide, index) => (
          <Animated.View
            key={slide.key}
            style={{
              width: cardWidth,
              opacity: scrollX.interpolate({
                inputRange: rangeFor(index),
                outputRange: [0.75, 1, 0.75],
                extrapolate: 'clamp',
              }),
              transform: [
                {
                  scale: scrollX.interpolate({
                    inputRange: rangeFor(index),
                    outputRange: [0.94, 1, 0.94],
                    extrapolate: 'clamp',
                  }),
                },
              ],
            }}
          >
            <MetricSlide label={slide.label} value={slide.value} />
          </Animated.View>
        ))}
      </Animated.ScrollView>

      {/* Spend against income — a persistent bar under the deck, with income and
          spend read out beneath it, so the context is there on every slide. */}
      <View style={{ gap: theme.spacing.sm }}>
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

      {/* The add actions and the pager travel as one block. */}
      <View style={{ gap: theme.spacing.md }}>
        <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <HeroPill
            icon="add"
            label={t.personal.addExpense}
            onPress={() =>
              router.push({ pathname: '/personal/entry', params: { kind: 'expense' } })
            }
          />
          <Row style={{ marginLeft: 'auto', gap: theme.spacing.sm }}>
            <HeroCircle
              icon="arrow-down"
              label={t.personal.addIncome}
              onPress={() =>
                router.push({ pathname: '/personal/entry', params: { kind: 'income' } })
              }
            />
            <HeroCircle
              icon="list-outline"
              label={t.personal.transactions}
              onPress={() => router.push('/personal/transactions')}
            />
          </Row>
        </Row>

        <HeroDots count={slides.length} scrollX={scrollX} snap={snap} />
      </View>
    </View>
  );
}

/** One figure slide, riding transparent on the wash — a label and the money big
 *  beneath it, white ink throughout so it reads the same in light and dark. */
function MetricSlide({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="caption" tone="onBrand" numberOfLines={1} style={{ opacity: 0.85 }}>
        {label}
      </Text>
      <Text variant="display" tone="onBrand" numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

/** The corner watermark — one faint glyph per slide, crossfading on the scroll
 *  value, clipped to the hero's rounded corner and never eating a tap. */
function HeroBackdrop({ scrollX, snap }: { scrollX: Animated.Value; snap: number }) {
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {SLIDE_ICONS.map((icon, index) => (
        <Animated.View
          key={icon}
          style={{
            position: 'absolute',
            right: -44,
            bottom: -52,
            opacity: scrollX.interpolate({
              inputRange: [(index - 1) * snap, index * snap, (index + 1) * snap],
              outputRange: [0, 0.16, 0],
              extrapolate: 'clamp',
            }),
          }}
        >
          <Ionicons name={icon} size={208} color={theme.color.onBrand} />
        </Animated.View>
      ))}
    </View>
  );
}

const DOT_SIZE = 6;
const DOT_ACTIVE_WIDTH = 18;

/** The dot pager: a fixed-width white pill that translates across faint static
 *  dots off the live scroll value — native-driven, so it tracks the finger. */
function HeroDots({
  count,
  scrollX,
  snap,
}: {
  count: number;
  scrollX: Animated.Value;
  snap: number;
}) {
  const theme = useTheme();
  const gap = theme.spacing.xs;
  const step = DOT_SIZE + gap;
  const trackWidth = count * DOT_SIZE + Math.max(0, count - 1) * gap;
  const translateX =
    count > 1
      ? scrollX.interpolate({
          inputRange: Array.from({ length: count }, (_, i) => i * snap),
          outputRange: Array.from({ length: count }, (_, i) => i * step),
          extrapolate: 'clamp',
        })
      : 0;
  return (
    <Row style={{ justifyContent: 'center' }}>
      <View style={{ width: trackWidth, height: DOT_SIZE }}>
        <Row style={{ position: 'absolute', left: 0, top: 0, gap }}>
          {Array.from({ length: count }, (_, index) => (
            <View
              key={index}
              style={{
                width: DOT_SIZE,
                height: DOT_SIZE,
                borderRadius: DOT_SIZE / 2,
                backgroundColor: 'rgba(255, 255, 255, 0.35)',
              }}
            />
          ))}
        </Row>
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: (DOT_SIZE - DOT_ACTIVE_WIDTH) / 2,
            width: DOT_ACTIVE_WIDTH,
            height: DOT_SIZE,
            borderRadius: DOT_SIZE / 2,
            backgroundColor: '#FFFFFF',
            transform: [{ translateX }],
          }}
        />
      </View>
    </Row>
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

/** The primary add action on the hero — a white pill with brand ink. */
function HeroPill({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.sm + 2,
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radius.pill,
        backgroundColor: '#FFFFFF',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.lg} color={theme.color.brand} />
      <Text variant="subheading" style={{ color: theme.color.brand }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A round action on the hero — a translucent white disc with a white glyph. */
function HeroCircle({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: 23,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: HERO_CONTROL_BG,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.xl} color={theme.color.onBrand} />
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────── body ──

/** One of the three management-area tiles under the hero: a glyph, the size of
 *  the collection, an optional coloured qualifier (the one figure that wants
 *  attention), and a label — tappable through to the area's own screen. The big
 *  figure stays neutral; the signal lives in `hint`, tinted by `tone`. */
function StatTile({
  icon,
  value,
  hint,
  tone,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  hint?: string;
  tone?: 'negative';
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const hintColor = tone === 'negative' ? theme.color.negative : theme.color.brand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}. ${value}. ${hint}` : `${label}. ${value}`}
      onPress={onPress}
      style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.6 : 1 })}
    >
      <Card style={{ gap: theme.spacing.xs, alignItems: 'flex-start', minHeight: 96 }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: theme.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.brandSoft,
            marginBottom: theme.spacing.xs,
          }}
        >
          <Ionicons name={icon} size={iconSize.sm} color={theme.color.brand} />
        </View>
        <Text variant="heading" numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
        {hint ? (
          <Text variant="micro" numberOfLines={1} style={{ color: hintColor, fontWeight: '700' }}>
            {hint}
          </Text>
        ) : null}
        <Text variant="micro" tone="muted" numberOfLines={1}>
          {label}
        </Text>
      </Card>
    </Pressable>
  );
}

/** A compact contextual line under the stat tiles: a tinted glyph, a small label
 *  (Upcoming / Over budget), the thing it names, and a trailing value — tappable
 *  through to the area it belongs to. Kept quiet, one row, never a card of its
 *  own weight. */
function SignalRow({
  icon,
  tone,
  label,
  title,
  value,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tone: 'brand' | 'negative';
  label: string;
  title: string;
  value: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const accent = tone === 'negative' ? theme.color.negative : theme.color.brand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${title}. ${value}`}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Card flat style={{ backgroundColor: theme.color.surfaceMuted }}>
        <Row style={{ gap: theme.spacing.md }}>
          <Ionicons name={icon} size={iconSize.md} color={accent} />
          <View style={{ flex: 1 }}>
            <Text variant="micro" tone="faint" numberOfLines={1}>
              {label}
            </Text>
            <Text variant="body" numberOfLines={1}>
              {title}
            </Text>
          </View>
          <Text variant="body" style={{ fontWeight: '700', color: accent }} numberOfLines={1}>
            {value}
          </Text>
        </Row>
      </Card>
    </Pressable>
  );
}

/** The last-three-months trend: one column per month, its height the size of the
 *  month's net and its colour the verdict (kept when in the black, spent when in
 *  the red), with the signed net and the month beneath. Heights scale to the
 *  largest absolute net in the window so the three read against each other. */
function CashflowStrip({
  trend,
  currency,
  locale,
}: {
  trend: readonly MonthCashflow[];
  currency: string;
  locale: string;
}) {
  const theme = useTheme();
  const abs = (n: bigint): bigint => (n < 0n ? -n : n);
  const largest = trend.reduce((max, m) => (abs(m.net) > max ? abs(m.net) : max), 0n);
  const barsHeight = 72;
  const fmt = (amount: bigint): string =>
    format(money(amount, currency), { locale, compactFraction: true });

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: theme.spacing.md,
          height: barsHeight,
        }}
      >
        {trend.map((m) => {
          const saved = m.net >= 0n;
          const percent = largest > 0n ? Number((abs(m.net) * 100n) / largest) : 0;
          return (
            <View
              key={m.month}
              accessible
              accessibilityLabel={`${monthShort(m.month, locale)}: ${saved ? '' : '−'}${fmt(abs(m.net))}`}
              style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'center' }}
            >
              <View
                style={{
                  width: '100%',
                  maxWidth: 44,
                  height: Math.max((percent / 100) * barsHeight, abs(m.net) > 0n ? 4 : 0),
                  borderRadius: theme.radius.sm,
                  backgroundColor: saved ? theme.color.positive : theme.color.negative,
                }}
              />
            </View>
          );
        })}
      </View>
      <Row style={{ gap: theme.spacing.md }}>
        {trend.map((m) => (
          <View key={m.month} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
            <Text
              variant="micro"
              numberOfLines={1}
              style={{ color: m.net < 0n ? theme.color.negative : theme.color.text }}
            >
              {m.net < 0n ? '−' : ''}
              {fmt(abs(m.net))}
            </Text>
            <Text variant="micro" tone="faint" numberOfLines={1}>
              {monthShort(m.month, locale)}
            </Text>
          </View>
        ))}
      </Row>
    </View>
  );
}

// A month's short name (Sep) for the trend axis, timezone-safe.
function monthShort(month: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short' }).format(
      new Date(`${month}-01T00:00:00`),
    );
  } catch {
    return month;
  }
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
        paddingVertical: theme.spacing.sm,
        minHeight: 44,
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
