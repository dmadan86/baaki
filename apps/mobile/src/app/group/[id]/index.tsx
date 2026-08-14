import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { categoryOf } from '@baaki/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  directionalIcon,
  EmptyState,
  Fab,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SegmentedTabs,
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
import { DetailEnter } from '@/lib/anim';
import { CategoryBadge } from '@/components/Category';
import { GroupMenu } from '@/components/GroupMenu';
import { GroupPhoto } from '@/components/GroupPhoto';
import { PendingMark } from '@/components/PendingMark';
import { SyncBanner } from '@/components/SyncBanner';
import { usePullRefresh } from '@/lib/pullRefresh';

enum Tab {
  Expenses = 'expenses',
  Balances = 'balances',
  Activity = 'activity',
}

export default function GroupScreen() {
  const theme = useTheme();
  const pull = usePullRefresh();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>(Tab.Expenses);
  const [showDeleted, setShowDeleted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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
    return member ? displayName(member, profile?.id) : t.misc.someone;
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
  const inkMuted = theme.tint[tintForKey(groupId)].inkMuted;
  const visibleExpenses = expenses.rows.filter((expense) => showDeleted || !expense.deleted_at);
  // The show/hide-deleted toggle only earns its place once something has been
  // deleted. On a group whose ledger has never lost a row it is an answer to a
  // question nobody asked.
  const hasDeleted = expenses.rows.some((expense) => Boolean(expense.deleted_at));
  const pendingForMe = (settlements.data ?? []).filter(
    (settlement) =>
      settlement.status === 'initiated' && settlement.to_member_id === ledger.myMemberId,
  );

  return (
    <Screen>
      <DetailEnter>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: 180,
            gap: theme.spacing.xl,
          }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={pull.refreshing}
              onRefresh={pull.onRefresh}
              tintColor={theme.color.brand}
            />
          }
        >
          <Row style={{ paddingTop: theme.spacing.md, gap: theme.spacing.sm }}>
            {/* Just the arrow and its tap target — no chip behind it. */}
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel={t.common.back}
              hitSlop={10}
            >
              <Ionicons name={directionalIcon('chevron-back')} size={24} color={theme.color.text} />
            </Pressable>
            {/* The photo-and-name cluster is itself the way into settings, the
              way tapping a chat's title bar opens its info in WhatsApp — so the
              name is a tap target, not just a label above a menu. */}
            <Pressable
              onPress={() => router.push(`/group/${groupId}/settings`)}
              accessibilityRole="button"
              accessibilityLabel={t.group.settings}
              style={({ pressed }) => ({
                flex: 1,
                flexDirection: 'row',
                gap: theme.spacing.md,
                justifyContent: 'flex-start',
                alignItems: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
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
            </Pressable>
            {/* Planner, spending and settings live behind this one menu; planner
              only shows for a trip. Bare icon, no chip, to match the back
              arrow. */}
            <Pressable
              onPress={() => setMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t.group.more}
              hitSlop={10}
            >
              <Ionicons name="ellipsis-vertical" size={22} color={theme.color.text} />
            </Pressable>
          </Row>

          <GroupMenu
            groupId={groupId}
            isTrip={group.data.type === 'trip'}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
          />

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
              accessibilityLabel={fill(t.expense.splitBillA11y, {
                merchant: receipt.parsed?.merchant ?? t.expense.aBill,
              })}
              onPress={() => router.push(`/group/${groupId}/itemize?receipt=${receipt.id}`)}
            >
              <Card style={{ gap: theme.spacing.sm }}>
                <Row style={{ gap: theme.spacing.sm }}>
                  <Ionicons name="receipt-outline" size={18} color={theme.color.brand} />
                  <Text variant="subheading" style={{ flex: 1 }} numberOfLines={1}>
                    {receipt.parsed?.merchant ?? t.expense.aBill}
                  </Text>
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={18}
                    color={theme.color.textFaint}
                  />
                </Row>
                <Text variant="caption" tone="muted">
                  {receipt.claimed === 0
                    ? plural(locale, receipt.items, t.expense.receiptClaimedNone)
                    : fill(t.expense.receiptClaimedSome, {
                        claimed: receipt.claimed,
                        items: receipt.items,
                      })}
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
              <Text variant="caption" style={{ color: inkMuted }}>
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

            {/* Two equal-width pills on the tinted hero. Settle up stays the
                filled brand CTA; the simplify toggle uses the on-panel white
                treatment (white pill, brand label) so it reads on any tint
                instead of the muddy soft-purple secondary. A soft shadow lifts
                the white pill off the pastel. Reduced side padding keeps longer
                labels ("Who pays whom?") on one line at half width. */}
            <Row style={{ gap: theme.spacing.md }}>
              <Button
                label={t.settleUp}
                onPress={() => router.push(`/group/${groupId}/settle`)}
                icon={<Ionicons name="swap-horizontal" size={18} color={theme.color.onBrand} />}
                style={{ flex: 1, paddingHorizontal: theme.spacing.md }}
              />
              <Button
                label={group.data.simplify_debts ? t.simplify : t.whoPaysWhom}
                variant="onBrand"
                onPress={() => router.push(`/group/${groupId}/simplify`)}
                style={{ flex: 1, paddingHorizontal: theme.spacing.md, ...theme.shadow.soft }}
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

          {/* The page has three faces — expenses, balances, activity. This is a
              tab, not a choice on a form, so it wears the underlined tab look
              rather than the selection pills the rest of the app fills in. */}
          <SegmentedTabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { value: Tab.Expenses, label: t.expenses },
              { value: Tab.Balances, label: t.balances },
              { value: Tab.Activity, label: t.activity },
            ]}
          />

          {tab === Tab.Expenses && hasDeleted ? (
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

          {tab === Tab.Expenses ? (
            visibleExpenses.length === 0 ? (
              <EmptyState title={t.nothingYet} body={t.nothingYetBody} />
            ) : (
              <View style={{ gap: theme.spacing.md }}>
                {visibleExpenses.map((expense) => {
                  const version = expense.currentVersion;
                  const payer = version?.payers[0]?.member_id ?? null;
                  // Somebody disagreeing with an expense is worth seeing from the
                  // list. A disagreement you only find by opening the row is one
                  // that sits there unanswered.
                  const contested = openDisputes.has(expense.id);
                  // Each row is a card in its category's colour — the amount is a
                  // total, shown neutral in the tint's ink. A deleted row is dimmed
                  // rather than hidden, so the ledger stays visibly append-only.
                  const catTint = categoryOf(version?.category).tint;
                  const catInk = theme.tint[catTint].ink;
                  const catInkMuted = theme.tint[catTint].inkMuted;
                  const title = expenseTitle(version?.description, version?.category, t);
                  return (
                    <Pressable
                      key={expense.id}
                      onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={title}
                      style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
                    >
                      <TintCard
                        tint={catTint}
                        style={{
                          borderRadius: theme.radius.lg,
                          padding: theme.spacing.lg,
                          opacity: expense.deleted_at ? 0.55 : 1,
                        }}
                      >
                        <Row style={{ gap: theme.spacing.md }}>
                          <CategoryBadge category={version?.category} size={40} />
                          <View style={{ flex: 1 }}>
                            <Text variant="subheading" numberOfLines={1} style={{ color: catInk }}>
                              {`${title}${contested ? '  🚩' : ''}`}
                            </Text>
                            <Text
                              variant="caption"
                              numberOfLines={1}
                              style={{ color: catInkMuted }}
                            >
                              {[
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
                            </Text>
                          </View>
                          {version ? (
                            <Row style={{ gap: theme.spacing.sm }}>
                              <MoneyText
                                amount={BigInt(version.amount)}
                                currency={version.currency}
                                locale={locale}
                                tone="default"
                                style={{ color: catInk, fontWeight: '700' }}
                              />
                              {expense.pending ? <PendingMark /> : null}
                            </Row>
                          ) : null}
                        </Row>
                      </TintCard>
                    </Pressable>
                  );
                })}
              </View>
            )
          ) : null}

          {tab === Tab.Balances ? (
            <View style={{ gap: theme.spacing.md }}>
              {(members.data ?? []).map((member) => {
                // Each member is a card in the money colour for its meaning: mint
                // when they are owed, pink when they owe, lilac when square. The
                // balance is drawn in the pair's ink to stay legible on the tint.
                const balance = ledger.balances.get(member.id) ?? 0n;
                const rowTint = balance > 0n ? 'mint' : balance < 0n ? 'pink' : 'lilac';
                const rowInk = theme.tint[rowTint].ink;
                const rowInkMuted = theme.tint[rowTint].inkMuted;
                return (
                  <TintCard
                    key={member.id}
                    tint={rowTint}
                    style={{ borderRadius: theme.radius.lg, padding: theme.spacing.lg }}
                  >
                    <Row style={{ gap: theme.spacing.md }}>
                      <Avatar name={displayName(member)} ghost={isGhost(member)} size={40} />
                      <View style={{ flex: 1 }}>
                        <Row style={{ gap: theme.spacing.sm }}>
                          <Text
                            variant="subheading"
                            numberOfLines={1}
                            style={{ color: rowInk, flexShrink: 1 }}
                          >
                            {displayName(member, profile?.id)}
                          </Text>
                          {member.role === 'admin' && !isGhost(member) ? (
                            <Badge label={t.people.admin} tone="brand" />
                          ) : null}
                        </Row>
                        <Text variant="caption" numberOfLines={1} style={{ color: rowInkMuted }}>
                          {isGhost(member)
                            ? t.notJoinedYet
                            : (member.vpa ?? member.profile?.default_vpa ?? '—')}
                        </Text>
                      </View>
                      <Row style={{ gap: theme.spacing.sm }}>
                        <MoneyText
                          amount={balance}
                          currency={currency}
                          locale={locale}
                          mode="balance"
                          tone="default"
                          style={{ color: rowInk }}
                        />
                        {member.pending ? <PendingMark /> : null}
                      </Row>
                    </Row>
                  </TintCard>
                );
              })}
            </View>
          ) : null}

          {tab === Tab.Activity ? (
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
      </DetailEnter>
    </Screen>
  );
}
