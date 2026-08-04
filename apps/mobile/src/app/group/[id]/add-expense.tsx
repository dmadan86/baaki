import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { computeShares, type MemberId, type SplitParams } from '@baaki/core';
import {
  AmountKeypad,
  Avatar,
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

import { useGroup, useWriteExpense } from '@/data/hooks';
import { displayName, isGhost } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

type SplitKind = 'equal' | 'shares' | 'percent';

export default function AddExpenseScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id, expenseId } = useLocalSearchParams<{ id: string; expenseId?: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const writeExpense = useWriteExpense(groupId);

  const editing = expenses.data?.find((expense) => expense.id === expenseId);

  const [amount, setAmount] = useState<bigint>(0n);
  const [description, setDescription] = useState('');
  const [splitKind, setSplitKind] = useState<SplitKind>('equal');
  const [payer, setPayer] = useState<MemberId | null>(null);
  const [participants, setParticipants] = useState<MemberId[]>([]);
  const [error, setError] = useState<string | null>(null);

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
  );

  // Seed the form once the group has loaded: I paid, everyone splits — or the
  // current version's values when editing. Done during render (React's
  // "adjust state when the input changes" pattern) so the form never flashes
  // empty before the data arrives.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seedKey = members.data ? (editing?.currentVersion?.id ?? `new:${groupId}`) : null;
  if (seedKey && seedKey !== seededFor) {
    setSeededFor(seedKey);
    const version = editing?.currentVersion;
    if (version) {
      setAmount(BigInt(version.amount));
      setDescription(version.description);
      setPayer(version.payers[0]?.member_id ?? myMemberId);
      setParticipants(version.shares.map((share) => share.member_id));
      setSplitKind(
        version.split_type === 'percent'
          ? 'percent'
          : version.split_type === 'shares'
            ? 'shares'
            : 'equal',
      );
    } else {
      setParticipants((members.data ?? []).map((member) => member.id));
      setPayer(myMemberId);
    }
  }

  const currency = group.data?.default_currency ?? 'INR';

  const splitParams: SplitParams = useMemo(() => {
    if (splitKind === 'shares') {
      return { kind: 'shares', weights: Object.fromEntries(participants.map((id) => [id, 1])) };
    }
    if (splitKind === 'percent') {
      const each = Math.floor(10000 / Math.max(participants.length, 1));
      const basisPoints: Record<string, number> = {};
      participants.forEach((id) => {
        basisPoints[id] = each;
      });
      const first = participants[0];
      if (first) basisPoints[first] = each + (10000 - each * participants.length);
      return { kind: 'percent', basisPoints };
    }
    return { kind: 'equal' };
  }, [splitKind, participants]);

  // Preview with the same engine the server uses; if they ever disagree the
  // server wins and tells us why (SHARE_MISMATCH).
  const preview = useMemo(() => {
    if (participants.length === 0 || amount === 0n) return null;
    try {
      return computeShares({
        amount,
        currency,
        params: splitParams,
        participants,
        seed: expenseId ?? 'draft',
      });
    } catch {
      return null;
    }
  }, [amount, currency, splitParams, participants, expenseId]);

  if (group.isLoading || members.isLoading) {
    return (
      <Screen>
        <View style={{ padding: theme.spacing.xl }}>
          <ActivityIndicator color={theme.color.brand} />
        </View>
      </Screen>
    );
  }

  if (!group.data) {
    return (
      <Screen>
        <EmptyState title="Group not found" body="It may have been archived." />
      </Screen>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    if (!payer) {
      setError('Choose who paid');
      return;
    }
    try {
      await writeExpense.mutateAsync({
        expenseId: expenseId ?? undefined,
        description: description.trim() || 'Expense',
        expenseDate: new Date().toISOString().slice(0, 10),
        currency,
        amount,
        splitParams,
        participants,
        payers: { [payer]: amount },
        expectedShares: preview ? Object.fromEntries(preview) : undefined,
      });
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const toggleParticipant = (memberId: MemberId): void => {
    setParticipants((current) =>
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId],
    );
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Close" onPress={() => router.back()}>
            <Ionicons name="close" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{editing ? 'Edit expense' : t.addExpense}</Text>
            <Text variant="micro" tone="muted">
              {group.data.name}
            </Text>
          </View>
          {editing ? (
            <View style={{ width: 44 }} />
          ) : (
            <IconButton
              label="Split by item"
              onPress={() => router.replace(`/group/${groupId}/itemize`)}
            >
              <Ionicons name="list-outline" size={20} color={theme.color.brand} />
            </IconButton>
          )}
        </Row>

        {editing ? (
          <Card style={{ backgroundColor: theme.color.brandSoft }}>
            <Text variant="caption" tone="brand">
              Editing keeps the old version. Everyone can see what changed, and it can be restored.
            </Text>
          </Card>
        ) : null}

        <Card>
          <AmountKeypad currency={currency} value={amount} onChange={setAmount} />
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.description}
          </Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Beach shack dinner"
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel={t.description}
            style={{
              fontSize: 17,
              fontWeight: '600',
              color: theme.color.text,
              paddingVertical: theme.spacing.sm,
            }}
          />
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            How to split
          </Text>
          <ChipRow<SplitKind>
            value={splitKind}
            onChange={setSplitKind}
            options={[
              { value: 'equal', label: 'Equally' },
              { value: 'shares', label: 'Shares' },
              { value: 'percent', label: 'Percent' },
            ]}
          />
        </View>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.paidBy}
          </Text>
          <Row style={{ flexWrap: 'wrap', gap: theme.spacing.md }}>
            {(members.data ?? []).map((member) => (
              <Pressable
                key={member.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: payer === member.id }}
                accessibilityLabel={`${t.paidBy}: ${displayName(member, profile?.id)}`}
                onPress={() => setPayer(member.id)}
                style={{ alignItems: 'center', gap: 4, opacity: payer === member.id ? 1 : 0.45 }}
              >
                <Avatar name={displayName(member)} ghost={isGhost(member)} />
                <Text variant="micro" tone={payer === member.id ? 'brand' : 'muted'}>
                  {displayName(member, profile?.id)}
                </Text>
              </Pressable>
            ))}
          </Row>
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="muted">
              Split between
            </Text>
            <Text variant="micro" tone="muted">
              {`${participants.length} of ${members.data?.length ?? 0}`}
            </Text>
          </Row>

          {(members.data ?? []).map((member) => {
            const selected = participants.includes(member.id);
            return (
              <Pressable
                key={member.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={displayName(member, profile?.id)}
                onPress={() => toggleParticipant(member.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                }}
              >
                <Avatar name={displayName(member)} ghost={isGhost(member)} size={38} />
                <Text variant="subheading" style={{ flex: 1 }}>
                  {displayName(member, profile?.id)}
                </Text>
                {preview && selected ? (
                  <MoneyText
                    amount={preview.get(member.id) ?? 0n}
                    currency={currency}
                    locale={locale}
                    variant="caption"
                  />
                ) : null}
                <Ionicons
                  name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={22}
                  color={selected ? theme.color.brand : theme.color.textFaint}
                />
              </Pressable>
            );
          })}
        </Card>

        {error ? (
          <Text variant="caption" tone="negative">
            {error}
          </Text>
        ) : null}

        <Button
          label={editing ? 'Save changes' : t.save}
          size="lg"
          fullWidth
          disabled={amount === 0n || participants.length === 0 || writeExpense.isPending}
          onPress={() => void submit()}
        />

        {writeExpense.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}

        <Text variant="micro" tone="faint" align="center">
          The server recomputes every share before it is stored, so no device can push a wrong
          number into the ledger.
        </Text>
      </ScrollView>
    </Screen>
  );
}
