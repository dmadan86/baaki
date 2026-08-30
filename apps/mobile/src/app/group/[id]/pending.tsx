import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import {
  Avatar,
  Button,
  Card,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import {
  memberLookup,
  useConfirmSettlement,
  useDisputeSettlement,
  useGroup,
  useGroupLedger,
} from '@/data/hooks';
import { useBlockedUsers } from '@/data/blocked';
import { displayName, isGhost, type SettlementRow } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

/**
 * Whole days left before a pending settlement auto-confirms — the 7-day window
 * the server's `baaki_auto_confirm_settlements` job enforces, counted from the
 * moment the payer recorded it. Never below one; a claim past the window is
 * auto-confirmed by the cron and has already left this list. (Mirrors the same
 * helper on the group screen's hero.)
 */
const AUTO_CONFIRM_DAYS = 7;
function daysToConfirm(initiatedIso: string, now: number = Date.now()): number {
  const parsed = Date.parse(initiatedIso);
  if (!Number.isFinite(parsed)) return AUTO_CONFIRM_DAYS;
  const left = AUTO_CONFIRM_DAYS * 86_400_000 - (now - parsed);
  return Math.max(1, Math.ceil(left / 86_400_000));
}

/**
 * The full list of "somebody says they paid you" claims, when there are enough
 * of them that swiping the hero deck one card at a time is the wrong tool. Each
 * row is a claim with its amount and the days left before it auto-confirms, and
 * the two answers — confirm receipt, or say it never reached you. Neither moves
 * a balance (a pending settlement is not counted as settled); both retire the
 * claim, so a row leaves this list the moment it is acted on and the header
 * count follows it down to the all-clear.
 */
export default function PendingConfirmationsScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, settlements } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const confirmSettlement = useConfirmSettlement(groupId);
  const disputeSettlement = useDisputeSettlement(groupId);
  const { blockedIds } = useBlockedUsers();

  const currency = group.data?.default_currency ?? 'INR';
  const lookup = memberLookup(members.data);
  const nameOf = (memberId: string | null): string => {
    const member = memberId ? lookup.get(memberId) : undefined;
    return member ? displayName(member, profile?.id, blockedIds, t.misc.someone) : t.misc.someone;
  };

  const pending: SettlementRow[] = (settlements.data ?? []).filter(
    (settlement) =>
      settlement.status === 'initiated' && settlement.to_member_id === ledger.myMemberId,
  );

  const total = pending.reduce((sum, settlement) => sum + BigInt(settlement.amount), 0n);
  const busy = confirmSettlement.isPending || disputeSettlement.isPending;

  const reject = (settlement: SettlementRow): void => {
    Alert.alert(
      t.group.rejectTitle,
      fill(t.group.rejectBody, { name: nameOf(settlement.from_member_id) }),
      [
        { text: t.group.keep, style: 'cancel' },
        {
          text: t.group.rejectConfirm,
          style: 'destructive',
          onPress: () => disputeSettlement.mutate(settlement.id),
        },
      ],
    );
  };

  const confirmAll = (): void => {
    Alert.alert(t.group.confirmAll, fill(t.group.confirmAllBody, { count: pending.length }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.group.confirmAll,
        onPress: () => pending.forEach((settlement) => confirmSettlement.mutate(settlement.id)),
      },
    ]);
  };

  return (
    <Screen>
      <View style={{ flex: 1, paddingHorizontal: theme.spacing.xl }}>
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.group.pendingTitle}</Text>
            {pending.length > 0 ? (
              <Row style={{ gap: theme.spacing.xs, alignItems: 'baseline' }}>
                <Text variant="micro" tone="muted">
                  {plural(locale, pending.length, t.group.claimsCount)} ·
                </Text>
                <MoneyText amount={total} currency={currency} locale={locale} variant="micro" />
              </Row>
            ) : null}
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <FlashList
          data={pending}
          extraData={`${locale}|${pending.length}`}
          keyExtractor={(settlement) => settlement.id}
          drawDistance={1500}
          contentContainerStyle={{ paddingTop: theme.spacing.xl, paddingBottom: clearance }}
          ItemSeparatorComponent={() => <View style={{ height: theme.spacing.md }} />}
          showsVerticalScrollIndicator={false}
          renderItem={({ item: settlement }) => {
            const member = lookup.get(settlement.from_member_id);
            return (
              <Card style={{ gap: theme.spacing.md }}>
                <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                  <Avatar
                    name={nameOf(settlement.from_member_id)}
                    ghost={member ? isGhost(member) : false}
                    size={44}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="subheading" numberOfLines={1}>
                      {nameOf(settlement.from_member_id)}
                    </Text>
                    <Row style={{ gap: theme.spacing.xs, alignItems: 'baseline' }}>
                      <MoneyText
                        amount={BigInt(settlement.amount)}
                        currency={settlement.currency}
                        locale={locale}
                        variant="caption"
                      />
                      <Text variant="micro" tone="muted">
                        ·{' '}
                        {plural(
                          locale,
                          daysToConfirm(settlement.initiated_at),
                          t.group.daysToConfirm,
                        )}
                      </Text>
                    </Row>
                  </View>
                </Row>
                <Row style={{ gap: theme.spacing.md }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={t.group.confirmReceived}
                      fullWidth
                      disabled={busy}
                      onPress={() => confirmSettlement.mutate(settlement.id)}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      label={t.group.rejectSettlement}
                      variant="secondary"
                      fullWidth
                      disabled={busy}
                      onPress={() => reject(settlement)}
                    />
                  </View>
                </Row>
              </Card>
            );
          }}
          ListHeaderComponent={
            pending.length > 1 ? (
              <View style={{ marginBottom: theme.spacing.md }}>
                <Button
                  label={t.group.confirmAll}
                  variant="secondary"
                  fullWidth
                  disabled={busy}
                  onPress={confirmAll}
                />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={{ paddingTop: theme.spacing.xxxl }}>
              <EmptyState
                title={t.allSettled}
                body={t.group.nobodyOwes}
                icon={
                  <Ionicons
                    name="checkmark-circle"
                    size={iconSize.xxl}
                    color={theme.color.positive}
                  />
                }
              />
              <View style={{ paddingTop: theme.spacing.xl, alignItems: 'center' }}>
                <Button label={t.common.done} variant="secondary" onPress={() => router.back()} />
              </View>
            </View>
          }
        />
      </View>
    </Screen>
  );
}
