/**
 * Budgets (A48): a monthly cap on spending, overall or per category, with this
 * month's spend measured against it. Loan repayments do not count — a budget is
 * about everyday spending (see personalBudgetProgress). The editor is an inline
 * sheet.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { format, money, personalBudgetProgress, type PersonalBudget } from '@waves/core';
import {
  AmountField,
  Button,
  Card,
  directionalIcon,
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

import { CategoryBadge, CategoryPicker } from '@/components/Category';
import {
  todayIso,
  usePersonalLedger,
  useDeletePersonalRecord,
  useUpsertPersonalRecord,
} from '@/data/personal';
import { useDefaultCurrency } from '@/lib/currency';
import { useStrings } from '@/i18n';

export default function BudgetsScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const dc = useDefaultCurrency();
  const { budgets, txns } = usePersonalLedger();

  const [month] = useState(() => todayIso().slice(0, 7));
  const [editing, setEditing] = useState<PersonalBudget | null>(null);
  const [creating, setCreating] = useState(false);

  const labelFor = (id: string | null): string =>
    id ? (t.categories[id as keyof typeof t.categories] ?? id) : t.personal.overall;

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
          <Text variant="heading">{t.personal.budgets}</Text>
        </View>
        <IconButton label={t.personal.addBudget} onPress={() => setCreating(true)}>
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
          {t.personal.budgetsSub}
        </Text>

        {budgets.length === 0 ? (
          <View style={{ paddingTop: theme.spacing.xxxl }}>
            <EmptyState title={t.personal.noBudgets} />
          </View>
        ) : (
          budgets.map((budget) => {
            const progress = personalBudgetProgress(budget, txns, month);
            const over = progress.remaining < 0n;
            const pct = Math.min(1, Math.max(0, progress.ratio));
            const barColor = over
              ? theme.color.negative
              : pct > 0.85
                ? theme.color.warning
                : theme.color.brand;
            return (
              <Pressable
                key={budget.id}
                accessibilityRole="button"
                onPress={() => setEditing(budget)}
              >
                <Card style={{ gap: theme.spacing.sm }}>
                  <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                    <CategoryBadge category={budget.category ?? 'other'} meta={null} size={28} />
                    <Text variant="body" style={{ flex: 1, fontWeight: '600' }} numberOfLines={1}>
                      {labelFor(budget.category)}
                    </Text>
                    <Text variant="caption" tone={over ? 'negative' : 'muted'}>
                      {format(money(progress.spent, budget.currency), {
                        locale,
                        compactFraction: true,
                      })}
                      {' / '}
                      {format(money(budget.limit, budget.currency), {
                        locale,
                        compactFraction: true,
                      })}
                    </Text>
                  </Row>
                  <View
                    style={{
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: theme.color.surfaceMuted,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{ width: `${pct * 100}%`, height: 8, backgroundColor: barColor }}
                    />
                  </View>
                  <Text variant="micro" tone={over ? 'negative' : 'muted'}>
                    {over
                      ? `${format(money(-progress.remaining, budget.currency), { locale, compactFraction: true })} ${t.personal.over}`
                      : `${format(money(progress.remaining, budget.currency), { locale, compactFraction: true })} ${t.personal.left}`}
                  </Text>
                </Card>
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {creating ? <BudgetEditor currency={dc} onClose={() => setCreating(false)} /> : null}
      {editing ? (
        <BudgetEditor budget={editing} currency={dc} onClose={() => setEditing(null)} />
      ) : null}
    </Screen>
  );
}

function BudgetEditor({
  budget,
  currency,
  onClose,
}: {
  budget?: PersonalBudget;
  currency: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  const upsert = useUpsertPersonalRecord();
  const remove = useDeletePersonalRecord();

  const [scope, setScope] = useState<'overall' | 'category'>(
    budget?.category ? 'category' : 'overall',
  );
  const [category, setCategory] = useState<string | null>(budget?.category ?? null);
  const [limit, setLimit] = useState<bigint>(budget?.limit ?? 0n);

  const chosenCategory = scope === 'category' ? category : null;
  const canSave = limit > 0n && (scope === 'overall' || category !== null) && !upsert.isPending;

  const onSave = (): void => {
    if (!canSave) return;
    upsert.mutate(
      {
        recordId: budget?.id,
        recordKind: 'budget',
        data: {
          category: chosenCategory,
          limit: limit.toString(),
          currency: budget?.currency ?? currency,
        },
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
              <Text variant="heading">{budget ? t.personal.editBudget : t.personal.addBudget}</Text>
              <IconButton label={t.common.close} onPress={onClose}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
            </Row>

            <SegmentedTabs
              value={scope}
              onChange={setScope}
              tabs={[
                { value: 'overall', label: t.personal.overall },
                { value: 'category', label: t.personal.category },
              ]}
            />

            {scope === 'category' ? (
              <CategoryPicker value={category} onChange={(picked) => setCategory(picked)} />
            ) : null}

            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                {t.personal.monthlyLimit}
              </Text>
              <View style={{ alignItems: 'center', paddingVertical: theme.spacing.md }}>
                <AmountField
                  currency={budget?.currency ?? currency}
                  value={limit}
                  onChange={setLimit}
                />
              </View>
            </View>

            <Button
              label={t.personal.save}
              size="lg"
              fullWidth
              onPress={onSave}
              disabled={!canSave}
            />

            {budget ? (
              <Button
                label={t.common.delete}
                variant="danger"
                fullWidth
                onPress={() => remove.mutate(budget.id, { onSuccess: onClose })}
              />
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
