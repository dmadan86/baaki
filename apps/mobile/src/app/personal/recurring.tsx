/**
 * Recurring rules (A48): bills and income that repeat — a phone bill, a salary,
 * a subscription. A rule set to "add automatically" posts its entry on its own
 * when due (handled on the Me tab's open); a manual one just shows as due here,
 * to add with one tap. The editor is an inline sheet.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { Alert, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  addToDate,
  encodeRecurring,
  encodeTxn,
  format,
  isRecurringDue,
  money,
  recurringOccurrenceId,
  type Cadence,
  type PersonalRecurring,
  type TxnKind,
} from '@waves/core';
import {
  AmountField,
  Button,
  Card,
  directionalIcon,
  Divider,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Sheet,
  SegmentedTabs,
  Text,
  Toggle,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { CategoryPicker } from '@/components/Category';
import {
  localIsoDate,
  todayIso,
  usePersonalLedger,
  useDeletePersonalRecord,
  useUpsertPersonalRecord,
} from '@/data/personal';
import { useDefaultCurrency } from '@/lib/currency';
import { useStrings } from '@/i18n';

export default function RecurringScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const dc = useDefaultCurrency();
  const { recurrings } = usePersonalLedger();
  const upsert = useUpsertPersonalRecord();

  const [today] = useState(() => todayIso());
  const [editing, setEditing] = useState<PersonalRecurring | null>(null);
  const [creating, setCreating] = useState(false);

  const cadenceLabel = (rule: PersonalRecurring): string => {
    const base =
      rule.cadence === 'weekly'
        ? t.personal.weekly
        : rule.cadence === 'yearly'
          ? t.personal.yearly
          : t.personal.monthly;
    return rule.interval > 1 ? `${t.personal.every} ${rule.interval} · ${base}` : base;
  };

  // Post one occurrence of a manual rule now, and advance its next date. The
  // occurrence id is deterministic per (rule, date), so this posting the same
  // date the auto catch-up also posts collapses to one row rather than two.
  const postOnce = async (rule: PersonalRecurring): Promise<void> => {
    await upsert.mutateAsync({
      recordId: recurringOccurrenceId(rule.id, rule.nextDate),
      recordKind: 'txn',
      data: encodeTxn({
        kind: rule.txnKind,
        amount: rule.amount,
        currency: rule.currency,
        category: rule.category,
        note: rule.note,
        date: rule.nextDate,
        loanId: null,
        recurringId: rule.id,
      }),
    });
    await upsert.mutateAsync({
      recordId: rule.id,
      recordKind: 'recurring',
      data: encodeRecurring({
        ...rule,
        nextDate: addToDate(rule.nextDate, rule.cadence, rule.interval),
      }),
    });
  };

  return (
    <Screen>
      <Row
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          alignItems: 'center',
        }}
      >
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.personal.recurring}</Text>
        </View>
        <IconButton label={t.personal.addRecurring} onPress={() => setCreating(true)}>
          <Ionicons name="add" size={iconSize.xxl} color={theme.color.brand} />
        </IconButton>
      </Row>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.md,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Text
          variant="caption"
          tone="muted"
          align="center"
          style={{ marginBottom: theme.spacing.sm }}
        >
          {t.personal.recurringSub}
        </Text>

        {recurrings.length === 0 ? (
          <View style={{ paddingTop: theme.spacing.xxxl }}>
            <EmptyState title={t.personal.noRecurring} />
          </View>
        ) : (
          recurrings.map((rule) => {
            const due = isRecurringDue(rule, today);
            const income = rule.txnKind === 'income';
            return (
              <Card key={rule.id} style={{ gap: theme.spacing.sm }}>
                <Pressable accessibilityRole="button" onPress={() => setEditing(rule)}>
                  <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                    <View style={{ flex: 1 }}>
                      <Text variant="body" numberOfLines={1} style={{ fontWeight: '600' }}>
                        {rule.note?.trim() || (income ? t.personal.incomeKind : t.personal.expense)}
                      </Text>
                      <Text variant="micro" tone="muted">
                        {cadenceLabel(rule)} · {t.personal.nextDue} {rule.nextDate}
                        {rule.active ? '' : ` · ${t.personal.paused}`}
                      </Text>
                    </View>
                    <Text
                      variant="body"
                      style={{
                        fontWeight: '700',
                        color: income ? theme.color.positive : theme.color.text,
                      }}
                    >
                      {income ? '+' : '−'}
                      {format(money(rule.amount, rule.currency), { locale, compactFraction: true })}
                    </Text>
                  </Row>
                </Pressable>
                {due && !rule.autoPost && rule.active ? (
                  <>
                    <Divider />
                    <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text variant="caption" tone="brand" style={{ fontWeight: '600' }}>
                        {t.personal.due}
                      </Text>
                      <Button
                        label={t.personal.postNow}
                        size="sm"
                        onPress={() => void postOnce(rule)}
                        disabled={upsert.isPending}
                      />
                    </Row>
                  </>
                ) : null}
              </Card>
            );
          })
        )}
      </ScrollView>

      {creating ? (
        <RecurringEditor currency={dc} today={today} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? (
        <RecurringEditor
          rule={editing}
          currency={dc}
          today={today}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Screen>
  );
}

function RecurringEditor({
  rule,
  currency,
  today,
  onClose,
}: {
  rule?: PersonalRecurring;
  currency: string;
  today: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const upsert = useUpsertPersonalRecord();
  const remove = useDeletePersonalRecord();

  const [txnKind, setTxnKind] = useState<TxnKind>(rule?.txnKind ?? 'expense');
  const [amount, setAmount] = useState<bigint>(rule?.amount ?? 0n);
  const [note, setNote] = useState(rule?.note ?? '');
  const [category, setCategory] = useState<string | null>(rule?.category ?? null);
  const [cadence, setCadence] = useState<Cadence>(rule?.cadence ?? 'monthly');
  // The editable "next due" date: a new rule starts on it; an existing rule is
  // rescheduled to it. Seeded from the rule's current next date, not its anchor,
  // so opening and saving an unchanged rule never rewinds its schedule.
  const [startDate, setStartDate] = useState(rule?.nextDate ?? today);
  const [showDate, setShowDate] = useState(false);
  const [autoPost, setAutoPost] = useState(rule?.autoPost ?? false);
  const [active, setActive] = useState(rule?.active ?? true);

  const canSave = amount > 0n && !upsert.isPending;

  const onSave = (): void => {
    if (!canSave) return;
    upsert.mutate(
      {
        recordId: rule?.id,
        recordKind: 'recurring',
        data: encodeRecurring({
          txnKind,
          amount,
          currency: rule?.currency ?? currency,
          category,
          note: note.trim() || null,
          cadence,
          interval: rule?.interval ?? 1,
          // Keep the original anchor on an edit; a new rule anchors on its start.
          anchorDate: rule?.anchorDate ?? startDate,
          // The picker holds the next-due date for both a new rule and an edit,
          // so a rescheduled date actually takes effect.
          nextDate: startDate,
          endDate: rule?.endDate ?? null,
          autoPost,
          active,
        }),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Sheet visible onClose={onClose} padded={false} style={{ maxHeight: '90%' }}>
          <ScrollView
            contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}
            keyboardShouldPersistTaps="handled"
          >
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="heading">
                {rule ? t.personal.editRecurring : t.personal.addRecurring}
              </Text>
              <IconButton label={t.common.close} onPress={onClose}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
            </Row>

            <SegmentedTabs
              value={txnKind}
              onChange={setTxnKind}
              tabs={[
                { value: 'expense', label: t.personal.expense },
                { value: 'income', label: t.personal.incomeKind },
              ]}
            />

            <View style={{ alignItems: 'center', paddingVertical: theme.spacing.md }}>
              <AmountField
                currency={rule?.currency ?? currency}
                value={amount}
                onChange={setAmount}
              />
            </View>

            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder={t.personal.notePlaceholder}
              placeholderTextColor={theme.color.textFaint}
              style={{
                fontSize: 16,
                color: theme.color.text,
                paddingVertical: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                backgroundColor: theme.color.surfaceMuted,
                borderRadius: theme.radius.md,
              }}
            />

            {txnKind === 'expense' ? (
              <CategoryPicker value={category} onChange={(picked) => setCategory(picked)} />
            ) : null}

            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                {t.personal.repeats}
              </Text>
              <SegmentedTabs
                value={cadence}
                onChange={setCadence}
                tabs={[
                  { value: 'weekly', label: t.personal.weekly },
                  { value: 'monthly', label: t.personal.monthly },
                  { value: 'yearly', label: t.personal.yearly },
                ]}
              />
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={() => setShowDate(true)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                backgroundColor: theme.color.surfaceMuted,
                borderRadius: theme.radius.md,
              }}
            >
              <Text variant="body">
                {t.personal.nextDue}: {startDate}
              </Text>
              <Ionicons name="calendar-outline" size={iconSize.md} color={theme.color.textMuted} />
            </Pressable>
            {showDate ? (
              <DateTimePicker
                value={new Date(`${startDate}T00:00:00`)}
                mode="date"
                onChange={(event, picked) => {
                  if (Platform.OS !== 'ios') setShowDate(false);
                  if (event.type === 'set' && picked) setStartDate(localIsoDate(picked));
                }}
              />
            ) : null}

            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1, paddingRight: theme.spacing.md }}>
                <Text variant="body">{t.personal.autoPost}</Text>
                <Text variant="micro" tone="muted">
                  {t.personal.autoPostHint}
                </Text>
              </View>
              <Toggle
                value={autoPost}
                onValueChange={setAutoPost}
                accessibilityLabel={t.personal.autoPost}
              />
            </Row>

            {rule ? (
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Text variant="body">{t.personal.active}</Text>
                <Toggle
                  value={active}
                  onValueChange={setActive}
                  accessibilityLabel={t.personal.active}
                />
              </Row>
            ) : null}

            <Button
              label={t.personal.save}
              size="lg"
              fullWidth
              onPress={onSave}
              disabled={!canSave}
            />

            {rule ? (
              <Button
                label={t.common.delete}
                variant="danger"
                fullWidth
                onPress={() =>
                  Alert.alert(t.common.delete, t.personal.deleteConfirm, [
                    { text: t.common.cancel, style: 'cancel' },
                    {
                      text: t.common.delete,
                      style: 'destructive',
                      onPress: () => remove.mutate(rule.id, { onSuccess: onClose }),
                    },
                  ])
                }
              />
            ) : null}
          </ScrollView>
    </Sheet>
  );
}
