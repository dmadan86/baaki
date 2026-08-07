import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, View } from 'react-native';

import {
  allocateSettlement,
  buildPaymentUri,
  defaultRailFor,
  railById,
  railsFor,
  toMajorString,
  type MemberId,
  type Receivable,
} from '@baaki/core';
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

import { toSnapshot, useGroup, useGroupLedger, useRecordSettlement } from '@/data/hooks';
import { displayName, isGhost, payableAt, type MemberRow } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';


export default function SettleScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const recordSettlement = useRecordSettlement(groupId);

  const [selected, setSelected] = useState<MemberId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currency = group.data?.default_currency ?? 'INR';
  /**
   * Where this group settles decides what it can settle with. A group that
   * never said still gets bank, cash and the cross-border wallets — never an
   * empty list, because a group that cannot record a payment is not a group
   * anybody can use.
   */
  const country = group.data?.country_code ?? null;
  const rails = useMemo(() => railsFor(country), [country]);
  const [rail, setRail] = useState<string | null>(null);
  const method = rail ?? defaultRailFor(country);
  const myMemberId = ledger.myMemberId;

  const counterparties = useMemo(
    () =>
      (members.data ?? []).filter(
        (member) => member.id !== myMemberId && (ledger.balances.get(member.id) ?? 0n) !== 0n,
      ),
    [members.data, myMemberId, ledger.balances],
  );

  const counterparty: MemberRow | undefined =
    counterparties.find((member) => member.id === selected) ?? counterparties[0];

  const theirBalance = counterparty ? (ledger.balances.get(counterparty.id) ?? 0n) : 0n;
  const iPay = ledger.myBalance < 0n && theirBalance > 0n;
  const amount = counterparty
    ? iPay
      ? min(-ledger.myBalance, theirBalance)
      : min(ledger.myBalance, theirBalance < 0n ? -theirBalance : 0n)
    : 0n;

  // What the payer still owes the payee, expense by expense — the settle sheet
  // applies the payment against these oldest-first (ADR-007).
  const receivables: Receivable[] = useMemo(() => {
    if (!counterparty || !myMemberId) return [];
    const from = iPay ? myMemberId : counterparty.id;
    const to = iPay ? counterparty.id : myMemberId;
    return expenses.rows
      .map(toSnapshot)
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null)
      .map((snapshot) => {
        const owes = BigInt(snapshot.shares[from] ?? 0n);
        const paidByOther = BigInt(snapshot.payers[to] ?? 0n);
        const portion = owes > 0n && paidByOther > 0n ? (owes * paidByOther) / snapshot.amount : 0n;
        return { expenseId: snapshot.id, date: snapshot.date, amount: portion };
      })
      .filter((receivable) => receivable.amount > 0n);
  }, [expenses.rows, counterparty, myMemberId, iPay]);

  const allocation =
    amount > 0n && receivables.length > 0
      ? allocateSettlement({ amount }, receivables)
      : { allocations: [], unallocated: amount };

  const expenseTitle = (expenseId: string): string =>
    expenses.rows.find((expense) => expense.id === expenseId)?.currentVersion?.description ??
    'Expense';

  /**
   * Whether the button hands off to something before recording.
   *
   * Only when I am the one paying, and only on a rail that has somewhere to
   * send me — either an app to open or a handle to copy. Recording that
   * somebody *else* paid me never opens anything.
   */
  const handsOff = iPay && (railById(method)?.handle ?? 'none') !== 'none';

  const settleLabel = handsOff
    ? `Pay via ${railById(method)?.label ?? ''}`.trim()
    : method === 'cash'
      ? t.paidInCash
      : t.bankOther;

  const record = async (): Promise<void> => {
    if (!counterparty || !myMemberId || amount === 0n) return;
    setError(null);
    try {
      await recordSettlement.mutateAsync({
        groupId,
        fromMemberId: iPay ? myMemberId : counterparty.id,
        toMemberId: iPay ? counterparty.id : myMemberId,
        amount,
        rail: method,
        currency,
        allocations: allocation.allocations,
      });
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  /**
   * Hand off to their payment app if this rail has one, and otherwise show the
   * handle to copy.
   *
   * The second half is not a degraded case — it is the ordinary one. UPI is the
   * only rail with a scheme we can stand behind, so everywhere except India
   * this shows a Pix key or a mobile number and the person finishes in their
   * own bank app. Either way Baaki never moves the money (ADR-007); it records
   * that somebody says they did, and the person paid confirms it.
   */
  const payThen = async (): Promise<void> => {
    if (!counterparty) return;

    const payable = payableAt(counterparty);
    const railInfo = railById(method);

    if (!payable) {
      Alert.alert(
        `No ${railInfo?.label ?? 'payment'} details yet`,
        `${displayName(counterparty)} hasn't added how they're paid. Settle in cash, or ask them to add it.`,
      );
      return;
    }

    const uri = buildPaymentUri(
      {
        railId: payable.rail,
        handle: payable.handle,
        payeeName: displayName(counterparty),
        amount,
        currency,
        note: `Baaki ${group.data?.name ?? ''}`.trim(),
      },
      (value, code) => toMajorString({ minor: value, currency: code }),
    );

    const canOpen = uri ? await Linking.canOpenURL(uri).catch(() => false) : false;
    if (uri && canOpen) {
      await Linking.openURL(uri);
      Alert.alert('Did the payment go through?', 'Only record it if it actually completed.', [
        { text: 'No', style: 'cancel' },
        { text: 'Yes, record it', onPress: () => void record() },
      ]);
      return;
    }

    Alert.alert(
      `Pay ${displayName(counterparty)}`,
      `${railById(payable.rail)?.label ?? 'Send to'}\n${payable.handle}\n\nThen come back and record it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Record it', onPress: () => void record() },
      ],
    );
  };

  if (group.isLoading || members.isLoading) {
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
              {group.data?.name}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {counterparties.length === 0 || !counterparty ? (
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
                    accessibilityState={{ selected: counterparty.id === member.id }}
                    accessibilityLabel={displayName(member)}
                    onPress={() => setSelected(member.id)}
                    style={{
                      alignItems: 'center',
                      gap: 4,
                      opacity: counterparty.id === member.id ? 1 : 0.45,
                    }}
                  >
                    <Avatar name={displayName(member)} ghost={isGhost(member)} size={52} />
                    <Text variant="micro" tone={counterparty.id === member.id ? 'brand' : 'muted'}>
                      {displayName(member)}
                    </Text>
                  </Pressable>
                ))}
              </Row>
            </Card>

            <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                {iPay
                  ? `You pay ${displayName(counterparty)}`
                  : `${displayName(counterparty)} pays you`}
              </Text>
              <MoneyText amount={amount} currency={currency} locale={locale} variant="display" />
              <Badge label="Recorded, not moved by Baaki" />
            </Card>

            {/* Whatever this country pays with, best first. In India that is
                still UPI, cash, bank; in the UAE it is Aani, Wise, Revolut,
                bank, cash — the screen does not know the difference. */}
            <ChipRow<string>
              value={method}
              onChange={setRail}
              options={rails.map((entry) => ({ value: entry.id, label: entry.label }))}
            />

            {allocation.allocations.length > 0 ? (
              <Card style={{ gap: theme.spacing.md }}>
                <Text variant="caption" tone="muted">
                  {t.perExpense}
                </Text>
                {allocation.allocations.map((entry) => (
                  <Row key={entry.expenseId} style={{ justifyContent: 'space-between' }}>
                    <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
                      {expenseTitle(entry.expenseId)}
                    </Text>
                    <MoneyText
                      amount={entry.amount}
                      currency={currency}
                      locale={locale}
                      variant="caption"
                    />
                  </Row>
                ))}
                {allocation.unallocated > 0n ? (
                  <Text variant="micro" tone="muted">
                    The rest applies to the overall balance, oldest expense first.
                  </Text>
                ) : null}
              </Card>
            ) : null}

            {error ? (
              <Text variant="caption" tone="negative">
                {error}
              </Text>
            ) : null}

            <Button
              label={settleLabel}
              size="lg"
              fullWidth
              disabled={amount === 0n || recordSettlement.isPending}
              onPress={() => (handsOff ? void payThen() : void record())}
              icon={
                handsOff ? (
                  <Ionicons name="open-outline" size={18} color={theme.color.onBrand} />
                ) : undefined
              }
            />

            {recordSettlement.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}

            <Text variant="micro" tone="faint" align="center">
              {iPay
                ? `${displayName(counterparty)} gets asked to confirm. Nothing changes hands through Baaki.`
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
