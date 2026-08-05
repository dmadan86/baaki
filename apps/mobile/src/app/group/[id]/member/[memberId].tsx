import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, TextInput, View } from 'react-native';

import { isValidVpa } from '@baaki/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { useGroup, useGroupLedger, useUpdateMember } from '@/data/hooks';
import { displayName, groupLabel, isGhost } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function MemberScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id, memberId } = useLocalSearchParams<{ id: string; memberId: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const updateMember = useUpdateMember(groupId);

  const member = members.data?.find((row) => row.id === memberId);
  const isMe = member?.profile_id === profile?.id;
  const currency = group.data?.default_currency ?? 'INR';

  const [name, setName] = useState(member?.ghost_name ?? '');
  const [vpa, setVpa] = useState(member?.vpa ?? '');
  const [status, setStatus] = useState<string | null>(null);

  if (!member) {
    return (
      <Screen>
        <EmptyState title="Member not found" body="They may have left the group." />
      </Screen>
    );
  }

  const ghost = isGhost(member);
  const vpaValid = vpa.trim() === '' || isValidVpa(vpa.trim());
  const balance = ledger.balances.get(member.id) ?? 0n;

  // Expenses this person is actually part of.
  const involved = expenses.rows.filter((expense) =>
    expense.currentVersion?.shares.some((share) => share.member_id === member.id),
  );

  const save = (patch: { ghost_name?: string; vpa?: string | null }): void => {
    setStatus(null);
    updateMember.mutate(
      { memberId: member.id, patch },
      {
        onSuccess: () => setStatus('Saved'),
        onError: (caught) => setStatus(caught instanceof Error ? caught.message : String(caught)),
      },
    );
  };

  return (
    <Screen>
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
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{displayName(member, profile?.id)}</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          <Avatar name={displayName(member)} ghost={ghost} size={78} />
          <MoneyText
            amount={balance}
            currency={currency}
            locale={locale}
            mode="balance"
            variant="title"
          />
          <Row style={{ gap: theme.spacing.sm }}>
            {ghost ? <Badge label={t.notJoinedYet} /> : null}
            {member.role === 'admin' ? <Badge label="admin" tone="brand" /> : null}
            {isMe ? <Badge label="you" tone="positive" /> : null}
          </Row>
          {balance !== 0n && !isMe ? (
            <Button label={t.settleUp} onPress={() => router.push(`/group/${groupId}/settle`)} />
          ) : null}
        </Card>

        {ghost ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              Name
            </Text>
            <Row>
              <TextInput
                value={name}
                onChangeText={setName}
                accessibilityLabel="Member name"
                placeholderTextColor={theme.color.textFaint}
                style={{
                  flex: 1,
                  fontSize: 18,
                  fontWeight: '600',
                  color: theme.color.text,
                  paddingVertical: theme.spacing.sm,
                }}
              />
              <Button
                label="Save"
                size="sm"
                variant="secondary"
                disabled={!name.trim() || name.trim() === member.ghost_name}
                onPress={() => save({ ghost_name: name.trim() })}
              />
            </Row>
            <Text variant="micro" tone="faint">
              This person holds real balances. When they join, they can claim this history.
            </Text>
          </Card>
        ) : null}

        {isMe ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              UPI ID for this group
            </Text>
            <Row>
              <TextInput
                value={vpa}
                onChangeText={setVpa}
                autoCapitalize="none"
                accessibilityLabel="UPI ID for this group"
                placeholder={profile?.default_vpa ?? 'you@bank'}
                placeholderTextColor={theme.color.textFaint}
                style={{
                  flex: 1,
                  fontSize: 18,
                  fontWeight: '600',
                  color: vpaValid ? theme.color.text : theme.color.negative,
                  paddingVertical: theme.spacing.sm,
                }}
              />
              <Button
                label="Save"
                size="sm"
                variant="secondary"
                disabled={!vpaValid || vpa.trim() === (member.vpa ?? '')}
                onPress={() => save({ vpa: vpa.trim() === '' ? null : vpa.trim() })}
              />
            </Row>
            <Text variant="micro" tone="faint">
              Overrides your account UPI ID here only — useful when one group settles to a different
              account.
            </Text>
          </Card>
        ) : null}

        {status ? (
          <Text variant="caption" tone={status === 'Saved' ? 'positive' : 'negative'}>
            {status}
          </Text>
        ) : null}

        <View>
          <SectionHeader title={`In ${involved.length} expenses`} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {involved.map((expense, index) => {
              const share = expense.currentVersion?.shares.find(
                (row) => row.member_id === member.id,
              );
              return (
                <View key={expense.id}>
                  <ListRow
                    title={expense.currentVersion?.description ?? 'Expense'}
                    subtitle={
                      expense.currentVersion
                        ? new Intl.DateTimeFormat(locale, {
                            day: 'numeric',
                            month: 'short',
                          }).format(new Date(expense.currentVersion.expense_date))
                        : undefined
                    }
                    leading={<Avatar name={expense.currentVersion?.description ?? '?'} size={38} />}
                    onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
                    trailing={
                      share ? (
                        <MoneyText
                          amount={BigInt(share.amount)}
                          currency={currency}
                          locale={locale}
                          variant="caption"
                        />
                      ) : null
                    }
                  />
                  {index < involved.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              );
            })}
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}
