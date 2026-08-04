import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

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

import { useStrings } from '@/i18n';
import { ME, getGroup, memberName } from '@/mocks/data';

type SplitKind = 'equal' | 'shares' | 'exact' | 'percent';

export default function AddExpenseScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const group = getGroup(id ?? '');

  const [amount, setAmount] = useState<bigint>(0n);
  const [description, setDescription] = useState('');
  const [splitKind, setSplitKind] = useState<SplitKind>('equal');
  const [payer, setPayer] = useState<MemberId>(ME);
  const [participants, setParticipants] = useState<MemberId[]>(
    group?.members.map((member) => member.id) ?? [],
  );

  // Live preview straight from the split engine — what you see here is exactly
  // what the server will recompute and store (TDR §4).
  const preview = useMemo(() => {
    if (!group || participants.length === 0 || amount === 0n) return null;
    const params: SplitParams =
      splitKind === 'equal'
        ? { kind: 'equal' }
        : splitKind === 'shares'
          ? {
              kind: 'shares',
              weights: Object.fromEntries(participants.map((member) => [member, 1])),
            }
          : splitKind === 'percent'
            ? {
                kind: 'percent',
                basisPoints: evenBasisPoints(participants),
              }
            : {
                kind: 'exact',
                amounts: Object.fromEntries(
                  computeShares({
                    amount,
                    currency: group.currency,
                    params: { kind: 'equal' },
                    participants,
                    seed: 'draft',
                  }),
                ),
              };

    return computeShares({
      amount,
      currency: group.currency,
      params,
      participants,
      seed: 'draft',
    });
  }, [amount, group, participants, splitKind]);

  if (!group) {
    return (
      <Screen>
        <EmptyState title="Group not found" body="It may have been archived." />
      </Screen>
    );
  }

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
            <Text variant="heading">{t.addExpense}</Text>
            <Text variant="micro" tone="muted">
              {group.name}
            </Text>
          </View>
          <IconButton label={t.scanBill}>
            <Ionicons name="scan-outline" size={20} color={theme.color.brand} />
          </IconButton>
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <AmountKeypad currency={group.currency} value={amount} onChange={setAmount} />
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
            {t.splitEqually}
          </Text>
          <ChipRow<SplitKind>
            value={splitKind}
            onChange={setSplitKind}
            options={[
              { value: 'equal', label: 'Equally' },
              { value: 'shares', label: 'Shares' },
              { value: 'exact', label: 'Exact' },
              { value: 'percent', label: 'Percent' },
            ]}
          />
        </View>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.paidBy}
          </Text>
          <Row style={{ flexWrap: 'wrap', gap: theme.spacing.md }}>
            {group.members.map((member) => (
              <Pressable
                key={member.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: payer === member.id }}
                accessibilityLabel={`${t.paidBy}: ${memberName(group, member.id)}`}
                onPress={() => setPayer(member.id)}
                style={{
                  alignItems: 'center',
                  gap: 4,
                  opacity: payer === member.id ? 1 : 0.45,
                }}
              >
                <Avatar name={member.name} emoji={member.emoji} ghost={member.ghost} />
                <Text variant="micro" tone={payer === member.id ? 'brand' : 'muted'}>
                  {member.id === ME ? 'You' : member.name}
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
              {participants.length} of {group.members.length}
            </Text>
          </Row>

          {group.members.map((member) => {
            const selected = participants.includes(member.id);
            return (
              <Pressable
                key={member.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={memberName(group, member.id)}
                onPress={() => toggleParticipant(member.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                }}
              >
                <Avatar name={member.name} emoji={member.emoji} ghost={member.ghost} size={38} />
                <Text variant="subheading" style={{ flex: 1 }}>
                  {member.id === ME ? 'You' : member.name}
                </Text>
                {preview && selected ? (
                  <MoneyText
                    amount={preview.get(member.id) ?? 0n}
                    currency={group.currency}
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

        <Button
          label={t.save}
          size="lg"
          fullWidth
          disabled={amount === 0n || participants.length === 0}
          onPress={() => router.back()}
        />

        <Text variant="micro" tone="faint" align="center">
          Drafts autosave locally, so a crash never costs you an entry.
        </Text>
      </ScrollView>
    </Screen>
  );
}

/** Even percentage split in basis points, remainder on the first member. */
function evenBasisPoints(members: readonly MemberId[]): Record<MemberId, number> {
  const each = Math.floor(10000 / members.length);
  const result: Record<MemberId, number> = {};
  members.forEach((member) => {
    result[member] = each;
  });
  const first = members[0];
  if (first) result[first] = each + (10000 - each * members.length);
  return result;
}
