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

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  budgetVariance,
  buildTimeline,
  dayNumber,
  type PlanItem,
  type TimelineExpense,
} from '@baaki/core';
import {
  Button,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { addPlanItem, removePlanItem, setPlanItemDone } from '@/data/api';
import { usePlanItems, useGroup } from '@/data/hooks';
import { useStrings } from '@/i18n';

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
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const { group, expenses } = useGroup(groupId);
  const plan = usePlanItems(groupId);

  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

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

  const submit = async (day: string): Promise<void> => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await addPlanItem({ groupId, day, title: title.trim(), currency });
      setTitle('');
      setAddingTo(null);
      await plan.refetch();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (item: PlanItem): Promise<void> => {
    await setPlanItemDone(item.id, !item.done);
    await plan.refetch();
  };

  const remove = async (item: PlanItem): Promise<void> => {
    await removePlanItem(item.id);
    await plan.refetch();
  };

  if (group.isLoading || plan.isLoading) {
    return (
      <Screen>
        <View style={{ padding: theme.spacing.xl }}>
          <ActivityIndicator color={theme.color.brand} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md, gap: theme.spacing.sm }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <Text variant="heading">{t.plan}</Text>
        </Row>

        {/* Planned against actual, per currency and never added together. */}
        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {currentDay ? `${t.plan} · day ${currentDay}` : t.plan}
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

        {timeline.days.length === 0 ? (
          <EmptyState title={t.nothingPlannedYet} body={t.planEmptyBody} />
        ) : null}

        {timeline.days.map((day) => (
          <View key={day.day} style={{ gap: theme.spacing.sm }}>
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
                      size={22}
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
                    accessibilityLabel={`Remove ${item.title}`}
                    hitSlop={10}
                  >
                    <Ionicons name="close" size={18} color={theme.color.textFaint} />
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
                  <Ionicons name="receipt-outline" size={18} color={theme.color.textFaint} />
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
              ) : (
                <Pressable
                  onPress={() => {
                    setAddingTo(day.day);
                    setTitle('');
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.add} — ${dayLabel(day.day, locale)}`}
                  style={{ paddingVertical: theme.spacing.md }}
                >
                  <Text variant="caption" tone="brand">
                    + {t.add}
                  </Text>
                </Pressable>
              )}
            </Card>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
