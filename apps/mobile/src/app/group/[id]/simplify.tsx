import { useCallback, useMemo } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams } from 'expo-router';
import { Pressable, RefreshControl, View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
  useTabBarClearance,
} from '@waves/ui';

import {
  BalanceDirection,
  format as formatMoney,
  money as coreMoney,
  type CurrencyCode,
} from '@waves/core';

import { memberLookup, useGhostMergePersonIds, useGroup, useGroupLedger } from '@/data/hooks';
import { useBlockedUsers } from '@/data/blocked';
import { personKeyOf } from '@/data/peopleBalances';
import {
  displayName,
  groupLabel,
  isBlockedMember,
  isGhost,
  isViewer,
  type MemberRow,
} from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useViewerId } from '@/lib/auth';
import { router } from '@/lib/navigation';
import { usePullRefresh } from '@/lib/pullRefresh';
import { SimplifySide, simplifyItems, type SimplifyItem } from '@/lib/simplifyRows';

/**
 * One proposed payment.
 *
 * The row used to carry both people's avatars, an arrow between them, *and* the
 * sentence naming them — three sayings of one fact competing for the width of a
 * phone. The sentence lost every time: every row on a real group read "Renny
 * pays .Rvs …", which is the one thing this screen exists to tell you. So the
 * pair of avatars is gone and the sentence is what survives: one avatar for the
 * person the row is about, the words in full over two lines if they need them,
 * and never an ellipsis through somebody's name.
 *
 * The amount is coloured only when the reader is on the row — red when they are
 * handing it over, the owed-to-you blue when they are receiving it. A payment
 * between two other people belongs to neither of them from here, so it stays
 * the neutral ink an expense total wears.
 */
function TransferRow({
  sentence,
  avatarName,
  ghost,
  amount,
  currency,
  locale,
  direction,
  isLast,
  onPress,
  openHint,
}: {
  sentence: string;
  avatarName: string;
  ghost: boolean;
  amount: bigint;
  currency: CurrencyCode;
  locale: string;
  /** Set only on the reader's own rows; null leaves the amount neutral. */
  direction: BalanceDirection | null;
  isLast: boolean;
  onPress?: () => void;
  openHint: string;
}) {
  const theme = useTheme();

  const money = (
    <MoneyText
      amount={amount}
      currency={currency}
      locale={locale}
      mode={direction === null ? 'plain' : 'balance'}
      direction={direction ?? undefined}
    />
  );

  const body = (
    <Row
      style={{
        gap: theme.spacing.md,
        alignItems: 'center',
        paddingVertical: theme.spacing.md,
        // The row is a touch target as a whole, so it holds the 44pt floor even
        // on the shortest sentence.
        minHeight: 44,
      }}
    >
      <Avatar name={avatarName} ghost={ghost} size={40} />
      <View style={{ flex: 1 }}>
        <Text variant="subheading" numberOfLines={2}>
          {sentence}
        </Text>
      </View>
      {money}
      {/* A fixed slot at the trailing edge whether or not this row leads
          anywhere, so the amounts stay in one column instead of sliding across
          on the rows that have no chevron. The glyph itself flips with the
          writing direction. */}
      <View style={{ width: iconSize.md, alignItems: 'center' }}>
        {onPress ? (
          <Ionicons
            name={directionalIcon('chevron-forward')}
            size={iconSize.md}
            color={theme.color.textFaint}
          />
        ) : null}
      </View>
    </Row>
  );

  return (
    <View>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          // Making the row one control groups its text, so everything worth
          // hearing has to be said here: the sentence, then the amount in the
          // words `MoneyText` would have spoken on its own.
          accessibilityLabel={`${sentence}. ${formatMoney(coreMoney(amount, currency), { locale })}`}
          accessibilityHint={openHint}
          onPress={onPress}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {!isLast ? <View style={{ height: 1, backgroundColor: theme.color.border }} /> : null}
    </View>
  );
}

export default function SimplifyScreen() {
  const theme = useTheme();
  // `useTabBarClearance`, not `useScreenClearance`: the app's bottom bar is
  // rendered once at the root and stays over pushed screens too, and this route
  // is not one of the few it hides on (`TAB_BAR_HIDDEN_ROUTES`). With the plain
  // system inset the last proposed payment sat behind the bar — on a screen
  // whose rows have just become tappable, an unreachable row is a row that does
  // not work.
  const clearance = useTabBarClearance();
  const pull = usePullRefresh();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  // Identity for "which member am I", from the session rather than the profile:
  // the session is on the device at launch, the profile is a fetch that lands
  // later, and in the gap `profile?.id` is undefined — which `isViewer` refuses
  // to match, but only if it is given the right thing to compare. See
  // `lib/auth.useViewerId`.
  const viewerId = useViewerId();

  const { group, members } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, viewerId);
  const { blockedIds } = useBlockedUsers();
  const mergePersonIds = useGhostMergePersonIds();
  const lookup = useMemo(() => memberLookup(members.data), [members.data]);

  // Never "You": the three sentences below already have their own you-forms,
  // and "You pays Ravi" is not a sentence in any of the four languages. A
  // blocked person keeps the ghost name they wear everywhere else (A62), and it
  // travels into the destination so that screen never flashes the real one.
  const nameOf = useCallback(
    (memberId: string): string => {
      const member = lookup.get(memberId);
      return member ? displayName(member, null, blockedIds, t.misc.someone) : t.misc.someone;
    },
    [blockedIds, lookup, t.misc.someone],
  );

  // Where a row goes when it is tapped: the person on it who is not you, one
  // screen up from this group — every group you share with them.
  //
  // The key has to be spelled the way the database spells it (`personKeyOf` is
  // the same COALESCE the `waves_person_group_balances` view keys on), or the
  // tap points at a stranger's ledger. Null means the row leads nowhere and
  // must not look as though it does: yourself, and a member who exists only in
  // the local queue and whose id the server has never seen.
  const personKeyFor = useCallback(
    (member: MemberRow | undefined): string | null => {
      if (!member) return null;
      if (member.id === ledger.myMemberId) return null;
      if (isViewer(member, viewerId)) return null;
      if (member.pending) return null;
      return personKeyOf({
        profileId: member.profile_id,
        mergePersonId: mergePersonIds.get(member.id) ?? null,
        memberId: member.id,
      });
    },
    [ledger.myMemberId, mergePersonIds, viewerId],
  );

  const items = useMemo(
    () => simplifyItems(ledger.transfers, ledger.myMemberId),
    [ledger.myMemberId, ledger.transfers],
  );

  const renderItem = useCallback(
    ({ item }: { item: SimplifyItem }) => {
      if (item.kind === 'heading') {
        return (
          <View style={{ paddingTop: theme.spacing.lg }}>
            <SectionHeader
              title={item.section === 'yours' ? t.simplifyYourPayments : t.simplifyOtherPayments}
            />
          </View>
        );
      }

      const { transfer, side, personId, isLast } = item;
      const person = lookup.get(personId);
      const personName = nameOf(personId);
      // Three sentences for three positions, rather than one sentence with the
      // reader's name dropped into it. `youPayName` and `namePaysYou` are the
      // settle screen's own words, so the screen that proposes a payment and
      // the screen that records it say the same thing.
      const sentence =
        side === SimplifySide.YouPay
          ? fill(t.youPayName, { name: personName })
          : side === SimplifySide.YouReceive
            ? fill(t.namePaysYou, { name: personName })
            : fill(t.simplifyPaysWhom, {
                from: nameOf(transfer.from),
                to: nameOf(transfer.to),
              });
      const personKey = personKeyFor(person);

      return (
        <TransferRow
          sentence={sentence}
          avatarName={personName}
          ghost={Boolean(person && (isGhost(person) || isBlockedMember(person, blockedIds)))}
          amount={transfer.amount}
          currency={transfer.currency as CurrencyCode}
          locale={locale}
          direction={
            side === SimplifySide.YouPay
              ? BalanceDirection.YouOwe
              : side === SimplifySide.YouReceive
                ? BalanceDirection.OwedToYou
                : null
          }
          isLast={isLast}
          openHint={t.people.seeSharedGroups}
          onPress={
            personKey
              ? () =>
                  router.push(
                    `/friends/person/${encodeURIComponent(personKey)}?name=${encodeURIComponent(
                      personName,
                    )}` as never,
                  )
              : undefined
          }
        />
      );
    },
    [blockedIds, locale, lookup, nameOf, personKeyFor, t, theme.spacing.lg],
  );

  return (
    <Screen>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.whoPaysWhom}</Text>
          <Text variant="micro" tone="muted" numberOfLines={1}>
            {/* `groupLabel`, not `group.name`: a group nobody named is called
                after the people in it everywhere else in the app, and an empty
                line under the title reads as a screen that failed to load. */}
            {groupLabel(group.data, members.data ?? [], viewerId)}
          </Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      {/* The same recycled list the group ledger uses. A pairwise group of
          thirty people proposes a few hundred payments, and mounting all of them
          at once was the other half of why this screen felt heavy. */}
      <FlashList
        data={items}
        // A row's destination is not in its own data — it comes from who you are
        // in this group, from the ghost merges on this phone, and from who you
        // have blocked — so those go here, or a recycled row keeps whatever
        // tappability and whatever name it was first drawn with.
        extraData={`${locale}|${ledger.myMemberId ?? ''}|${mergePersonIds.size}|${blockedIds.size}`}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        // Render well beyond the viewport so a fast fling never outruns
        // recycling into blank rows (the default 250px is cleared in a frame).
        drawDistance={1500}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.color.brand}
          />
        }
        ListHeaderComponent={
          <View style={{ paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
            <Card style={{ gap: theme.spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text variant="subheading">
                  {group.data?.simplify_debts ? t.simplifyOn : t.simplifyOff}
                </Text>
                <Badge
                  label={plural(locale, ledger.transfers.length, t.simplifyPaymentsCount)}
                  tone="brand"
                />
              </Row>
              <Text variant="caption" tone="muted">
                {group.data?.simplify_debts ? t.simplifySuggestBody : t.simplifyPairwiseBody}
              </Text>
            </Card>
          </View>
        }
        ListEmptyComponent={<EmptyState title={t.allSettled} body={t.group.nobodyOwes} />}
      />
    </Screen>
  );
}
