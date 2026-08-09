import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  ChipRow,
  directionalIcon,
  EmptyState,
  Fab,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  Text,
  TintCard,
  tintForKey,
  useTheme,
} from '@baaki/ui';

import {
  memberLookup,
  useConfirmSettlement,
  useGroup,
  useDisputes,
  useGroupLedger,
  useGroupRealtime,
  useOpenReceipts,
} from '@/data/hooks';
import { describeActivity, verbEmoji } from '@/data/activity';
import { expenseTitle } from '@/data/expenseTitle';
import { GroupSkeleton } from '@/components/Skeletons';
import { actorName, displayName, groupLabel, isGhost } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { CategoryBadge } from '@/components/Category';
import { GroupPhoto } from '@/components/GroupPhoto';
import { PendingMark } from '@/components/PendingMark';
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
  const disputes = useDisputes(groupId);
  const openReceipts = useOpenReceipts(groupId);
  const openDisputes = new Set(
    (disputes.data ?? []).filter((row) => row.status === 'open').map((row) => row.expense_id),
  );
  const confirmSettlement = useConfirmSettlement(groupId);

  const lookup = memberLookup(members.data);
  const nameOf = (memberId: string | null): string => {
    const member = memberId ? lookup.get(memberId) : undefined;
    return member ? displayName(member, profile?.id) : 'Someone';
  };

  if (group.isLoading) {
    return <GroupSkeleton />;
  }

  if (group.isError || !group.data) {
    return (
      <Screen>
        <EmptyState
          title={t.group.notFound}
          body={t.group.notFoundBody}
          action={<Button label={t.common.back} onPress={() => router.back()} />}
        />
      </Screen>
    );
  }

  const currency = group.data.default_currency;
  // The balance hero wears the group's own colour — the same tint its card
  // shows on home. Ink for contrast; the sign lives in the label, not the hue.
  const ink = theme.tint[tintForKey(groupId)].ink;
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
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <Row style={{ flex: 1, gap: theme.spacing.md, justifyContent: 'center' }}>
            <GroupPhoto
              photoPath={group.data.photo_path}
              emoji={group.data.cover_emoji}
              size={38}
            />
            <View style={{ flexShrink: 1 }}>
              <Text variant="heading" numberOfLines={1}>
                {groupLabel(group.data, members.data ?? [], profile?.id)}
              </Text>
              <Text variant="micro" tone="muted">
                {plural(locale, members.data?.length ?? 0, t.memberCount)}
              </Text>
            </View>
          </Row>
          {/* Only where there is a trip to plan. A planner on a flatshare
              group is a tab nobody opens twice. */}
          {group.data.type === 'trip' ? (
            <IconButton label={t.plan} onPress={() => router.push(`/group/${groupId}/plan`)}>
              <Ionicons name="map-outline" size={19} color={theme.color.text} />
            </IconButton>
          ) : null}
          <IconButton label={t.spending} onPress={() => router.push(`/group/${groupId}/insights`)}>
            <Ionicons name="pie-chart-outline" size={19} color={theme.color.text} />
          </IconButton>
          <IconButton
            label={t.group.settings}
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
              {t.group.mismatch}
            </Text>
            <Text variant="caption" tone="muted">
              {t.group.mismatchBody}
            </Text>
          </Card>
        ) : null}

        {/* A bill somebody at this table scanned and shared. Without this the
            second person has no way to reach it, and the claims CRDT is
            plumbing with no tap. */}
        {(openReceipts.data ?? []).map((receipt) => (
          <Pressable
            key={receipt.id}
            accessibilityRole="button"
            accessibilityLabel={`Split ${receipt.parsed?.merchant ?? 'the bill'} by item`}
            onPress={() => router.push(`/group/${groupId}/itemize?receipt=${receipt.id}`)}
          >
            <Card style={{ gap: theme.spacing.sm }}>
              <Row style={{ gap: theme.spacing.sm }}>
                <Ionicons name="receipt-outline" size={18} color={theme.color.brand} />
                <Text variant="subheading" style={{ flex: 1 }} numberOfLines={1}>
                  {receipt.parsed?.merchant ?? 'A bill'}
                </Text>
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={18}
                  color={theme.color.textFaint}
                />
              </Row>
              <Text variant="caption" tone="muted">
                {receipt.claimed === 0
                  ? `${receipt.items} lines, nobody has claimed one yet. Tap what you had.`
                  : `${receipt.claimed} of ${receipt.items} lines claimed. Tap what you had.`}
              </Text>
            </Card>
          </Pressable>
        ))}

        <TintCard
          tint={tintForKey(groupId)}
          style={{
            borderRadius: theme.radius.xl,
            padding: theme.spacing.xl,
            gap: theme.spacing.lg,
          }}
        >
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" style={{ color: ink, opacity: 0.8 }}>
              {ledger.myBalance >= 0n ? t.youAreOwed : t.youOwe}
            </Text>
            {ledger.pending !== 0n ? <Badge label={t.pendingConfirmation} tone="brand" /> : null}
          </Row>

          {/* mode="balance" keeps the spoken "You are owed ₹X" label and the
              absolute value; the colour is overridden to ink for the surface. */}
          <MoneyText
            amount={ledger.myBalance}
            currency={currency}
            locale={locale}
            mode="balance"
            variant="display"
            tone="default"
            style={{ color: ink }}
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
        </TintCard>

        {pendingForMe.map((settlement) => (
          <Card key={settlement.id} style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">
              {`${nameOf(settlement.from_member_id)} says they paid you`}
            </Text>
            <Row style={{ gap: theme.spacing.sm }}>
              <MoneyText
                amount={BigInt(settlement.amount)}
                currency={settlement.currency}
                locale={locale}
                variant="title"
              />
              {settlement.pending ? <PendingMark size={16} /> : null}
            </Row>
            <Row style={{ gap: theme.spacing.md }}>
              <Button
                label={t.group.confirmReceived}
                onPress={() => confirmSettlement.mutate(settlement.id)}
                disabled={confirmSettlement.isPending}
              />
              <Text variant="micro" tone="faint" style={{ flex: 1 }}>
                {t.group.autoConfirms}
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
              {showDeleted ? t.group.hideDeleted : t.group.showDeleted}
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
                // Somebody disagreeing with an expense is worth seeing from the
                // list. A disagreement you only find by opening the row is one
                // that sits there unanswered.
                const contested = openDisputes.has(expense.id);
                return (
                  <View key={expense.id}>
                    <ListRow
                      title={`${expenseTitle(version?.description, version?.category, t)}${
                        contested ? '  🚩' : ''
                      }`}
                      subtitle={[
                        fill(t.expense.paidByName, { name: nameOf(payer) }),
                        version
                          ? new Intl.DateTimeFormat(locale, {
                              day: 'numeric',
                              month: 'short',
                            }).format(new Date(version.expense_date))
                          : null,
                        expense.deleted_at ? t.expense.deleted : null,
                        (version?.version_no ?? 1) > 1
                          ? plural(locale, version!.version_no - 1, t.expense.editedTimes)
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      leading={<CategoryBadge category={version?.category} size={42} />}
                      onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
                      trailing={
                        version ? (
                          <Row style={{ gap: theme.spacing.sm }}>
                            <MoneyText
                              amount={BigInt(version.amount)}
                              currency={version.currency}
                              locale={locale}
                            />
                            {expense.pending ? <PendingMark /> : null}
                          </Row>
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
                    <Row style={{ gap: theme.spacing.sm }}>
                      <MoneyText
                        amount={ledger.balances.get(member.id) ?? 0n}
                        currency={currency}
                        locale={locale}
                        mode="balance"
                      />
                      {member.pending ? <PendingMark /> : null}
                    </Row>
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
            <EmptyState title={t.nothingYet} body={t.group.activityEmptyBody} />
          ) : (
            <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
              {(activity.data ?? []).map((entry, index) => (
                <View key={entry.id}>
                  <ListRow
                    title={describeActivity(entry, profile?.id ?? null)}
                    subtitle={new Intl.DateTimeFormat(locale, {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(entry.created_at))}
                    leading={
                      <Avatar
                        name={actorName(entry.actor, profile?.id ?? null)}
                        emoji={verbEmoji(entry.verb)}
                        size={38}
                      />
                    }
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
