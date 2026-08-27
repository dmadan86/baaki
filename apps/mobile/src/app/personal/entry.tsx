/**
 * Add or edit one personal-finance entry (A48) — an expense or income line in
 * your own private ledger. No group, no split, no members: just an amount, what
 * it was for, and when. Reached from the "Me" tab's add buttons, and (with a
 * `loanId`) as a loan repayment.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { router, useLocalSearchParams } from 'expo-router';
import { Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import { encodeTxn, type CategoryMeta, type TxnKind } from '@waves/core';
import {
  AmountField,
  Button,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  SegmentedTabs,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { CategoryPicker } from '@/components/Category';
import {
  useDeletePersonalRecord,
  usePersonalLedger,
  useUpsertPersonalRecord,
  todayIso,
} from '@/data/personal';
import { useDefaultCurrency } from '@/lib/currency';
import { useStrings } from '@/i18n';

export default function PersonalEntryScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t } = useStrings();
  const dc = useDefaultCurrency();
  const params = useLocalSearchParams<{ kind?: string; id?: string; loanId?: string }>();

  const { txns } = usePersonalLedger();
  const editing = params.id ? txns.find((txn) => txn.id === params.id) : undefined;

  const upsert = useUpsertPersonalRecord();
  const remove = useDeletePersonalRecord();

  const [kind, setKind] = useState<TxnKind>(
    editing?.kind ?? (params.kind === 'income' ? 'income' : 'expense'),
  );
  const [amount, setAmount] = useState<bigint>(editing?.amount ?? 0n);
  const [note, setNote] = useState(editing?.note ?? '');
  const [category, setCategory] = useState<string | null>(editing?.category ?? null);
  const [date, setDate] = useState(editing?.date ?? todayIso());
  const [showDate, setShowDate] = useState(false);
  // A repayment carries the loan it settles through from the loans screen; kept
  // as-is on an edit so the link survives.
  const loanId = editing?.loanId ?? (typeof params.loanId === 'string' ? params.loanId : null);

  const currency = editing?.currency ?? dc;
  const canSave = amount > 0n && !upsert.isPending;

  const onSave = (): void => {
    if (!canSave) return;
    upsert.mutate(
      {
        recordId: editing?.id,
        recordKind: 'txn',
        data: encodeTxn({
          kind,
          amount,
          currency,
          category,
          note: note.trim() || null,
          date,
          loanId,
          recurringId: editing?.recurringId ?? null,
        }),
      },
      { onSuccess: () => router.back() },
    );
  };

  const onDelete = (): void => {
    if (!editing) return;
    remove.mutate(editing.id, { onSuccess: () => router.back() });
  };

  const title = editing
    ? t.personal.transactions
    : kind === 'income'
      ? t.personal.addIncome
      : t.personal.addExpense;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md, alignItems: 'center' }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{title}</Text>
          </View>
          {editing ? (
            <IconButton label={t.common.delete} onPress={onDelete}>
              <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
            </IconButton>
          ) : (
            <View style={{ width: iconSize.lg }} />
          )}
        </Row>

        {/* A repayment's kind is fixed by the loan, so only a plain entry chooses. */}
        {loanId ? null : (
          <SegmentedTabs
            value={kind}
            onChange={setKind}
            tabs={[
              { value: 'expense', label: t.personal.expense },
              { value: 'income', label: t.personal.incomeKind },
            ]}
          />
        )}

        <View style={{ alignItems: 'center', paddingVertical: theme.spacing.lg }}>
          <AmountField currency={currency} value={amount} onChange={setAmount} />
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.personal.note}
          </Text>
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
        </View>

        {/* A repayment is not everyday spend, so it carries no category. */}
        {loanId ? null : (
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="muted">
              {t.personal.category}
            </Text>
            <CategoryPicker
              value={category}
              onChange={(picked: string, _meta: CategoryMeta | null) => setCategory(picked)}
            />
          </View>
        )}

        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.personal.date}
          </Text>
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
            <Text variant="body">{date}</Text>
            <Ionicons name="calendar-outline" size={iconSize.md} color={theme.color.textMuted} />
          </Pressable>
          {showDate ? (
            <DateTimePicker
              value={new Date(`${date}T00:00:00`)}
              mode="date"
              onChange={(event, picked) => {
                // Android fires once and dismisses itself; iOS stays open.
                if (Platform.OS !== 'ios') setShowDate(false);
                if (event.type === 'set' && picked) {
                  setDate(picked.toISOString().slice(0, 10));
                }
              }}
            />
          ) : null}
        </View>

        <Button label={t.personal.save} size="lg" fullWidth onPress={onSave} disabled={!canSave} />
      </ScrollView>
    </Screen>
  );
}
