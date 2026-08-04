import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, Linking, Pressable, ScrollView, View } from 'react-native';

import { allocateSettlement, buildUpiIntentUri, toMajorString, type MemberId } from '@baaki/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ChipRow,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { ME, getGroup, ledgerFor, memberById, receivablesBetween } from '@/mocks/data';

type Method = 'upi' | 'cash' | 'bank';

export default function SettleScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const group = getGroup(id ?? '');

  const counterparties = useMemo(() => {
    if (!group) return [];
    const { balances } = ledgerFor(group);
    // People I owe come first — that is the action Baaki wants to make easy.
    return group.members
      .filter((member) => member.id !== ME && (balances.get(member.id) ?? 0n) !== 0n)
      .sort((a, b) => Number((balances.get(b.id) ?? 0n) - (balances.get(a.id) ?? 0n)));
  }, [group]);

  const [selected, setSelected] = useState<MemberId | null>(counterparties[0]?.id ?? null);
  const [method, setMethod] = useState<Method>('upi');

  if (!group) {
    return (
      <Screen>
        <EmptyState title="Group not found" body="It may have been archived." />
      </Screen>
    );
  }

  const { balances } = ledgerFor(group);
  const myBalance = balances.get(ME) ?? 0n;
  const counterparty = selected ? memberById(group, selected) : undefined;
  const theirBalance = selected ? (balances.get(selected) ?? 0n) : 0n;

  // I pay them when I am negative and they are positive.
  const iPay = myBalance < 0n && theirBalance > 0n;
  const amount = iPay
    ? min(-myBalance, theirBalance)
    : min(myBalance, theirBalance < 0n ? -theirBalance : 0n);

  const receivables = selected
    ? receivablesBetween(group, iPay ? ME : selected, iPay ? selected : ME)
    : [];
  const allocation =
    amount > 0n && receivables.length > 0
      ? allocateSettlement({ amount }, receivables)
      : { allocations: [], unallocated: amount };

  const payViaUpi = async (): Promise<void> => {
    if (!counterparty?.vpa) {
      Alert.alert(
        'No UPI ID yet',
        `${counterparty?.name ?? 'They'} hasn't added a UPI ID. Baaki can nudge them to add one, or you can settle in cash.`,
      );
      return;
    }
    const uri = buildUpiIntentUri(
      {
        vpa: counterparty.vpa,
        payeeName: counterparty.name,
        amount,
        currency: group.currency,
        note: `Baaki ${group.name}`,
      },
      (value, currency) => toMajorString({ minor: value, currency }),
    );
    const canOpen = await Linking.canOpenURL(uri);
    if (canOpen) {
      await Linking.openURL(uri);
    } else {
      // iOS without a UPI app installed, or web: show the VPA to copy instead.
      Alert.alert('Pay to', `${counterparty.vpa}\n${uri}`);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Close" onPress={() => router.back()}>
            <Ionicons name="close" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.settleUp}</Text>
            <Text variant="micro" tone="muted">
              {group.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {counterparties.length === 0 ? (
          <EmptyState title={t.allSettled} body="Nobody owes anybody in this group." />
        ) : (
          <>
            <Card style={{ gap: theme.spacing.md }}>
              <Text variant="caption" tone="muted">
                With
              </Text>
              <Row style={{ flexWrap: 'wrap', gap: theme.spacing.lg }}>
                {counterparties.map((member) => (
                  <Pressable
                    key={member.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: selected === member.id }}
                    accessibilityLabel={member.name}
                    onPress={() => setSelected(member.id)}
                    style={{
                      alignItems: 'center',
                      gap: 4,
                      opacity: selected === member.id ? 1 : 0.45,
                    }}
                  >
                    <Avatar
                      name={member.name}
                      emoji={member.emoji}
                      ghost={member.ghost}
                      size={52}
                    />
                    <Text variant="micro" tone={selected === member.id ? 'brand' : 'muted'}>
                      {member.name}
                    </Text>
                  </Pressable>
                ))}
              </Row>
            </Card>

            <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                {iPay
                  ? `You pay ${counterparty?.name ?? ''}`
                  : `${counterparty?.name ?? ''} pays you`}
              </Text>
              <MoneyText
                amount={amount}
                currency={group.currency}
                locale={locale}
                variant="display"
              />
              <Badge label="Recorded, not moved by Baaki" />
            </Card>

            <View style={{ gap: theme.spacing.md }}>
              <ChipRow<Method>
                value={method}
                onChange={setMethod}
                options={[
                  { value: 'upi', label: t.payViaUpi },
                  { value: 'cash', label: t.paidInCash },
                  { value: 'bank', label: t.bankOther },
                ]}
              />
            </View>

            {allocation.allocations.length > 0 ? (
              <Card style={{ gap: theme.spacing.md }}>
                <Text variant="caption" tone="muted">
                  {t.perExpense}
                </Text>
                {allocation.allocations.map((entry) => {
                  const receivable = receivables.find((item) => item.expenseId === entry.expenseId);
                  return (
                    <Row key={entry.expenseId} style={{ justifyContent: 'space-between' }}>
                      <Row>
                        <Avatar
                          name={receivable?.description ?? 'Expense'}
                          emoji={receivable?.emoji}
                          size={34}
                        />
                        <Text variant="body">{receivable?.description ?? 'Expense'}</Text>
                      </Row>
                      <MoneyText
                        amount={entry.amount}
                        currency={group.currency}
                        locale={locale}
                        variant="caption"
                      />
                    </Row>
                  );
                })}
                {allocation.unallocated > 0n ? (
                  <Text variant="micro" tone="muted">
                    The rest applies to the overall balance, oldest expense first.
                  </Text>
                ) : null}
              </Card>
            ) : null}

            <Button
              label={
                method === 'upi' ? t.payViaUpi : method === 'cash' ? t.paidInCash : t.bankOther
              }
              size="lg"
              fullWidth
              disabled={amount === 0n}
              onPress={() => {
                if (method === 'upi' && iPay) void payViaUpi();
                else router.back();
              }}
              icon={
                method === 'upi' ? (
                  <Ionicons name="open-outline" size={18} color={theme.color.onBrand} />
                ) : undefined
              }
            />

            <Text variant="micro" tone="faint" align="center">
              {iPay
                ? `${counterparty?.name ?? 'They'} gets a notification to confirm. If nobody responds, Baaki auto-confirms after 7 days.`
                : 'You will be asked to confirm once they mark it paid.'}
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
