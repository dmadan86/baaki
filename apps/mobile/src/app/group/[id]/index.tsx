import { useCallback, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, RefreshControl, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import {
  Avatar,
  Badge,
  Button,
  Card,
  directionalIcon,
  EmptyState,
  Gradient,
  iconSize,
  MoneyText,
  Row,
  Screen,
  SegmentedTabs,
  Text,
  useTheme,
  useScreenClearance,
} from '@waves/ui';

import {
  memberLookup,
  useConfirmSettlement,
  useGroup,
  useDisputes,
  useGroupLedger,
  useGroupRealtime,
  useOpenReceipts,
} from '@/data/hooks';
import { describeActivity, parseMoney, relativeTime, verbIcon, verbTint } from '@/data/activity';
import { nudgeToSettle } from '@/data/api';
import { expenseTitle } from '@/data/expenseTitle';
import { GroupSkeleton } from '@/components/Skeletons';
import { formatParts, type MemberId } from '@waves/core';
import { useBlockedUsers } from '@/data/blocked';
import {
  displayName,
  groupLabel,
  isBlockedMember,
  isGhost,
  type ActivityActor,
  type ExpenseRow,
  type ExpenseVersionRow,
} from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { CategoryBadge } from '@/components/Category';
import { OverflowMenu, type OverflowMenuItem } from '@/components/OverflowMenu';
import { GroupPhoto } from '@/components/GroupPhoto';
import { PendingMark } from '@/components/PendingMark';
import { SettlementProof } from '@/components/SettlementProof';
import { SyncBanner, SyncStatusIcon } from '@/components/SyncBanner';
import { useSync } from '@/sync';
import { usePullRefresh } from '@/lib/pullRefresh';

enum Tab {
  Expenses = 'expenses',
  Balances = 'balances',
  Activity = 'activity',
}

/**
 * The nudge on a balances row, for somebody who owes this group money.
 *
 * The same one-a-day server rule the Friends tab leans on (ADR-010), and the
 * same manner: once tapped it stops offering, and a rate limit reads as "already
 * nudged today" rather than as an error. Nobody should be told off for asking.
 */
/**
 * One round translucent action on the group hero — a white glyph on a dim
 * white disc, the same on-panel circle the dashboard hero uses. Icon-only;
 * its name rides on the accessibility label.
 */
function HeroActionCircle({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: 23,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.xl} color={theme.color.onBrand} />
    </Pressable>
  );
}

function RemindChip({
  groupId,
  memberId,
  currency,
}: {
  groupId: string;
  memberId: MemberId;
  currency: string;
}) {
  const { t } = useStrings();
  const [note, setNote] = useState<string | null>(null);

  const nudge = useMutation({
    mutationFn: () => nudgeToSettle({ groupId, toMemberId: memberId, currency }),
    onSuccess: () => setNote(t.people.reminded),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setNote(message.includes('NUDGE_RATE_LIMIT') ? t.people.remindedToday : t.loadError);
    },
  });

  if (note) {
    return (
      <Text variant="micro" tone="muted">
        {note}
      </Text>
    );
  }

  return (
    <Pressable
      onPress={() => nudge.mutate()}
      disabled={nudge.isPending}
      accessibilityRole="button"
      accessibilityLabel={t.people.remind}
      hitSlop={10}
      style={({ pressed }) => ({ opacity: pressed || nudge.isPending ? 0.6 : 1 })}
    >
      <Badge label={t.people.remind} tone="brand" />
    </Pressable>
  );
}

/**
 * What one expense did to one person's balance — what they put in beyond their
 * own share (positive: they lent), or their share of what somebody else put in
 * (negative: they borrowed).
 *
 * `null` means they are in neither column: an expense between other people in
 * the group. That is a blank on the row, not a zero — a zero would read as "you
 * are square on this one", which is a different sentence.
 */
function myStake(
  version: ExpenseVersionRow | null | undefined,
  memberId: MemberId | null,
): bigint | null {
  if (!version || !memberId) return null;
  const paid = version.payers.find((row) => row.member_id === memberId)?.amount;
  const share = version.shares.find((row) => row.member_id === memberId)?.amount;
  if (paid === undefined && share === undefined) return null;
  return BigInt(paid ?? 0) - BigInt(share ?? 0);
}

/**
 * One section of the expense feed: the expenses that fall in a single calendar
 * month, kept in the order they already arrive in. `date` is a specimen date
 * from the section, `null` for the bucket of rows with no version yet (nothing
 * to date). A month heading is what turns a long ledger from a wall of rows into
 * something you can skim — the pattern every bill-splitting app in the category
 * (Splitwise, Settle Up, Tricount) leans on.
 */
interface ExpenseSection<T> {
  readonly key: string;
  readonly date: string | null;
  readonly rows: readonly T[];
}

/**
 * Cluster the feed into month sections without reordering within a month. The
 * list arrives newest-added first; we bucket by the month of each expense's
 * date so all of November sits together under one heading, in first-seen order,
 * rather than repeating the heading every time the created-order interleaves two
 * months. Undated rows (no current version) fall into their own leading bucket.
 */
function groupExpensesByMonth<T extends { currentVersion: ExpenseVersionRow | null }>(
  items: readonly T[],
): ExpenseSection<T>[] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const date = item.currentVersion?.expense_date ?? null;
    // "YYYY-MM" groups a calendar month; "~" is the sortless bucket for the rare
    // undated row, kept out of the way at its natural position.
    const key = date ? date.slice(0, 7) : '~';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(item);
  }
  return order.map((key) => {
    const rows = buckets.get(key)!;
    return { key, date: rows[0]?.currentVersion?.expense_date ?? null, rows };
  });
}

/**
 * A month heading — "November", or "November 2024" once the year is not this
 * one. The date is a plain calendar date (no zone), so it is read in UTC to
 * match the day the rest of the feed prints beside each expense.
 */
function monthLabel(locale: string, isoDate: string, now: number = Date.now()): string {
  const parsed = Date.parse(isoDate);
  if (!Number.isFinite(parsed)) return isoDate;
  const when = new Date(parsed);
  const sameYear = when.getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(when);
}

/**
 * One row of the virtualized expense feed. The feed used to render every expense
 * a group ever had at once inside a ScrollView; on a long-lived group that mounts
 * hundreds of rows on open. Flattening the month sections into a single typed list
 * lets FlashList recycle rows so only what is on screen is mounted — a `month`
 * item is the section heading, an `expense` item is one bill.
 */
type FeedItem =
  | { readonly kind: 'month'; readonly key: string; readonly date: string }
  | {
      readonly kind: 'expense';
      readonly key: string;
      readonly expense: ExpenseRow;
      readonly isLast: boolean;
    };

export default function GroupScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const clearance = useScreenClearance(112);
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
  // The refused-change state still needs somewhere to act (retry / discard), so
  // the header glyph is paired with the one banner that carries buttons; the
  // ambient offline / syncing states are the header glyph's job now (below).
  const { rejected } = useSync();

  const { group, members, expenses, settlements, activity } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const disputes = useDisputes(groupId);
  const openReceipts = useOpenReceipts(groupId);
  const openDisputes = useMemo(
    () =>
      new Set(
        (disputes.data ?? []).filter((row) => row.status === 'open').map((row) => row.expense_id),
      ),
    [disputes.data],
  );
  const confirmSettlement = useConfirmSettlement(groupId);

  const { blockedIds } = useBlockedUsers();
  const lookup = useMemo(() => memberLookup(members.data), [members.data]);
  const nameOf = useCallback(
    (memberId: string | null): string => {
      const member = memberId ? lookup.get(memberId) : undefined;
      return member ? displayName(member, profile?.id, blockedIds, t.misc.someone) : t.misc.someone;
    },
    [blockedIds, lookup, profile?.id, t.misc.someone],
  );
  // The joined actor an activity row would carry on the cross-group feed, rebuilt
  // from this group's members — so the mirror-backed group feed can name who did
  // the thing rather than falling back to "someone".
  const actorFor = useCallback(
    (memberId: string | null): ActivityActor | null => {
      const member = memberId ? lookup.get(memberId) : undefined;
      if (!member) return null;
      return {
        id: member.id,
        profile_id: member.profile_id,
        ghost_name: member.ghost_name,
        profile: member.profile ? { display_name: member.profile.display_name } : null,
      };
    },
    [lookup],
  );

  if (group.isLoading) {
    return <GroupSkeleton />;
  }

  if (group.isError || !group.data) {
    // A group can vanish for ordinary reasons — archived, left, a link that has
    // gone stale — so this is a place to step back from, not a crash. It wears
    // the shape the category's own not-found screens use: an escape at the top,
    // a soft-tinted tile so the state looks like the app rather than a failure,
    // and the one way out as a full-width bar under the thumb rather than a pill
    // adrift in the middle of the page.
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={{ flex: 1, paddingHorizontal: theme.spacing.xl }}>
          <Row style={{ paddingTop: theme.spacing.md }}>
            {/* Never a dead control: a cold open from a notification or a stale
                invite link has no history to pop, so the chevron falls back to
                home rather than silently doing nothing. */}
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              accessibilityRole="button"
              accessibilityLabel={t.common.back}
              hitSlop={10}
            >
              <Ionicons
                name={directionalIcon('chevron-back')}
                size={iconSize.xxl}
                color={theme.color.text}
              />
            </Pressable>
          </Row>

          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.md,
            }}
          >
            {/* Decorative: the title carries the meaning. A tile the size of a
                group cover, in the soft brand tint the app uses for its empty
                states. */}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={{
                width: 96,
                height: 96,
                borderRadius: theme.radius.xl,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.color.buttonPrimary,
                marginBottom: theme.spacing.sm,
              }}
            >
              <Ionicons name="compass-outline" size={48} color={theme.color.onBrand} />
            </View>
            <Text variant="title" align="center" accessibilityRole="header">
              {t.group.notFound}
            </Text>
            <Text variant="body" tone="muted" align="center">
              {t.group.notFoundBody}
            </Text>
          </View>

          {/* The reliable way out. This state is most often reached by following
              a link to a group that has gone, where there is no back stack — so
              the primary action goes home for certain, the way join.tsx does. */}
          <Button
            label={t.misc.goToBaaki}
            onPress={() => router.replace('/')}
            fullWidth
            style={{ marginBottom: theme.spacing.xl }}
          />
        </View>
      </Screen>
    );
  }

  const groupData = group.data;
  const currency = groupData.default_currency;
  // The hero panel wears its verdict, the same rule the dashboard hero follows:
  // a blue wash when the group owes you, a red one when you owe it, the brand
  // indigo when all is settled. Every stop is dark enough to hold the white
  // balance and its labels; the sign lives in the words, not just the hue.
  const heroGradient =
    ledger.myBalance > 0n
      ? theme.gradient.positive
      : ledger.myBalance < 0n
        ? theme.gradient.negative
        : theme.gradient.brand;
  const visibleExpenses = expenses.rows.filter((expense) => showDeleted || !expense.deleted_at);
  // The show/hide-deleted toggle only earns its place once something has been
  // deleted. On a group whose ledger has never lost a row it is an answer to a
  // question nobody asked.
  const hasDeleted = expenses.rows.some((expense) => Boolean(expense.deleted_at));
  // The feed, cut into month sections for skimming (Splitwise/Settle Up).
  const expenseSections = groupExpensesByMonth(visibleExpenses);
  // A refused change waiting on this group — the one sync state that still earns
  // an inline card, because it needs a decision the header glyph cannot offer.
  const refusedHere = rejected.some((item) => item.groupId === groupId);
  const pendingForMe = (settlements.data ?? []).filter(
    (settlement) =>
      settlement.status === 'initiated' && settlement.to_member_id === ledger.myMemberId,
  );
  // The other side of the same coin: settlements I said I made that the payee
  // has not yet confirmed. These earn their own card so the payer has somewhere
  // to attach a payment proof — and simply to be told their claim is in flight,
  // which the app never acknowledged before.
  const pendingByMe = (settlements.data ?? []).filter(
    (settlement) =>
      settlement.status === 'initiated' && settlement.from_member_id === ledger.myMemberId,
  );

  // The overflow: the same three-dot dropdown the dashboard uses, not a bottom
  // sheet, so the two headers behave alike. Planner only appears where there is
  // a trip to plan; a flatshare has no use for the row.
  const menuItems: OverflowMenuItem[] = [
    { icon: 'pie-chart-outline', label: t.spending, route: `/group/${groupId}/insights` },
    ...(groupData.type === 'trip'
      ? [
          {
            icon: 'map-outline',
            label: t.plan,
            route: `/group/${groupId}/plan`,
          } as OverflowMenuItem,
        ]
      : []),
    { icon: 'settings-outline', label: t.group.settings, route: `/group/${groupId}/settings` },
  ];

  // The month sections flattened into one recyclable list: a heading item per
  // month, then its expense rows. FlashList mounts only what is on screen, so a
  // group with a thousand bills opens as fast as one with ten.
  const feedItems: FeedItem[] = [];
  for (const section of expenseSections) {
    if (section.date) {
      feedItems.push({ kind: 'month', key: `month-${section.key}`, date: section.date });
    }
    section.rows.forEach((expense, index) =>
      feedItems.push({
        kind: 'expense',
        key: expense.id,
        expense,
        isLast: index === section.rows.length - 1,
      }),
    );
  }

  const renderExpenseRow = (expense: ExpenseRow, isLast: boolean) => {
    const version = expense.currentVersion;
    const payer = version?.payers[0]?.member_id ?? null;
    // An imported Splitwise expense can have several payers, so
    // "Asha paid ₹1,200" beside the expense total would put the
    // whole bill on whoever happens to sort first. One payer is
    // named and credited with what they actually put in; several
    // are counted, and the number beside them is the total they
    // put in between them.
    const payerCount = version?.payers.length ?? 0;
    const paidLine =
      version === null
        ? fill(t.expense.paidByName, { name: nameOf(payer) })
        : fill(t.expense.paidByNameAmount, {
            name: payerCount > 1 ? plural(locale, payerCount, t.misc.peopleCount) : nameOf(payer),
            amount: formatParts(
              {
                minor:
                  payerCount > 1
                    ? BigInt(version.amount)
                    : BigInt(version.payers[0]?.amount ?? version.amount),
                currency: version.currency,
              },
              { locale },
            ).text,
          });
    // What this one expense did to *your* balance: what you put in
    // beyond your share (you lent), or your share of what somebody
    // else put in (you borrowed). The row used to end in the
    // expense total, which is the group's number and never the
    // answer to the question somebody opens a ledger with. The
    // total keeps its place in the subtitle.
    const stake = myStake(version, ledger.myMemberId);
    // Somebody disagreeing with an expense is worth seeing from the
    // list. A disagreement you only find by opening the row is one
    // that sits there unanswered.
    const contested = openDisputes.has(expense.id);
    // Flat row: the category is the badge on the left, not the row's
    // colour. A deleted row is dimmed rather than hidden, so the
    // ledger stays visibly append-only.
    const title = expenseTitle(version?.description, version?.category, t, version?.category_meta);
    return (
      <View>
        <Pressable
          onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
          accessibilityRole="button"
          accessibilityLabel={contested ? `${title}, ${t.expense.disputed}` : title}
          style={({ pressed }) => ({
            opacity: pressed ? 0.6 : expense.deleted_at ? 0.55 : 1,
          })}
        >
          <Row
            style={{
              gap: theme.spacing.md,
              alignItems: 'center',
              paddingVertical: theme.spacing.md,
            }}
          >
            <CategoryBadge
              category={version?.category}
              meta={version?.category_meta}
              description={version?.description}
              size={40}
            />
            <View style={{ flex: 1 }}>
              <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                <Text variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {title}
                </Text>
                {contested ? <Badge label={t.expense.disputed} tone="negative" /> : null}
              </Row>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {[
                  paidLine,
                  version
                    ? new Intl.DateTimeFormat(locale, {
                        day: 'numeric',
                        month: 'short',
                        timeZone: 'UTC',
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
              <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text variant="micro" tone="muted">
                    {stake === null
                      ? t.expense.notInvolved
                      : stake > 0n
                        ? t.expense.youLent
                        : stake < 0n
                          ? t.expense.youBorrowed
                          : t.allSettled}
                  </Text>
                  {stake !== null && stake !== 0n ? (
                    <MoneyText
                      amount={stake}
                      currency={version.currency}
                      locale={locale}
                      mode="balance"
                      style={{ fontWeight: '700' }}
                    />
                  ) : null}
                </View>
                {expense.pending ? <PendingMark /> : null}
              </Row>
            ) : null}
          </Row>
        </Pressable>
        {!isLast ? <View style={{ height: 1, backgroundColor: theme.color.border }} /> : null}
      </View>
    );
  };

  // A month heading or an expense row. Headings carry the between-section gap the
  // ScrollView used to give for free; the first item needs none, its space comes
  // from the header block above it.
  const renderFeedItem = ({ item, index }: { item: FeedItem; index: number }) =>
    item.kind === 'month' ? (
      <Text
        variant="micro"
        tone="muted"
        style={{
          marginTop: index === 0 ? 0 : theme.spacing.xl,
          marginBottom: theme.spacing.xs,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}
      >
        {monthLabel(locale, item.date)}
      </Text>
    ) : (
      renderExpenseRow(item.expense, item.isLast)
    );

  return (
    <Screen edges={[]}>
      {/* The hero runs dark under the status bar; force light icons for it. */}
      <StatusBar style="light" />
      {/* No entrance re-animation: the screen already slides in natively, and a
          second scale-up on top of that read as an unwanted zoom. */}
      <View style={{ flex: 1 }}>
        <FlashList
          data={tab === Tab.Expenses ? feedItems : []}
          extraData={`${tab}|${showDeleted}|${locale}`}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          renderItem={renderFeedItem}
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
            <View style={{ marginBottom: theme.spacing.xl }}>
              {/* The group hero, built like the dashboard's: one saturated panel
                  running edge to edge and up under the status bar, carrying the
                  top controls, the balance, and its two actions on the group's
                  verdict colour. It breaks out of the list's horizontal padding
                  with a negative margin, then re-pads itself, and rounds only its
                  bottom corners so it reads as the top of the screen. */}
              <Gradient
                radius={0}
                colors={heroGradient}
                style={{
                  marginHorizontal: -theme.spacing.xl,
                  paddingTop: insets.top + theme.spacing.md,
                  paddingHorizontal: theme.spacing.xl,
                  // Match the dashboard hero's bottom padding so the three heroes
                  // are the same height (dashboard is lg, not xl).
                  paddingBottom: theme.spacing.lg,
                  borderBottomLeftRadius: theme.radius.xxl,
                  borderBottomRightRadius: theme.radius.xxl,
                  gap: theme.spacing.xl,
                }}
              >
                <Row style={{ gap: theme.spacing.sm }}>
                  {/* Just the arrow and its tap target — no chip behind it. */}
                  <Pressable
                    onPress={() => router.back()}
                    accessibilityRole="button"
                    accessibilityLabel={t.common.back}
                    hitSlop={10}
                  >
                    <Ionicons
                      name={directionalIcon('chevron-back')}
                      size={iconSize.xxl}
                      color={theme.color.onBrand}
                    />
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
                      <Text variant="heading" tone="onBrand" numberOfLines={1}>
                        {groupLabel(group.data, members.data ?? [], profile?.id)}
                      </Text>
                      <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }}>
                        {plural(locale, members.data?.length ?? 0, t.memberCount)}
                      </Text>
                    </View>
                  </Pressable>
                  {/* The sync state as one glyph, the same control the dashboard header
              carries: a quiet cloud for unsent changes or no connection, a
              turning arrow mid-sync, a red mark for a refused change — nothing
              when all is well. It replaces the wide banner this screen used to
              stack under the header. */}
                  <SyncStatusIcon onBrand groupId={groupId} />
                  {/* A code to hand the group across the table. The whole invite
              surface — link, share sheet and the QR to point a camera at — lives
              one tap behind this, so it is the fast way to get somebody in
              without typing a thing. */}
                  <Pressable
                    onPress={() => router.push(`/group/${groupId}/invite`)}
                    accessibilityRole="button"
                    accessibilityLabel={t.people.inviteTitle}
                    hitSlop={10}
                  >
                    <Ionicons
                      name="qr-code-outline"
                      size={iconSize.xl}
                      color={theme.color.onBrand}
                    />
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
                    <Ionicons
                      name="ellipsis-vertical"
                      size={iconSize.xl}
                      color={theme.color.onBrand}
                    />
                  </Pressable>
                </Row>

                {/* The balance — the group's standing, said as a verdict. A zero is
                  the good outcome and gets its own words, not "owed ₹0". White on
                  the wash, the same as the dashboard's hero number. */}
                <View style={{ gap: theme.spacing.lg }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
                      {ledger.myBalance === 0n
                        ? t.allSettled
                        : ledger.myBalance > 0n
                          ? t.youAreOwed
                          : t.youOwe}
                    </Text>
                    {ledger.pending !== 0n ? (
                      <Badge label={t.pendingConfirmation} tone="brand" />
                    ) : null}
                  </Row>

                  <MoneyText
                    amount={ledger.myBalance}
                    currency={currency}
                    locale={locale}
                    mode="balance"
                    variant="display"
                    tone="default"
                    style={{ color: theme.color.onBrand }}
                  />

                  {/* Three actions on the hero, like the dashboard: a white
                    "add expense" pill leads (the one primary), then two
                    translucent circles — settle up and who-pays-whom. */}
                  <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                    <Pressable
                      onPress={() => router.push(`/group/${groupId}/add-expense`)}
                      accessibilityRole="button"
                      accessibilityLabel={t.addExpense}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing.xs,
                        paddingVertical: theme.spacing.sm + 2,
                        paddingHorizontal: theme.spacing.lg,
                        borderRadius: theme.radius.pill,
                        backgroundColor: '#FFFFFF',
                        opacity: pressed ? 0.85 : 1,
                      })}
                    >
                      <Ionicons name="add" size={iconSize.lg} color={heroGradient[0]} />
                      <Text
                        variant="subheading"
                        style={{ color: heroGradient[0] }}
                        numberOfLines={1}
                      >
                        {t.addExpense}
                      </Text>
                    </Pressable>
                    <Row style={{ marginLeft: 'auto', gap: theme.spacing.sm }}>
                      <HeroActionCircle
                        icon="swap-horizontal"
                        label={t.settleUp}
                        onPress={() => router.push(`/group/${groupId}/settle`)}
                      />
                      <HeroActionCircle
                        icon="git-network-outline"
                        label={group.data.simplify_debts ? t.simplify : t.whoPaysWhom}
                        onPress={() => router.push(`/group/${groupId}/simplify`)}
                      />
                    </Row>
                  </Row>
                </View>
              </Gradient>

              {/* The white body beneath the hero: alerts, shared receipts, pending
                  settlements, then the three-face tab bar. */}
              <View style={{ gap: theme.spacing.xl, marginTop: theme.spacing.xl }}>
                <OverflowMenu
                  visible={menuOpen}
                  onClose={() => setMenuOpen(false)}
                  items={menuItems}
                />

                {/* Only the refused-change banner survives inline — it carries the
              retry / discard buttons the header glyph cannot. Offline, queued and
              in-flight now read from the glyph in the header, matching the
              dashboard. */}
                {refusedHere ? <SyncBanner groupId={groupId} /> : null}

                {/* If the two independent balance computations ever disagree, say so
            rather than showing a number that might be wrong (ADR-004). */}
                {ledger.mismatch ? (
                  <Card
                    style={{ backgroundColor: theme.color.negativeSoft, gap: theme.spacing.sm }}
                  >
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
                        <Ionicons
                          name="receipt-outline"
                          size={iconSize.md}
                          color={theme.color.brand}
                        />
                        <Text variant="subheading" style={{ flex: 1 }} numberOfLines={1}>
                          {receipt.parsed?.merchant ?? t.expense.aBill}
                        </Text>
                        <Ionicons
                          name={directionalIcon('chevron-forward')}
                          size={iconSize.md}
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

                {pendingForMe.map((settlement) => (
                  <Card key={settlement.id} style={{ gap: theme.spacing.md }}>
                    <Text variant="subheading">
                      {fill(t.group.saysTheyPaidYou, { name: nameOf(settlement.from_member_id) })}
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
                    {/* The payer's evidence, if they attached any — seen here
                      before confirming, so a confirmation answers proof rather
                      than a bare claim. View-only: this is the other side's. */}
                    <SettlementProof
                      groupId={groupId}
                      settlementId={settlement.id}
                      canManage={false}
                    />
                    <Row style={{ gap: theme.spacing.md }}>
                      <Button
                        label={t.group.confirmReceived}
                        onPress={() => confirmSettlement.mutate(settlement.id)}
                        disabled={confirmSettlement.isPending}
                      />
                      <Text variant="micro" tone="muted" style={{ flex: 1 }}>
                        {t.group.autoConfirms}
                      </Text>
                    </Row>
                  </Card>
                ))}

                {/* My own recorded payments, waiting on the payee. The place to
                  back the claim with a screenshot, and an acknowledgement that
                  it is in flight. */}
                {pendingByMe.map((settlement) => (
                  <Card key={settlement.id} style={{ gap: theme.spacing.md }}>
                    <Text variant="subheading">
                      {fill(t.proof.youPaid, { name: nameOf(settlement.to_member_id) })}
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
                    <Text variant="micro" tone="muted">
                      {fill(t.proof.awaiting, { name: nameOf(settlement.to_member_id) })}
                    </Text>
                    {/* Manage only once the settlement has reached the server:
                      the attach/remove RPCs check party against a real row, and
                      `pending` means it has not synced yet. Until then the card
                      still shows "waiting", just without the attach control. */}
                    <SettlementProof
                      groupId={groupId}
                      settlementId={settlement.id}
                      canManage={!settlement.pending}
                    />
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
                    {/* A real button, not a text with an onPress: a screen reader now
                  hears a control, and the 44pt floor plus hitSlop makes the
                  caption a tap target rather than a hairline of text. */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: showDeleted }}
                      accessibilityLabel={showDeleted ? t.group.hideDeleted : t.group.showDeleted}
                      onPress={() => setShowDeleted((current) => !current)}
                      hitSlop={8}
                      style={({ pressed }) => ({
                        minHeight: 44,
                        justifyContent: 'center',
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Text variant="caption" tone="muted">
                        {showDeleted ? t.group.hideDeleted : t.group.showDeleted}
                      </Text>
                    </Pressable>
                  </Row>
                ) : null}
              </View>
            </View>
          }
          ListFooterComponent={
            tab === Tab.Expenses ? (
              visibleExpenses.length === 0 ? (
                // An empty list that only describes itself leaves the one thing to
                // do on the screen to a floating button in the corner. The way out
                // of an empty state belongs inside it.
                <EmptyState
                  title={t.nothingYet}
                  body={t.nothingYetBody}
                  icon={
                    <Ionicons
                      name="receipt-outline"
                      size={iconSize.xxl}
                      color={theme.color.brand}
                    />
                  }
                  action={
                    <Button
                      label={t.addExpense}
                      onPress={() => router.push(`/group/${groupId}/add-expense`)}
                      icon={<Ionicons name="add" size={iconSize.md} color={theme.color.onBrand} />}
                    />
                  }
                />
              ) : null
            ) : tab === Tab.Balances ? (
              <View>
                {(members.data ?? []).map((member, index, arr) => {
                  // Flat row: the money meaning is the sign on the amount and its
                  // "you are owed / you owe" label, not the row's colour.
                  const balance = ledger.balances.get(member.id) ?? 0n;
                  return (
                    <View key={member.id}>
                      <Row
                        style={{
                          gap: theme.spacing.md,
                          alignItems: 'center',
                          paddingVertical: theme.spacing.md,
                        }}
                      >
                        <Avatar
                          name={displayName(member, null, blockedIds, t.misc.someone)}
                          ghost={isGhost(member) || isBlockedMember(member, blockedIds)}
                          size={40}
                        />
                        <View style={{ flex: 1 }}>
                          <Row style={{ gap: theme.spacing.sm }}>
                            <Text variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
                              {displayName(member, profile?.id, blockedIds, t.misc.someone)}
                            </Text>
                            {member.role === 'admin' && !isGhost(member) ? (
                              <Badge label={t.people.admin} tone="brand" />
                            ) : null}
                          </Row>
                          <Text variant="caption" tone="muted" numberOfLines={1}>
                            {isGhost(member)
                              ? t.notJoinedYet
                              : isBlockedMember(member, blockedIds)
                                ? // A VPA carries a name or phone — masked for a blocked person.
                                  '—'
                                : (member.vpa ?? member.profile?.default_vpa ?? '—')}
                          </Text>
                        </View>
                        <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                          {/* Somebody who owes the group money can be nudged from
                              the row that says so, the way Friends already does —
                              reading a debt and acting on it were two screens
                              apart for no reason. Ghosts have nowhere to send it. */}
                          {balance < 0n && !isGhost(member) && member.id !== ledger.myMemberId ? (
                            <RemindChip
                              groupId={groupId}
                              memberId={member.id}
                              currency={currency}
                            />
                          ) : null}
                          <MoneyText
                            amount={balance}
                            currency={currency}
                            locale={locale}
                            mode="balance"
                          />
                          {member.pending ? <PendingMark /> : null}
                        </Row>
                      </Row>
                      {index < arr.length - 1 ? (
                        <View style={{ height: 1, backgroundColor: theme.color.border }} />
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : (activity.data ?? []).length === 0 ? (
              <EmptyState
                title={t.nothingYet}
                body={t.group.activityEmptyBody}
                icon={<Ionicons name="pulse" size={iconSize.xxl} color={theme.color.brand} />}
              />
            ) : (
              // The same row shape as the Expenses tab, so the three tabs read as
              // one screen: a soft tinted tile on the left, the sentence and a
              // relative time beside it, the amount on the right, hairlines
              // between. The event wears a rounded-square tile (not the expense's
              // circle, not a bare timeline node or a bold filled disc) in a tint
              // that leans with the verb — mint for money in and confirmations,
              // coral for a delete or a dispute — so the feed is skimmable by
              // colour at a glance without a connector line drawing the eye down.
              <View>
                {(activity.data ?? []).map((entry, index) => {
                  const isLast = index === (activity.data?.length ?? 0) - 1;
                  const money = parseMoney(entry.payload, currency);
                  const tint = theme.tint[verbTint(entry.verb)];
                  return (
                    <View key={entry.id}>
                      <Row
                        style={{
                          gap: theme.spacing.md,
                          alignItems: 'center',
                          paddingVertical: theme.spacing.md,
                        }}
                      >
                        <View
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: theme.radius.md,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: tint.bg,
                          }}
                        >
                          <Ionicons
                            name={verbIcon(entry.verb)}
                            size={iconSize.lg}
                            color={tint.ink}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text variant="body" numberOfLines={2}>
                            {describeActivity(
                              // The group feed rides the mirror, where an activity
                              // row carries only `actor_member_id` — not the joined
                              // actor the cross-group feed gets. Resolve the actor
                              // from this group's members so the row names the
                              // person instead of "someone".
                              entry.actor
                                ? entry
                                : { ...entry, actor: actorFor(entry.actor_member_id) },
                              profile?.id ?? null,
                              blockedIds,
                              t.misc.someone,
                            )}
                          </Text>
                          <Text variant="caption" tone="muted" numberOfLines={1}>
                            {relativeTime(locale, entry.created_at)}
                          </Text>
                        </View>
                        {money ? (
                          <MoneyText
                            amount={money.amount}
                            currency={money.currency}
                            locale={locale}
                            variant="subheading"
                            // Same owe colour as the shares, balances and the
                            // global feed — one money colour across every screen.
                            tone="negative"
                          />
                        ) : null}
                      </Row>
                      {!isLast ? (
                        <View style={{ height: 1, backgroundColor: theme.color.border }} />
                      ) : null}
                    </View>
                  );
                })}
              </View>
            )
          }
        />

        {/* No FAB: adding an expense now lives on the hero's white pill, the
            same as the dashboard, so a floating button would be a second door
            to the same room. */}
      </View>
    </Screen>
  );
}
