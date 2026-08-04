import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  ChipRow,
  EmptyState,
  Fab,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { ME, activityFeed, getGroup, ledgerFor, memberName } from '@/mocks/data';

type Tab = 'expenses' | 'balances' | 'activity';

export default function GroupScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('expenses');

  const group = getGroup(id ?? '');
  if (!group) {
    return (
      <Screen>
        <EmptyState title="Group not found" body="It may have been archived." />
      </Screen>
    );
  }

  const { myBalance, pending, balances } = ledgerFor(group);
  const feed = activityFeed(group.id);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: 180,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{`${group.emoji}  ${group.name}`}</Text>
            <Text variant="micro" tone="muted">
              {`${group.members.length} ${t.members}`}
            </Text>
          </View>
          <IconButton label="Group options">
            <Ionicons name="ellipsis-horizontal" size={20} color={theme.color.text} />
          </IconButton>
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="muted">
              {myBalance >= 0n ? t.youAreOwed : t.youOwe}
            </Text>
            {pending !== 0n ? <Badge label={t.pendingConfirmation} tone="brand" /> : null}
          </Row>

          <MoneyText
            amount={myBalance}
            currency={group.currency}
            locale={locale}
            mode="balance"
            variant="display"
          />

          <Row style={{ gap: theme.spacing.md }}>
            <Button
              label={t.settleUp}
              onPress={() => router.push(`/group/${group.id}/settle`)}
              icon={<Ionicons name="swap-horizontal" size={18} color={theme.color.onBrand} />}
            />
            <Button
              label={group.simplifyDebts ? t.simplify : t.whoPaysWhom}
              variant="secondary"
              onPress={() => router.push(`/group/${group.id}/simplify`)}
            />
          </Row>
        </Card>

        <ChipRow<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'expenses', label: t.expenses },
            { value: 'balances', label: t.balances },
            { value: 'activity', label: t.activity },
          ]}
        />

        {tab === 'expenses' ? (
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {group.expenses.map((expense, index) => {
              const payer = Object.keys(expense.payers)[0] ?? ME;
              return (
                <View key={expense.id}>
                  <ListRow
                    title={expense.description}
                    subtitle={`${memberName(group, payer)} paid · ${new Intl.DateTimeFormat(
                      locale,
                      { day: 'numeric', month: 'short' },
                    ).format(new Date(expense.date))}`}
                    leading={<Avatar name={expense.category} emoji={expense.emoji} size={42} />}
                    trailing={
                      <MoneyText
                        amount={expense.amount}
                        currency={group.currency}
                        locale={locale}
                      />
                    }
                  />
                  {index < group.expenses.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              );
            })}
          </Card>
        ) : null}

        {tab === 'balances' ? (
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {group.members.map((member, index) => (
              <View key={member.id}>
                <ListRow
                  title={member.id === ME ? 'You' : member.name}
                  subtitle={member.ghost ? t.notJoinedYet : (member.vpa ?? '—')}
                  leading={<Avatar name={member.name} emoji={member.emoji} ghost={member.ghost} />}
                  trailing={
                    <MoneyText
                      amount={balances.get(member.id) ?? 0n}
                      currency={group.currency}
                      locale={locale}
                      mode="balance"
                    />
                  }
                />
                {index < group.members.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        ) : null}

        {tab === 'activity' ? (
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {feed.map((entry, index) => (
              <View key={entry.id}>
                <ListRow
                  title={entry.title}
                  subtitle={entry.subtitle}
                  leading={<Avatar name={entry.title} emoji={entry.emoji} size={40} />}
                  trailing={
                    <MoneyText
                      amount={entry.amount}
                      currency={entry.currency}
                      locale={locale}
                      variant="caption"
                    />
                  }
                />
                {index < feed.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        ) : null}
      </ScrollView>

      <Fab
        label={t.addExpense}
        onPress={() => router.push(`/group/${group.id}/add-expense`)}
        icon={<Ionicons name="add" size={22} color={theme.color.onBrand} />}
      />
    </Screen>
  );
}
