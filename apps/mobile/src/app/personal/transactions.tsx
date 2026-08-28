/**
 * The full personal ledger (A48): every entry, newest first, grouped by day.
 * Tapping one opens it to edit; the header "+" adds a new one.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, SectionList, View } from 'react-native';

import { format, money, type PersonalTxn } from '@waves/core';
import {
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { usePersonalLedger } from '@/data/personal';
import { useStrings } from '@/i18n';

export default function PersonalTransactionsScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { txns } = usePersonalLedger();

  // Group by day; the ledger already comes newest first, so days do too.
  const sections: { title: string; data: PersonalTxn[] }[] = [];
  for (const txn of txns) {
    const last = sections[sections.length - 1];
    if (last && last.title === txn.date) last.data.push(txn);
    else sections.push({ title: txn.date, data: [txn] });
  }

  const labelFor = (id: string | null): string | null =>
    id ? (t.categories[id as keyof typeof t.categories] ?? null) : null;

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
          <Text variant="heading">{t.personal.transactions}</Text>
        </View>
        <IconButton
          label={t.personal.add}
          onPress={() => router.push({ pathname: '/personal/entry', params: { kind: 'expense' } })}
        >
          <Ionicons name="add" size={iconSize.xxl} color={theme.color.brand} />
        </IconButton>
      </Row>

      <SectionList
        sections={sections}
        keyExtractor={(txn) => txn.id}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.sm,
        }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={{ paddingTop: theme.spacing.xxxl }}>
            <EmptyState title={t.personal.empty} />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text
            variant="micro"
            tone="faint"
            style={{
              letterSpacing: 0.8,
              paddingTop: theme.spacing.lg,
              paddingBottom: theme.spacing.xs,
            }}
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item: txn }) => {
          const income = txn.kind === 'income';
          const title = txn.note?.trim() || labelFor(txn.category) || '—';
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/personal/entry', params: { id: txn.id } })}
            >
              <Card
                padded={false}
                style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm }}
              >
                <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                  <CategoryBadge category={txn.category ?? 'other'} meta={null} size={32} />
                  <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
                    {title}
                  </Text>
                  <Text
                    variant="body"
                    style={{
                      fontWeight: '700',
                      color: income ? theme.color.positive : theme.color.text,
                    }}
                  >
                    {income ? '+' : '−'}
                    {format(money(txn.amount, txn.currency), { locale, compactFraction: true })}
                  </Text>
                </Row>
              </Card>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
