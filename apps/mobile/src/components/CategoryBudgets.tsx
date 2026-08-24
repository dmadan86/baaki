/**
 * Category budgets: a cap per category — food, stays, transport — beside the
 * overall and personal ones on the trip screen.
 *
 * Like the overall budget and unlike a personal one, a category cap is the
 * group's: an admin sets it, everyone sees it, and it lives on the group row
 * (ADR-005, offline through the mirror). "Spent" is never stored — it is the
 * ledger's own spend in that category, in that currency, never mixed across
 * currencies (ADR-004). A member who is not an admin sees the bars but cannot
 * move them; the RPC is what actually enforces that, not this component.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  budgetProgress,
  resolveCategory,
  spendByCategory,
  type CategorisedExpense,
} from '@waves/core';
import { AmountField, Button, Card, iconSize, MoneyText, Row, Text, useTheme } from '@waves/ui';
import { Pressable, View } from 'react-native';

import { CategoryBadge, CategoryPicker } from '@/components/Category';
import { useCategoryBudgets, useSetCategoryBudget } from '@/data/hooks';
import { friendlyError } from '@/lib/errors';
import { useStrings } from '@/i18n';

export function CategoryBudgets({
  groupId,
  currency,
  isAdmin,
  expenses,
}: {
  groupId: string;
  currency: string;
  isAdmin: boolean;
  expenses: readonly CategorisedExpense[];
}) {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const budgets = useCategoryBudgets(groupId);
  const setBudget = useSetCategoryBudget(groupId);

  const spend = spendByCategory(expenses);
  const rows = budgets.data ?? [];

  const [adding, setAdding] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [amount, setAmount] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = (id: string): string => {
    const resolved = resolveCategory(id, null);
    return resolved.custom ? id : t.categories[resolved.builtinId ?? 'other'];
  };

  const save = async (): Promise<void> => {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await setBudget.mutateAsync({ category, amountMinor: amount, currency });
      setAdding(false);
      setCategory(null);
      setAmount(0n);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'categoryBudget.save'));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (id: string): Promise<void> => {
    setError(null);
    try {
      await setBudget.mutateAsync({ category: id, amountMinor: null });
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'categoryBudget.clear'));
    }
  };

  // Nothing set and not an admin: the section would be an empty box. Hide it.
  if (rows.length === 0 && !isAdmin) return null;

  return (
    <Card style={{ gap: theme.spacing.md }}>
      <Text variant="subheading">{t.tripInsights.categoryBudgets}</Text>

      {error ? (
        <Text variant="caption" tone="negative">
          {error}
        </Text>
      ) : null}

      {rows.map((row) => {
        const progress = budgetProgress(
          { amountMinor: row.amountMinor, currency: row.currency },
          spend.get(row.category),
        );
        if (!progress) return null;
        const fill = Math.max(0, Math.min(1, progress.ratio));
        const color = progress.over ? theme.color.negative : theme.color.positive;
        const gap =
          progress.remainingMinor < 0n ? -progress.remainingMinor : progress.remainingMinor;
        return (
          <View key={row.category} style={{ gap: theme.spacing.xs }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Row style={{ gap: theme.spacing.sm, alignItems: 'center', flex: 1 }}>
                <CategoryBadge category={row.category} size={26} />
                <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>
                  {label(row.category)}
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
                {isAdmin ? (
                  <Pressable
                    onPress={() => void clear(row.category)}
                    accessibilityRole="button"
                    accessibilityLabel={`${t.clearBudget} — ${label(row.category)}`}
                    hitSlop={10}
                  >
                    <Ionicons name="close" size={iconSize.sm} color={theme.color.textFaint} />
                  </Pressable>
                ) : null}
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
      })}

      {isAdmin && adding ? (
        <View style={{ gap: theme.spacing.sm }}>
          <CategoryPicker value={category} onChange={(key) => setCategory(key)} />
          <AmountField currency={currency} value={amount} onChange={setAmount} />
          <Row style={{ gap: theme.spacing.sm }}>
            <Button
              label={t.saveBudget}
              size="sm"
              disabled={busy || !category}
              onPress={() => void save()}
            />
            <Button
              label={t.cancel}
              size="sm"
              variant="ghost"
              onPress={() => {
                setAdding(false);
                setCategory(null);
                setAmount(0n);
              }}
            />
          </Row>
        </View>
      ) : isAdmin ? (
        <Text variant="caption" tone="brand" onPress={() => setAdding(true)}>
          + {t.tripInsights.categoryBudgets}
        </Text>
      ) : null}
    </Card>
  );
}
