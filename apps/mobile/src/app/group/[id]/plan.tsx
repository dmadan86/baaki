/**
 * The trip, day by day: what was planned, and what it actually cost.
 *
 * The reason this lives in Baaki rather than in a notes app is the second half.
 * Anything can hold "Dudhsagar falls" under Saturday. Only the app that already
 * has the ledger can put ₹2,000 planned beside ₹3,150 spent, and say the trip
 * is ₹4,000 over on day four.
 *
 * Planned and spent sit next to each other and are never added together, and
 * neither is ever converted into the other's currency (ADR-003). A plan item is
 * not money: it moves nobody's balance, it never reaches the export, and
 * ticking it off is somebody saying they did the thing — not that they paid for
 * it.
 */

import { useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  budgetProgress,
  budgetVariance,
  buildTimeline,
  dayNumber,
  fairness,
  forecast,
  spendByMember,
  type BudgetProgress,
  type MemberContribution,
  type PlanItem,
  type TimelineExpense,
} from '@waves/core';
import {
  AmountField,
  Button,
  Callout,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  type Theme,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import {
  useAddPlanItem,
  useClearMyTripBudget,
  useGroup,
  useGroupBudget,
  useMemberBudgets,
  usePlanItems,
  useRemovePlanItem,
  useSetGroupBudget,
  useSetMyTripBudget,
  useSetPlanItemDone,
} from '@/data/hooks';
import { displayName } from '@/data/types';
import { friendlyError } from '@/lib/errors';
import { useAuth } from '@/lib/auth';
import { SkeletonList } from '@/components/Skeletons';
import { CategoryBudgets } from '@/components/CategoryBudgets';
import { fill, useStrings, type UiStrings } from '@/i18n';

/** Today where the trip is, not where the server is. */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** 'Sat 14 Mar' from '2026-03-14', without letting a timezone move it. */
function dayLabel(day: string, locale: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const moment = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1));
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(moment);
}

export default function PlanScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const { profile } = useAuth();
  const { group, members, expenses } = useGroup(groupId);
  const plan = usePlanItems(groupId);
  const budgets = useMemberBudgets(groupId);
  const groupBudget = useGroupBudget(groupId);

  // Every write goes through the offline queue (A23), so the plan works with no
  // connection and the mirror updates the moment a mutation is enqueued.
  const addItem = useAddPlanItem(groupId);
  const toggleItem = useSetPlanItemDone(groupId);
  const removeItem = useRemovePlanItem(groupId);
  const setMine = useSetMyTripBudget(groupId);
  const clearMineBudget = useClearMyTripBudget(groupId);
  const setOverall = useSetGroupBudget(groupId);

  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currency = group.data?.default_currency ?? 'INR';
  const timeZone = group.data?.time_zone ?? 'Asia/Kolkata';
  const today = todayIn(timeZone);

  const items: PlanItem[] = useMemo(
    () =>
      (plan.data ?? []).map((row) => ({
        id: row.id,
        day: row.day.slice(0, 10),
        startsAt: row.starts_at ? row.starts_at.slice(0, 5) : null,
        title: row.title,
        note: row.note,
        category: row.category,
        plannedMinor: row.planned_minor === null ? null : BigInt(row.planned_minor),
        currency: row.currency,
        done: row.done_at !== null,
        expenseId: row.expense_id,
        position: row.position,
      })),
    [plan.data],
  );

  const spend: TimelineExpense[] = useMemo(
    () =>
      expenses.rows
        .filter((expense) => expense.currentVersion && !expense.deleted_at)
        .map((expense) => ({
          id: expense.id,
          date: expense.currentVersion!.expense_date.slice(0, 10),
          description: expense.currentVersion!.description,
          category: expense.currentVersion!.category,
          amountMinor: BigInt(expense.currentVersion!.amount),
          currency: expense.currentVersion!.currency,
        })),
    [expenses.rows],
  );

  const timeline = useMemo(
    () =>
      buildTimeline({
        items,
        expenses: spend,
        startDate: group.data?.start_date?.slice(0, 10) ?? null,
        endDate: group.data?.end_date?.slice(0, 10) ?? null,
      }),
    [items, spend, group.data?.start_date, group.data?.end_date],
  );

  const variance = useMemo(() => budgetVariance(timeline), [timeline]);
  const currentDay = dayNumber(
    today,
    group.data?.start_date?.slice(0, 10) ?? null,
    group.data?.end_date?.slice(0, 10) ?? null,
  );

  // Per-member spend, from the shares the ledger already holds — the figure a
  // personal budget is a ceiling on. Built once; every member's bar reads it.
  const memberSpend = useMemo(
    () =>
      spendByMember(
        expenses.rows
          .filter((expense) => expense.currentVersion && !expense.deleted_at)
          .map((expense) => ({
            currency: expense.currentVersion!.currency,
            shares: Object.fromEntries(
              expense.currentVersion!.shares.map((s) => [s.member_id, BigInt(s.amount)]),
            ),
          })),
      ),
    [expenses.rows],
  );

  const myProfileId = profile?.id ?? null;
  const myMember = (members.data ?? []).find((m) => m.profile_id === myProfileId) ?? null;
  const myMemberId = myMember?.id ?? null;
  const isAdmin = myMember?.role === 'admin';

  const overall = budgetProgress(
    groupBudget.data?.amountMinor != null
      ? {
          amountMinor: groupBudget.data.amountMinor,
          currency: groupBudget.data.currency ?? currency,
        }
      : null,
    timeline.spentByCurrency,
  );

  // What the caller is allowed to see: their own always, plus anybody who
  // shared. RLS already dropped everyone else's private row, so this is only a
  // display sort, never a privacy filter — the private ones are not here.
  const memberBudgets = (budgets.data ?? [])
    .map((row) => {
      const member = (members.data ?? []).find((m) => m.id === row.member_id) ?? null;
      const progress = budgetProgress(
        { amountMinor: BigInt(row.amount_minor), currency: row.currency },
        memberSpend.get(row.member_id),
      );
      return progress
        ? {
            memberId: row.member_id,
            name: member ? displayName(member, myProfileId) : '—',
            visibility: row.visibility,
            isMine: row.member_id === myMemberId,
            progress,
          }
        : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => (a.isMine === b.isMine ? 0 : a.isMine ? -1 : 1));

  const myBudget = memberBudgets.find((b) => b.isMine) ?? null;

  // Editors hold their amount in minor units — the unit the ledger speaks.
  const [editingMine, setEditingMine] = useState(false);
  const [myAmount, setMyAmount] = useState<bigint>(0n);
  const [myShare, setMyShare] = useState(false);
  const [editingOverall, setEditingOverall] = useState(false);
  const [overallAmount, setOverallAmount] = useState<bigint>(0n);

  const openMine = (): void => {
    setMyAmount(myBudget ? myBudget.progress.capMinor : 0n);
    setMyShare(myBudget ? myBudget.visibility === 'group' : false);
    setEditingMine(true);
  };

  const saveMine = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setMine.mutateAsync({
        amountMinor: myAmount,
        currency,
        visibility: myShare ? 'group' : 'private',
      });
      setEditingMine(false);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'plan.saveMine'));
    } finally {
      setBusy(false);
    }
  };

  const clearMine = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await clearMineBudget.mutateAsync();
      setEditingMine(false);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'plan.clearMine'));
    } finally {
      setBusy(false);
    }
  };

  const openOverall = (): void => {
    setOverallAmount(overall ? overall.capMinor : 0n);
    setEditingOverall(true);
  };

  const saveOverall = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setOverall.mutateAsync({ amountMinor: overallAmount, currency });
      setEditingOverall(false);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'plan.saveOverall'));
    } finally {
      setBusy(false);
    }
  };

  const clearOverall = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setOverall.mutateAsync({ amountMinor: null });
      setEditingOverall(false);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'plan.clearOverall'));
    } finally {
      setBusy(false);
    }
  };

  const isTrip = group.data?.type === 'trip';

  const nameOf = (memberId: string): string => {
    const member = (members.data ?? []).find((m) => m.id === memberId);
    return member ? displayName(member, myProfileId) : '—';
  };

  // Burn-rate: the pace so far, projected across the whole trip, per currency
  // and against the overall cap in its own currency (ADR-004). Empty until the
  // trip has both dates and a day of spend to read a pace from.
  const forecasts = useMemo(
    () =>
      isTrip
        ? forecast({
            spentByCurrency: timeline.spentByCurrency,
            budget:
              groupBudget.data?.amountMinor != null
                ? {
                    amountMinor: groupBudget.data.amountMinor,
                    currency: groupBudget.data.currency ?? currency,
                  }
                : null,
            today,
            startDate: group.data?.start_date?.slice(0, 10) ?? null,
            endDate: group.data?.end_date?.slice(0, 10) ?? null,
          })
        : [],
    [
      isTrip,
      timeline.spentByCurrency,
      groupBudget.data,
      today,
      group.data?.start_date,
      group.data?.end_date,
      currency,
    ],
  );

  // Fairness: who has fronted a lopsided share, and who could pick up the next
  // bill. Paid comes from the payers, owed from the shares — both already on the
  // mirrored ledger, never re-divided here.
  const fairnessSignals = useMemo(() => {
    if (!isTrip) return [];
    const byKey = new Map<string, MemberContribution & { paidMinor: bigint; owedMinor: bigint }>();
    const touch = (member: string, cur: string) => {
      const key = `${member}|${cur}`;
      let row = byKey.get(key);
      if (!row) {
        row = { member, currency: cur, paidMinor: 0n, owedMinor: 0n };
        byKey.set(key, row);
      }
      return row;
    };
    for (const expense of expenses.rows) {
      const version = expense.currentVersion;
      if (!version || expense.deleted_at) continue;
      for (const payer of version.payers)
        touch(payer.member_id, version.currency).paidMinor += BigInt(payer.amount);
      for (const share of version.shares)
        touch(share.member_id, version.currency).owedMinor += BigInt(share.amount);
    }
    return fairness([...byKey.values()]).filter((block) => block.overpayer || block.nextPayer);
  }, [isTrip, expenses.rows]);

  // `busy` is async state, so a double-tap can fire two submits in the same tick
  // before it re-renders — each mints a fresh itemId, so both post. A synchronous
  // ref closes that window; the button still reflects `busy` for the UI.
  const submitting = useRef(false);
  const submit = async (day: string): Promise<void> => {
    if (!title.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await addItem.mutateAsync({ day, title: title.trim(), currency });
      setTitle('');
      setAddingTo(null);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'plan.addItem'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const toggle = async (item: PlanItem): Promise<void> => {
    setError(null);
    try {
      await toggleItem.mutateAsync({ itemId: item.id, done: !item.done });
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'plan.toggleItem'));
    }
  };

  const remove = async (item: PlanItem): Promise<void> => {
    setError(null);
    try {
      await removeItem.mutateAsync(item.id);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'plan.removeItem'));
    }
  };

  if (group.isLoading || plan.isLoading) {
    // Shell first: the real header (back + title) paints instantly on
    // navigation; only the list below stands in as a skeleton while the mirror
    // read lands.
    return (
      <Screen>
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <Row style={{ paddingTop: theme.spacing.md, gap: theme.spacing.sm }}>
            <IconButton label={t.common.back} onPress={() => router.back()}>
              <Ionicons
                name={directionalIcon('chevron-back')}
                size={iconSize.lg}
                color={theme.color.text}
              />
            </IconButton>
            <Text variant="heading">{t.plan}</Text>
          </Row>
        </View>
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <SkeletonList rows={5} trailing={false} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Row
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          gap: theme.spacing.sm,
        }}
      >
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <Text variant="heading">{t.plan}</Text>
        <View style={{ flex: 1 }} />
        {group.data?.type === 'trip' ? (
          <IconButton label={t.tripMap.title} onPress={() => router.push(`/group/${groupId}/map`)}>
            <Ionicons name="location-outline" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
        ) : null}
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: clearance,
          gap: theme.spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        {error ? <Callout tone="negative">{error}</Callout> : null}

        {/* Planned against actual, per currency and never added together. */}
        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {currentDay ? `${t.plan} · ${fill(t.dayNumber, { n: String(currentDay) })}` : t.plan}
          </Text>
          {Object.keys(variance).length === 0 ? (
            <Text variant="caption" tone="faint">
              {t.nothingPlannedYet}
            </Text>
          ) : (
            Object.entries(variance).map(([code, over]) => (
              <Row key={code} style={{ justifyContent: 'space-between' }}>
                <View>
                  <Text variant="caption" tone="muted">
                    {t.planned}
                  </Text>
                  <MoneyText
                    amount={timeline.plannedByCurrency[code] ?? 0n}
                    currency={code}
                    locale={locale}
                    variant="subheading"
                  />
                </View>
                <View>
                  <Text variant="caption" tone="muted">
                    {t.spent}
                  </Text>
                  <MoneyText
                    amount={timeline.spentByCurrency[code] ?? 0n}
                    currency={code}
                    locale={locale}
                    variant="subheading"
                  />
                </View>
                <View>
                  <Text variant="caption" tone="muted">
                    {over > 0n ? t.overBudget : t.underBudget}
                  </Text>
                  <MoneyText
                    amount={over < 0n ? -over : over}
                    currency={code}
                    locale={locale}
                    variant="subheading"
                    mode="plain"
                  />
                </View>
              </Row>
            ))
          )}
        </Card>

        {/* Budgets: an overall ceiling the admin sets, and a personal one each
            member sets for themselves. A bar shows spend against each — and only
            the ones the reader is allowed to see are here, because the server
            never sent the private ones. */}
        {isTrip ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="subheading">{t.budgets}</Text>
              {isAdmin && !editingOverall ? (
                <Text variant="caption" tone="brand" onPress={openOverall}>
                  {overall ? t.overallBudget : `+ ${t.overallBudget}`}
                </Text>
              ) : null}
            </Row>

            {editingOverall ? (
              <View style={{ gap: theme.spacing.sm }}>
                <Text variant="caption" tone="muted">
                  {t.overallBudget}
                </Text>
                <AmountField
                  currency={currency}
                  value={overallAmount}
                  onChange={setOverallAmount}
                />
                <Row style={{ gap: theme.spacing.sm }}>
                  <Button
                    label={t.saveBudget}
                    size="sm"
                    disabled={busy}
                    onPress={() => void saveOverall()}
                  />
                  {overall ? (
                    <Button
                      label={t.clearBudget}
                      size="sm"
                      variant="ghost"
                      onPress={() => void clearOverall()}
                    />
                  ) : null}
                  <Button
                    label={t.cancel}
                    size="sm"
                    variant="ghost"
                    onPress={() => setEditingOverall(false)}
                  />
                </Row>
              </View>
            ) : overall ? (
              <BudgetBar
                label={t.overallBudget}
                progress={overall}
                locale={locale}
                t={t}
                theme={theme}
              />
            ) : null}

            {editingMine ? (
              <View style={{ gap: theme.spacing.sm }}>
                <Text variant="caption" tone="muted">
                  {t.myBudget}
                </Text>
                <AmountField currency={currency} value={myAmount} onChange={setMyAmount} />
                <Pressable
                  onPress={() => setMyShare((v) => !v)}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: myShare }}
                  accessibilityLabel={t.shareWithGroup}
                  hitSlop={8}
                >
                  <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                    <Ionicons
                      name={myShare ? 'checkbox' : 'square-outline'}
                      size={iconSize.lg}
                      color={myShare ? theme.color.brand : theme.color.textFaint}
                    />
                    <Text variant="caption">{myShare ? t.shareWithGroup : t.budgetPrivate}</Text>
                  </Row>
                </Pressable>
                <Row style={{ gap: theme.spacing.sm }}>
                  <Button
                    label={t.saveBudget}
                    size="sm"
                    disabled={busy}
                    onPress={() => void saveMine()}
                  />
                  {myBudget ? (
                    <Button
                      label={t.clearBudget}
                      size="sm"
                      variant="ghost"
                      onPress={() => void clearMine()}
                    />
                  ) : null}
                  <Button
                    label={t.cancel}
                    size="sm"
                    variant="ghost"
                    onPress={() => setEditingMine(false)}
                  />
                </Row>
              </View>
            ) : (
              <Pressable
                onPress={openMine}
                accessibilityRole="button"
                accessibilityLabel={t.myBudget}
              >
                {myBudget ? (
                  <BudgetBar
                    label={t.myBudget}
                    progress={myBudget.progress}
                    locale={locale}
                    t={t}
                    theme={theme}
                    badge={myBudget.visibility === 'group' ? 'people' : 'lock-closed'}
                  />
                ) : (
                  <Text variant="caption" tone="brand">
                    + {t.myBudget}
                  </Text>
                )}
              </Pressable>
            )}

            {memberBudgets
              .filter((b) => !b.isMine)
              .map((b) => (
                <BudgetBar
                  key={b.memberId}
                  label={b.name}
                  progress={b.progress}
                  locale={locale}
                  t={t}
                  theme={theme}
                />
              ))}
          </Card>
        ) : null}

        {isTrip ? (
          <CategoryBudgets
            groupId={groupId}
            currency={currency}
            isAdmin={isAdmin}
            expenses={spend}
          />
        ) : null}

        {isTrip && forecasts.length > 0 ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading">{t.tripInsights.forecast}</Text>
            {forecasts.map((f) => (
              <Row
                key={f.currency}
                style={{ justifyContent: 'space-between', alignItems: 'center' }}
              >
                <View>
                  <Text variant="caption" tone="muted">
                    {f.ended ? t.tripInsights.total : t.tripInsights.projectedTotal}
                  </Text>
                  <MoneyText
                    amount={f.projectedTotalMinor}
                    currency={f.currency}
                    locale={locale}
                    variant="subheading"
                    mode="plain"
                  />
                </View>
                {f.capMinor !== null ? (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text variant="caption" tone={f.onTrack ? 'muted' : 'negative'}>
                      {f.onTrack ? t.tripInsights.onTrack : t.overBudget}
                    </Text>
                    {!f.onTrack && f.projectedOverrunMinor !== null ? (
                      <MoneyText
                        amount={
                          f.projectedOverrunMinor < 0n
                            ? -f.projectedOverrunMinor
                            : f.projectedOverrunMinor
                        }
                        currency={f.currency}
                        locale={locale}
                        variant="caption"
                        mode="plain"
                      />
                    ) : null}
                  </View>
                ) : null}
              </Row>
            ))}
          </Card>
        ) : null}

        {isTrip && fairnessSignals.length > 0 ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading">{t.tripInsights.fairness}</Text>
            {fairnessSignals.map((block) => (
              <View key={block.currency} style={{ gap: theme.spacing.xs }}>
                {block.overpayer ? (
                  <Text variant="caption">
                    {fill(t.tripInsights.paidShare, {
                      name: nameOf(block.overpayer.member),
                      percent: String(Math.round(block.overpayer.paidRatio * 100)),
                    })}
                  </Text>
                ) : null}
                {block.nextPayer ? (
                  <Text variant="caption" tone="brand">
                    {fill(t.tripInsights.nextUp, { name: nameOf(block.nextPayer) })}
                  </Text>
                ) : null}
              </View>
            ))}
          </Card>
        ) : null}

        {isTrip ? (
          <Pressable
            onPress={() => router.push(`/group/${groupId}/recap`)}
            accessibilityRole="button"
            accessibilityLabel={t.tripInsights.recap}
            style={{ paddingVertical: theme.spacing.xs }}
          >
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="caption" tone="brand">
                {t.tripInsights.recap}
              </Text>
              <Ionicons
                name={directionalIcon('chevron-forward')}
                size={iconSize.sm}
                color={theme.color.brand}
              />
            </Row>
          </Pressable>
        ) : null}

        {timeline.days.length === 0 ? (
          <EmptyState title={t.nothingPlannedYet} body={t.planEmptyBody} />
        ) : null}

        {timeline.days.map((day) => (
          <View key={day.day} style={{ gap: theme.spacing.sm }}>
            {/* The day heading is the day's add button.

                Every day used to carry a standing "+ Add" row beneath its
                items, which meant a screen of eight days wore eight identical
                buttons — the affordance repeated far more loudly than the plan
                it belonged to. The heading was already the thing being pointed
                at when somebody wanted to add to that day, so it does the job:
                tapping it opens the same inline field the row used to. */}
            <Pressable
              onPress={() => {
                setAddingTo(day.day);
                setTitle('');
              }}
              accessibilityRole="button"
              accessibilityLabel={`${t.add} — ${dayLabel(day.day, locale)}`}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Row style={{ justifyContent: 'space-between' }}>
                <Text variant="subheading" tone={day.day === today ? 'brand' : 'default'}>
                  {dayLabel(day.day, locale)}
                </Text>
                {Object.entries(day.spentByCurrency).map(([code, amount]) => (
                  <MoneyText
                    key={code}
                    amount={amount}
                    currency={code}
                    locale={locale}
                    variant="caption"
                  />
                ))}
              </Row>
            </Pressable>

            {/* A day with nothing planned, nothing spent and no open field has
                an empty card to show, and an empty card is a sliver of surface
                that reads as a rendering fault. It used to always hold at least
                the "+ Add" row; now that the heading carries that, the card
                only appears once there is something in it. */}
            {day.items.length > 0 || day.expenses.length > 0 || addingTo === day.day ? (
              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {day.items.map((item) => (
                  <Row
                    key={item.id}
                    style={{ paddingVertical: theme.spacing.md, gap: theme.spacing.md }}
                  >
                    <Pressable
                      onPress={() => void toggle(item)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: item.done }}
                      accessibilityLabel={item.title}
                      hitSlop={10}
                    >
                      <Ionicons
                        name={item.done ? 'checkmark-circle' : 'ellipse-outline'}
                        size={iconSize.xl}
                        color={item.done ? theme.color.positive : theme.color.textFaint}
                      />
                    </Pressable>
                    <View style={{ flex: 1 }}>
                      <Text variant="body" tone={item.done ? 'faint' : 'default'}>
                        {item.startsAt ? `${item.startsAt}  ` : ''}
                        {item.title}
                      </Text>
                      {item.note ? (
                        <Text variant="micro" tone="muted">
                          {item.note}
                        </Text>
                      ) : null}
                    </View>
                    {item.plannedMinor !== null ? (
                      <MoneyText
                        amount={item.plannedMinor}
                        currency={item.currency}
                        locale={locale}
                        variant="caption"
                      />
                    ) : null}
                    <Pressable
                      onPress={() => void remove(item)}
                      accessibilityRole="button"
                      accessibilityLabel={fill(t.itemize.removeItem, { label: item.title })}
                      hitSlop={10}
                    >
                      <Ionicons name="close" size={iconSize.md} color={theme.color.textFaint} />
                    </Pressable>
                  </Row>
                ))}

                {/* What was actually spent that day, so the plan and the ledger
                  are read in one place rather than two screens apart. */}
                {day.expenses.map((expense) => (
                  <Row
                    key={expense.id}
                    style={{ paddingVertical: theme.spacing.sm, gap: theme.spacing.md }}
                  >
                    <Ionicons
                      name="receipt-outline"
                      size={iconSize.md}
                      color={theme.color.textFaint}
                    />
                    <Text variant="caption" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
                      {expense.description}
                    </Text>
                    <MoneyText
                      amount={expense.amountMinor}
                      currency={expense.currency}
                      locale={locale}
                      variant="caption"
                    />
                  </Row>
                ))}

                {/* Opened by the day's heading above. Nothing stands in its place
                  when closed: an empty day is already an invitation, and the
                  heading is the way in. */}
                {addingTo === day.day ? (
                  <View style={{ paddingVertical: theme.spacing.md, gap: theme.spacing.sm }}>
                    <TextInput
                      value={title}
                      onChangeText={setTitle}
                      placeholder={t.whatIsPlanned}
                      placeholderTextColor={theme.color.textFaint}
                      autoFocus
                      onSubmitEditing={() => void submit(day.day)}
                      style={{ fontSize: 16, color: theme.color.text, paddingVertical: 4 }}
                    />
                    <Row style={{ gap: theme.spacing.sm }}>
                      <Button
                        label={t.add}
                        size="sm"
                        disabled={busy}
                        onPress={() => void submit(day.day)}
                      />
                      <Button
                        label={t.cancel}
                        size="sm"
                        variant="ghost"
                        onPress={() => {
                          setAddingTo(null);
                          setTitle('');
                        }}
                      />
                    </Row>
                  </View>
                ) : null}
              </Card>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

/**
 * One budget's bar: spent over cap, the fill green under and red over, and the
 * signed gap spelled out beneath so a full bar still says by how much. The
 * overflow rides the flag, never the bar — a bar cannot show 125%.
 */
function BudgetBar({
  label,
  progress,
  locale,
  t,
  theme,
  badge,
}: {
  label: string;
  progress: BudgetProgress;
  locale: string;
  t: UiStrings;
  theme: Theme;
  badge?: keyof typeof Ionicons.glyphMap;
}) {
  const fill = Math.max(0, Math.min(1, progress.ratio));
  const color = progress.over ? theme.color.negative : theme.color.positive;
  const gap = progress.remainingMinor < 0n ? -progress.remainingMinor : progress.remainingMinor;
  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Row style={{ gap: theme.spacing.xs, alignItems: 'center', flex: 1 }}>
          {badge ? (
            <Ionicons name={badge} size={iconSize.xs} color={theme.color.textFaint} />
          ) : null}
          <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>
            {label}
          </Text>
        </Row>
        <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
          <MoneyText
            amount={progress.spentMinor}
            currency={progress.currency}
            locale={locale}
            variant="caption"
            mode="plain"
          />
          <Text variant="caption" tone="faint">
            /
          </Text>
          <MoneyText
            amount={progress.capMinor}
            currency={progress.currency}
            locale={locale}
            variant="caption"
            mode="plain"
          />
        </Row>
      </Row>
      <View
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.color.border,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${fill * 100}%`,
            height: '100%',
            backgroundColor: color,
            borderRadius: 4,
          }}
        />
      </View>
      <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
        <MoneyText
          amount={gap}
          currency={progress.currency}
          locale={locale}
          variant="micro"
          mode="plain"
        />
        <Text variant="micro" tone={progress.over ? 'negative' : 'muted'}>
          {progress.over ? t.overBudget : t.budgetLeft}
        </Text>
      </Row>
    </View>
  );
}
