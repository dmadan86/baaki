/**
 * Loans (A48): money you owe or are owed, tracked with a running balance. A loan
 * carries its principal; each repayment is a normal ledger entry linked to it
 * ("Record payment" opens the entry form pre-linked), and what is left is the
 * principal less those payments. The editor is an inline sheet.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { Modal, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  encodeLoan,
  format,
  loanOutstanding,
  money,
  type LoanDirection,
  type PersonalLoan,
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
  SegmentedTabs,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import {
  todayIso,
  usePersonalLedger,
  useDeletePersonalRecord,
  useUpsertPersonalRecord,
} from '@/data/personal';
import { useDefaultCurrency } from '@/lib/currency';
import { useStrings } from '@/i18n';

export default function LoansScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const dc = useDefaultCurrency();
  const { loans, txns } = usePersonalLedger();

  const [today] = useState(() => todayIso());
  const [editing, setEditing] = useState<PersonalLoan | null>(null);
  const [creating, setCreating] = useState(false);

  const sorted = [...loans].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return a.startDate < b.startDate ? 1 : -1;
  });

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
          <Text variant="heading">{t.personal.loans}</Text>
        </View>
        <IconButton label={t.personal.addLoan} onPress={() => setCreating(true)}>
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
          {t.personal.loansSub}
        </Text>

        {sorted.length === 0 ? (
          <View style={{ paddingTop: theme.spacing.xxxl }}>
            <EmptyState title={t.personal.noLoans} />
          </View>
        ) : (
          sorted.map((loan) => {
            const left = loanOutstanding(loan, txns);
            const borrowed = loan.direction === 'borrowed';
            const settled = loan.status === 'closed' || left === 0n;
            return (
              <Card key={loan.id} style={{ gap: theme.spacing.sm }}>
                <Pressable accessibilityRole="button" onPress={() => setEditing(loan)}>
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
                      <Ionicons
                        name={borrowed ? 'arrow-down' : 'arrow-up'}
                        size={iconSize.md}
                        color={theme.color.brand}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="body" numberOfLines={1} style={{ fontWeight: '600' }}>
                        {loan.counterpart || (borrowed ? t.personal.borrowed : t.personal.lent)}
                      </Text>
                      <Text variant="micro" tone="muted">
                        {borrowed ? t.personal.borrowed : t.personal.lent} ·{' '}
                        {format(money(loan.principal, loan.currency), {
                          locale,
                          compactFraction: true,
                        })}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text variant="micro" tone="faint">
                        {settled ? t.personal.paidOff : t.personal.outstanding}
                      </Text>
                      <Text variant="body" style={{ fontWeight: '700' }}>
                        {format(money(left, loan.currency), { locale, compactFraction: true })}
                      </Text>
                    </View>
                  </Row>
                </Pressable>
                {!settled ? (
                  <>
                    <Divider />
                    <Button
                      label={t.personal.recordPayment}
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        router.push({
                          pathname: '/personal/entry',
                          params: { loanId: loan.id, kind: borrowed ? 'expense' : 'income' },
                        })
                      }
                    />
                  </>
                ) : null}
              </Card>
            );
          })
        )}
      </ScrollView>

      {creating ? (
        <LoanEditor currency={dc} today={today} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? (
        <LoanEditor loan={editing} currency={dc} today={today} onClose={() => setEditing(null)} />
      ) : null}
    </Screen>
  );
}

function LoanEditor({
  loan,
  currency,
  today,
  onClose,
}: {
  loan?: PersonalLoan;
  currency: string;
  today: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const upsert = useUpsertPersonalRecord();
  const remove = useDeletePersonalRecord();

  const [direction, setDirection] = useState<LoanDirection>(loan?.direction ?? 'borrowed');
  const [counterpart, setCounterpart] = useState(loan?.counterpart ?? '');
  const [principal, setPrincipal] = useState<bigint>(loan?.principal ?? 0n);
  const [note, setNote] = useState(loan?.note ?? '');
  const [startDate, setStartDate] = useState(loan?.startDate ?? today);
  const [showDate, setShowDate] = useState(false);
  const [closed, setClosed] = useState(loan?.status === 'closed');

  const canSave = principal > 0n && counterpart.trim().length > 0 && !upsert.isPending;

  const onSave = (): void => {
    if (!canSave) return;
    upsert.mutate(
      {
        recordId: loan?.id,
        recordKind: 'loan',
        data: encodeLoan({
          direction,
          counterpart: counterpart.trim(),
          principal,
          currency: loan?.currency ?? currency,
          note: note.trim() || null,
          startDate,
          status: closed ? 'closed' : 'active',
        }),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <View
          style={{
            backgroundColor: theme.color.surface,
            borderTopLeftRadius: theme.radius.xl,
            borderTopRightRadius: theme.radius.xl,
            maxHeight: '90%',
          }}
        >
          <ScrollView
            contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}
            keyboardShouldPersistTaps="handled"
          >
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="heading">{loan ? t.personal.editLoan : t.personal.addLoan}</Text>
              <IconButton label={t.common.close} onPress={onClose}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
            </Row>

            <SegmentedTabs
              value={direction}
              onChange={setDirection}
              tabs={[
                { value: 'borrowed', label: t.personal.borrowed },
                { value: 'lent', label: t.personal.lent },
              ]}
            />

            <View style={{ alignItems: 'center', paddingVertical: theme.spacing.md }}>
              <AmountField
                currency={loan?.currency ?? currency}
                value={principal}
                onChange={setPrincipal}
              />
            </View>

            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                {t.personal.counterpart}
              </Text>
              <TextInput
                value={counterpart}
                onChangeText={setCounterpart}
                placeholder={t.personal.counterpartPlaceholder}
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
              <Text variant="body">{startDate}</Text>
              <Ionicons name="calendar-outline" size={iconSize.md} color={theme.color.textMuted} />
            </Pressable>
            {showDate ? (
              <DateTimePicker
                value={new Date(`${startDate}T00:00:00`)}
                mode="date"
                onChange={(event, picked) => {
                  if (Platform.OS !== 'ios') setShowDate(false);
                  if (event.type === 'set' && picked)
                    setStartDate(picked.toISOString().slice(0, 10));
                }}
              />
            ) : null}

            {loan ? (
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Text variant="body">{t.personal.closeLoan}</Text>
                <Button
                  label={closed ? t.personal.reopenLoan : t.personal.closeLoan}
                  size="sm"
                  variant="secondary"
                  onPress={() => setClosed((prev) => !prev)}
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

            {loan ? (
              <Button
                label={t.common.delete}
                variant="danger"
                fullWidth
                onPress={() => remove.mutate(loan.id, { onSuccess: onClose })}
              />
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
