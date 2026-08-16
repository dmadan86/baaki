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
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
  useTheme,
  useScreenClearance,
} from '@baaki/ui';

import { useGroup, useGroupLedger, useSetMemberRole, useUpdateMember } from '@/data/hooks';
import { expenseTitle } from '@/data/expenseTitle';
import { displayName, groupLabel, isGhost } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function MemberScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id, memberId } = useLocalSearchParams<{ id: string; memberId: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const updateMember = useUpdateMember(groupId);
  const setRole = useSetMemberRole(groupId);

  const member = members.data?.find((row) => row.id === memberId);
  const isMe = member?.profile_id === profile?.id;
  const iAmAdmin = members.data?.find((row) => row.profile_id === profile?.id)?.role === 'admin';
  const currency = group.data?.default_currency ?? 'INR';

  const [name, setName] = useState(member?.ghost_name ?? '');
  const [vpa, setVpa] = useState(member?.vpa ?? '');
  const [status, setStatus] = useState<string | null>(null);

  // Seed the editors from the member the moment the query resolves, and again
  // if the row identity changes — synced in render (the app's idiom for
  // "follow a value until touched"), not in an effect, so it never triggers a
  // cascading-render lint or a frame of empty fields.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (member && seededId !== member.id) {
    setSeededId(member.id);
    setName(member.ghost_name ?? '');
    setVpa(member.vpa ?? '');
  }

  if (!member) {
    return (
      <Screen>
        <EmptyState title={t.people.memberNotFound} body={t.people.memberNotFoundBody} />
      </Screen>
    );
  }

  const ghost = isGhost(member);
  const vpaValid = vpa.trim() === '' || isValidVpa(vpa.trim());
  const balance = ledger.balances.get(member.id) ?? 0n;
  // The hero wears the money colour for its meaning — mint when this person is
  // owed, pink when they owe — and a neutral lilac when they are square, so a
  // settled member is never painted a direction they are not in. Ink from the
  // pair keeps the amount readable on the tint.
  const heroTint = balance > 0n ? 'mint' : balance < 0n ? 'pink' : 'lilac';
  const heroInk = theme.tint[heroTint].ink;

  // Expenses this person is actually part of.
  const involved = expenses.rows.filter((expense) =>
    expense.currentVersion?.shares.some((share) => share.member_id === member.id),
  );

  const save = (patch: { ghost_name?: string; vpa?: string | null }): void => {
    setStatus(null);
    updateMember.mutate(
      { memberId: member.id, patch },
      {
        onSuccess: () => setStatus(t.account.saved),
        onError: (caught) => setStatus(caught instanceof Error ? caught.message : String(caught)),
      },
    );
  };

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
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{displayName(member, profile?.id)}</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <TintCard
          tint={heroTint}
          style={{
            alignItems: 'center',
            gap: theme.spacing.sm,
            borderRadius: theme.radius.xl,
            padding: theme.spacing.xl,
          }}
        >
          <Avatar name={displayName(member)} ghost={ghost} size={78} />
          <MoneyText
            amount={balance}
            currency={currency}
            locale={locale}
            mode="balance"
            variant="title"
            tone="default"
            style={{ color: heroInk }}
          />
          <Row style={{ gap: theme.spacing.sm }}>
            {ghost ? <Badge label={t.notJoinedYet} /> : null}
            {member.role === 'admin' ? <Badge label={t.people.admin} tone="brand" /> : null}
            {isMe ? <Badge label={t.people.you} tone="positive" /> : null}
          </Row>
          {balance !== 0n && !isMe ? (
            <Button label={t.settleUp} onPress={() => router.push(`/group/${groupId}/settle`)} />
          ) : null}
        </TintCard>

        {ghost ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {t.common.name}
            </Text>
            <Row>
              <TextInput
                value={name}
                onChangeText={setName}
                accessibilityLabel={t.people.memberName}
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
                label={t.common.save}
                size="sm"
                variant="secondary"
                disabled={!name.trim() || name.trim() === member.ghost_name}
                onPress={() => save({ ghost_name: name.trim() })}
              />
            </Row>
            <Text variant="micro" tone="muted">
              {t.people.ghostNote}
            </Text>
          </Card>
        ) : null}

        {isMe ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {t.people.upiForGroup}
            </Text>
            <Row>
              <TextInput
                value={vpa}
                onChangeText={setVpa}
                autoCapitalize="none"
                accessibilityLabel={t.people.upiForGroup}
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
                label={t.common.save}
                size="sm"
                variant="secondary"
                disabled={!vpaValid || vpa.trim() === (member.vpa ?? '')}
                onPress={() => save({ vpa: vpa.trim() === '' ? null : vpa.trim() })}
              />
            </Row>
            <Text variant="micro" tone="muted">
              {t.people.upiForGroupNote}
            </Text>
          </Card>
        ) : null}

        {/* An admin can make another member an admin, or take it back — for
            anyone but themselves. A ghost still shows the card, but disabled
            with the reason: no account means nothing to act as an admin with,
            which the server enforces (GHOST_CANNOT_ADMIN). Showing it greyed
            beats hiding it, so the capability is discoverable rather than a
            secret. The server refuses demoting the last admin — the button
            offers it, the RPC is what actually keeps the rule. */}
        {iAmAdmin && !isMe ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="muted">
              {t.people.role}
            </Text>
            <Button
              label={member.role === 'admin' ? t.people.removeAdmin : t.people.makeAdmin}
              variant="secondary"
              disabled={ghost || setRole.isPending}
              onPress={() =>
                setRole.mutate(
                  {
                    memberId: member.id,
                    role: member.role === 'admin' ? 'member' : 'admin',
                  },
                  {
                    onSuccess: () => setStatus(t.account.saved),
                    onError: (caught) =>
                      setStatus(caught instanceof Error ? caught.message : String(caught)),
                  },
                )
              }
            />
            <Text variant="micro" tone="muted">
              {ghost ? t.people.adminNeedsAccount : t.people.adminNote}
            </Text>
          </Card>
        ) : null}

        {status ? (
          <Text variant="caption" tone={status === t.account.saved ? 'positive' : 'negative'}>
            {status}
          </Text>
        ) : null}

        <View>
          <SectionHeader title={plural(locale, involved.length, t.expense.inCount)} />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {involved.map((expense, index) => {
              const share = expense.currentVersion?.shares.find(
                (row) => row.member_id === member.id,
              );
              return (
                <View key={expense.id}>
                  <ListRow
                    title={expenseTitle(
                      expense.currentVersion?.description,
                      expense.currentVersion?.category,
                      t,
                    )}
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
