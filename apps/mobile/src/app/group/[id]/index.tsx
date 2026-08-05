import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { RefreshControl, ScrollView, View } from 'react-native';

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

import {
  memberLookup,
  useConfirmSettlement,
  useGroup,
  useGroupLedger,
  useGroupRealtime,
} from '@/data/hooks';
import { displayName, isGhost } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { SyncBanner } from '@/components/SyncBanner';

type Tab = 'expenses' | 'balances' | 'activity';

export default function GroupScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>('expenses');
  const [showDeleted, setShowDeleted] = useState(false);

  // Live updates from the other devices in this group (TDR §1).
  useGroupRealtime(groupId);

  const { group, members, expenses, settlements, activity } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const confirmSettlement = useConfirmSettlement(groupId);

  const lookup = memberLookup(members.data);
  const nameOf = (memberId: string | null): string => {
    const member = memberId ? lookup.get(memberId) : undefined;
    return member ? displayName(member, profile?.id) : 'Someone';
  };

  if (group.isLoading) {
    return (
      <Screen>
        <View style={{ padding: theme.spacing.xl }}>
          <Text variant="caption" tone="muted">
            Loading…
          </Text>
        </View>
      </Screen>
    );
  }

  if (group.isError || !group.data) {
    return (
      <Screen>
        <EmptyState
          title="Group not found"
          body="It may have been archived, or you are no longer a member."
          action={<Button label="Back" onPress={() => router.back()} />}
        />
      </Screen>
    );
  }

  const currency = group.data.default_currency;
  const visibleExpenses = expenses.rows.filter((expense) => showDeleted || !expense.deleted_at);
  const pendingForMe = (settlements.data ?? []).filter(
    (settlement) =>
      settlement.status === 'initiated' && settlement.to_member_id === ledger.myMemberId,
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: 180,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={expenses.isFetching && !expenses.isLoading}
            onRefresh={() => {
              void expenses.refetch();
              void settlements.refetch();
              void activity.refetch();
            }}
            tintColor={theme.color.brand}
          />
        }
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading" numberOfLines={1}>
              {`${group.data.cover_emoji ?? '👥'}  ${group.data.name}`}
            </Text>
            <Text variant="micro" tone="muted">
              {`${members.data?.length ?? 0} ${t.members}`}
            </Text>
          </View>
          <IconButton
            label="Group settings"
            onPress={() => router.push(`/group/${groupId}/settings`)}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={theme.color.text} />
          </IconButton>
        </Row>

        <SyncBanner groupId={groupId} />

        {/* If the two independent balance computations ever disagree, say so
            rather than showing a number that might be wrong (ADR-004). */}
        {ledger.mismatch ? (
          <Card style={{ backgroundColor: theme.color.negativeSoft, gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="negative">
              Balances need a refresh
            </Text>
            <Text variant="caption" tone="muted">
              This device and the server disagree about this group&apos;s balances. Pull to refresh;
              if it persists, the ledger below is the source of truth.
            </Text>
          </Card>
        ) : null}

        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="muted">
              {ledger.myBalance >= 0n ? t.youAreOwed : t.youOwe}
            </Text>
            {ledger.pending !== 0n ? <Badge label={t.pendingConfirmation} tone="brand" /> : null}
          </Row>

          <MoneyText
            amount={ledger.myBalance}
            currency={currency}
            locale={locale}
            mode="balance"
            variant="display"
          />

          <Row style={{ gap: theme.spacing.md }}>
            <Button
              label={t.settleUp}
              onPress={() => router.push(`/group/${groupId}/settle`)}
              icon={<Ionicons name="swap-horizontal" size={18} color={theme.color.onBrand} />}
            />
            <Button
              label={group.data.simplify_debts ? t.simplify : t.whoPaysWhom}
              variant="secondary"
              onPress={() => router.push(`/group/${groupId}/simplify`)}
            />
          </Row>
        </Card>

        {pendingForMe.map((settlement) => (
          <Card key={settlement.id} style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">
              {`${nameOf(settlement.from_member_id)} says they paid you`}
            </Text>
            <MoneyText
              amount={BigInt(settlement.amount)}
              currency={settlement.currency}
              locale={locale}
              variant="title"
            />
            <Row style={{ gap: theme.spacing.md }}>
              <Button
                label="Confirm received"
                onPress={() => confirmSettlement.mutate(settlement.id)}
                disabled={confirmSettlement.isPending}
              />
              <Text variant="micro" tone="faint" style={{ flex: 1 }}>
                Auto-confirms in 7 days if nobody responds.
              </Text>
            </Row>
          </Card>
        ))}

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
          <Row style={{ justifyContent: 'flex-end', marginTop: -theme.spacing.md }}>
            <Text
              variant="caption"
              tone="muted"
              onPress={() => setShowDeleted((current) => !current)}
            >
              {showDeleted ? 'Hide deleted' : 'Show deleted'}
            </Text>
          </Row>
        ) : null}

        {tab === 'expenses' ? (
          visibleExpenses.length === 0 ? (
            <EmptyState title={t.nothingYet} body={t.nothingYetBody} />
          ) : (
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {visibleExpenses.map((expense, index) => {
                const version = expense.currentVersion;
                const payer = version?.payers[0]?.member_id ?? null;
                return (
                  <View key={expense.id}>
                    <ListRow
                      title={version?.description ?? 'Expense'}
                      subtitle={`${nameOf(payer)} paid · ${
                        version
                          ? new Intl.DateTimeFormat(locale, {
                              day: 'numeric',
                              month: 'short',
                            }).format(new Date(version.expense_date))
                          : ''
                      }${expense.deleted_at ? ' · deleted' : ''}${
                        (version?.version_no ?? 1) > 1
                          ? ` · edited ×${version!.version_no - 1}`
                          : ''
                      }`}
                      leading={
                        <Avatar
                          name={version?.category ?? version?.description ?? 'Expense'}
                          size={42}
                        />
                      }
                      onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
                      trailing={
                        version ? (
                          <MoneyText
                            amount={BigInt(version.amount)}
                            currency={version.currency}
                            locale={locale}
                          />
                        ) : null
                      }
                    />
                    {index < visibleExpenses.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                );
              })}
            </Card>
          )
        ) : null}

        {tab === 'balances' ? (
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {(members.data ?? []).map((member, index) => (
              <View key={member.id}>
                <ListRow
                  title={displayName(member, profile?.id)}
                  subtitle={
                    isGhost(member)
                      ? t.notJoinedYet
                      : (member.vpa ?? member.profile?.default_vpa ?? '—')
                  }
                  leading={<Avatar name={displayName(member)} ghost={isGhost(member)} />}
                  trailing={
                    <MoneyText
                      amount={ledger.balances.get(member.id) ?? 0n}
                      currency={currency}
                      locale={locale}
                      mode="balance"
                    />
                  }
                />
                {index < (members.data?.length ?? 0) - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        ) : null}

        {tab === 'activity' ? (
          (activity.data ?? []).length === 0 ? (
            <EmptyState
              title={t.nothingYet}
              body="Everything that happens here shows up in this feed."
            />
          ) : (
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {(activity.data ?? []).map((entry, index) => (
                <View key={entry.id}>
                  <ListRow
                    title={`${nameOf(entry.actor_member_id)} ${entry.verb} ${entry.object_type}`}
                    subtitle={new Intl.DateTimeFormat(locale, {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(entry.created_at))}
                    leading={<Avatar name={entry.verb} emoji={verbEmoji(entry.verb)} size={38} />}
                    trailing={
                      typeof entry.payload.amount === 'string' ? (
                        <MoneyText
                          amount={BigInt(entry.payload.amount)}
                          currency={(entry.payload.currency as string) ?? currency}
                          locale={locale}
                          variant="caption"
                        />
                      ) : null
                    }
                  />
                  {index < (activity.data?.length ?? 0) - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              ))}
            </Card>
          )
        ) : null}
      </ScrollView>

      <Fab
        label={t.addExpense}
        onPress={() => router.push(`/group/${groupId}/add-expense`)}
        icon={<Ionicons name="add" size={22} color={theme.color.onBrand} />}
      />
    </Screen>
  );
}

function verbEmoji(verb: string): string {
  switch (verb) {
    case 'added':
      return '🧾';
    case 'edited':
      return '✏️';
    case 'deleted':
      return '🗑️';
    case 'restored':
      return '↩️';
    case 'settled':
      return '💸';
    case 'confirmed':
      return '✅';
    case 'created':
      return '✨';
    default:
      return '•';
  }
}
