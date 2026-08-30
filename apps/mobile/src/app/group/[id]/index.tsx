import { memo, useCallback, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import {
  Alert,
  I18nManager,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
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
  useCancelSettlement,
  useConfirmSettlement,
  useDisputeSettlement,
  useGroup,
  useDisputes,
  useGroupLedger,
  useGroupRealtime,
  useOpenReceipts,
} from '@/data/hooks';
import {
  activityHeadline,
  activityTarget,
  describeActivity,
  parseMoney,
  relativeTime,
  verbIcon,
  verbTint,
} from '@/data/activity';
import { nudgeToSettle } from '@/data/api';
import { expenseTitle } from '@/data/expenseTitle';
import { GroupSkeleton } from '@/components/Skeletons';
import { formatParts, type MemberId } from '@waves/core';
import { useBlockedUsers } from '@/data/blocked';
import {
  actorName,
  displayName,
  groupLabel,
  isBlockedMember,
  isGhost,
  type ActivityActor,
  type ActivityRow,
  type ExpenseRow,
  type ExpenseVersionRow,
  type MemberRow,
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
 * Which hero slide a paging scroll has landed on, correct in both directions.
 *
 * Android reports a horizontal ScrollView's offset from the physical left even
 * under RTL, so the logical first slide sits at the far right (the max offset);
 * iOS handles RTL natively and keeps the offset logical. So the Android-RTL case
 * — and only that one — is flipped, measuring from the content's logical start
 * so the dot pager tracks the same slide the reader is looking at.
 */
function heroPageOf(event: {
  contentOffset: { x: number };
  layoutMeasurement: { width: number };
  contentSize: { width: number };
}): number {
  const width = event.layoutMeasurement.width;
  if (width <= 0) return 0;
  const flip = Platform.OS === 'android' && I18nManager.isRTL;
  const maxOffset = Math.max(0, event.contentSize.width - width);
  const fromStart = flip ? maxOffset - event.contentOffset.x : event.contentOffset.x;
  return Math.max(0, Math.round(fromStart / width));
}

/**
 * Whole days left before a pending settlement auto-confirms — the 7-day window
 * the server's `baaki_auto_confirm_settlements` job enforces, counted from when
 * the payer recorded it. Never below one: a claim that has run past the window
 * is auto-confirmed by the cron and has already left the pending list, so the
 * countdown only ever shows a live figure.
 */
const AUTO_CONFIRM_DAYS = 7;
function daysToConfirm(initiatedIso: string, now: number = Date.now()): number {
  const parsed = Date.parse(initiatedIso);
  if (!Number.isFinite(parsed)) return AUTO_CONFIRM_DAYS;
  const left = AUTO_CONFIRM_DAYS * 86_400_000 - (now - parsed);
  return Math.max(1, Math.ceil(left / 86_400_000));
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
  const paidN = BigInt(paid ?? 0);
  const shareN = BigInt(share ?? 0);
  // Not involved is "put nothing in, owe nothing" — which covers both the member
  // absent from the bill entirely AND a member written into the split with a zero
  // share (an excluded party some imports still list). Either way there is no
  // stake, so the row must read "not involved", not "all settled" — a settled
  // square is what you get when you paid and owed the *same non-zero* amount.
  if (paidN === 0n && shareN === 0n) return null;
  return paidN - shareN;
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
 *
 * The two `Intl.DateTimeFormat`s are built once per locale by the screen and
 * handed in — constructing a formatter is expensive, and doing it inside the
 * heading (which the virtualized feed re-runs as it recycles) was the same
 * per-render allocation the expense rows had.
 */
function monthLabel(
  fmtSameYear: Intl.DateTimeFormat,
  fmtWithYear: Intl.DateTimeFormat,
  isoDate: string,
  now: number = Date.now(),
): string {
  const parsed = Date.parse(isoDate);
  if (!Number.isFinite(parsed)) return isoDate;
  const when = new Date(parsed);
  const sameYear = when.getUTCFullYear() === new Date(now).getUTCFullYear();
  return (sameYear ? fmtSameYear : fmtWithYear).format(when);
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
    }
  | {
      readonly kind: 'balance';
      readonly key: string;
      readonly member: MemberRow;
      readonly balance: bigint;
      readonly isLast: boolean;
    }
  | {
      readonly kind: 'activity';
      readonly key: string;
      readonly entry: ActivityRow;
      readonly isLast: boolean;
    };

/**
 * One expense row of the virtualized feed, memoized so a recycled row that lands
 * on the same expense does no work when the parent re-renders. Every prop is a
 * primitive or a reference the screen keeps stable across renders — `theme` and
 * `t` are memoized/static, `nameOf` is a `useCallback`, and `dateFmt` is built
 * once per locale — so the shallow `memo` compare holds and the fast fling never
 * has to re-run a row it already drew.
 *
 * `contested` and `myMemberId` are lifted to props (not read from the disputes
 * Set / ledger inside) precisely so this stays a pure function of stable inputs.
 * The date is formatted with the hoisted `dateFmt`, not a fresh
 * `Intl.DateTimeFormat` per render, which was what made `renderItem` too slow to
 * keep up with recycling and left blank cells on a hard fling.
 */
const ExpenseFeedRow = memo(function ExpenseFeedRow({
  expense,
  isLast,
  contested,
  myMemberId,
  groupId,
  locale,
  dateFmt,
  t,
  theme,
  nameOf,
}: {
  expense: ExpenseRow;
  isLast: boolean;
  contested: boolean;
  myMemberId: MemberId | null;
  groupId: string;
  locale: string;
  dateFmt: Intl.DateTimeFormat;
  t: ReturnType<typeof useStrings>['t'];
  theme: ReturnType<typeof useTheme>;
  nameOf: (memberId: string | null) => string;
}) {
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
  const stake = myStake(version, myMemberId);
  // Flat row: the category is the badge on the left, not the row's
  // colour. A deleted row is dimmed rather than hidden, so the
  // ledger stays visibly append-only.
  const title = expenseTitle(version?.description, version?.category, t, version?.category_meta);
  // The direction of your stake, said in words. It rides under the amount on the
  // right and doubles as the label the muted date pairs with — "you lent · 19
  // Mar" — so the row's meaning is the sign on the amount, not the row's colour.
  const directionLabel =
    stake === null
      ? t.expense.notInvolved
      : stake > 0n
        ? t.expense.youLent
        : stake < 0n
          ? t.expense.youBorrowed
          : t.allSettled;
  // The day-and-month stamp lives in the fixed right column now, not on the
  // muted subtitle under the title. That is what guarantees it survives a long
  // payer name: the name ellipsizes in the flexible middle, the date rides the
  // column that never shrinks.
  const dateStamp = version ? dateFmt.format(new Date(version.expense_date)) : null;
  // The right column's date-line: the direction and the date, joined the way the
  // subtitle joins its parts. Undated rows (no version) show the label alone.
  const rightMeta = [directionLabel, dateStamp].filter(Boolean).join(' · ');
  // The whole row is one button to a screen reader, so the money a sighted user
  // reads on the right has to ride the row's label — otherwise it announces the
  // title alone and never the amount. The magnitude (the direction is already in
  // words), the direction and the date, comma-joined so it reads as a list, not
  // "dot". Everything from the right column is gated on `version`, so a row with
  // nothing priced on the right announces nothing extra either.
  const amountA11y =
    version && stake !== null && stake !== 0n
      ? formatParts({ minor: stake < 0n ? -stake : stake, currency: version.currency }, { locale })
          .text
      : null;
  const rowLabel = [
    title,
    contested ? t.expense.disputed : null,
    version ? directionLabel : null,
    amountA11y,
    dateStamp,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <View>
      <Pressable
        onPress={() => router.push(`/group/${groupId}/expense/${expense.id}`)}
        accessibilityRole="button"
        accessibilityLabel={rowLabel}
        style={({ pressed }) => ({
          opacity: pressed ? 0.6 : expense.deleted_at ? 0.55 : 1,
        })}
      >
        <Row
          style={{
            gap: theme.spacing.md,
            alignItems: 'center',
            paddingVertical: theme.spacing.sm,
          }}
        >
          <CategoryBadge
            category={version?.category}
            meta={version?.category_meta}
            description={version?.description}
            size={40}
          />
          {/* MIDDLE — the one zone that yields. `minWidth: 0` lets a long title
              or payer name actually ellipsize here rather than shoving the amount
              and date off the row; the flex swallows the slack so the right
              column can stay at its natural width. */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
              <Text variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
                {title}
              </Text>
              {contested ? <Badge label={t.expense.disputed} tone="negative" /> : null}
            </Row>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {[
                paidLine,
                expense.deleted_at ? t.expense.deleted : null,
                (version?.version_no ?? 1) > 1
                  ? plural(locale, version!.version_no - 1, t.expense.editedTimes)
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          {/* RIGHT — fixed and right-aligned, the money column. `flexShrink: 0`
              makes the amount the hero: for any normal value it can never be
              squeezed or clipped by a long name, and the date sits directly under
              it so it is always on the row too. Only the middle ever gives. The
              `maxWidth` is a pure safety valve for a pathological amount on a
              narrow screen — it stops the column from ever eating the whole row
              and starving the name to zero; short of that ceiling the amount is
              never capped. */}
          {version ? (
            <View style={{ flexShrink: 0, maxWidth: '55%', alignItems: 'flex-end' }}>
              <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
                {stake !== null && stake !== 0n ? (
                  <MoneyText
                    amount={stake}
                    currency={version.currency}
                    locale={locale}
                    mode="balance"
                    numberOfLines={1}
                    variant="subheading"
                    style={{ fontWeight: '700' }}
                  />
                ) : null}
                {expense.pending ? <PendingMark /> : null}
              </Row>
              <Text variant="micro" tone="muted" numberOfLines={1}>
                {rightMeta}
              </Text>
            </View>
          ) : null}
        </Row>
      </Pressable>
      {!isLast ? <View style={{ height: 1, backgroundColor: theme.color.border }} /> : null}
    </View>
  );
});

export default function GroupScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const clearance = useScreenClearance(112);
  const pull = usePullRefresh();
  const { t, locale } = useStrings();
  // `?welcome=trip` is set once, by the create screen, when a trip is made
  // without dates — it opens this group with a one-time plan-your-trip nudge.
  // The param is gone on any later visit, so the nudge is a moment, not a nag.
  const { id, welcome } = useLocalSearchParams<{ id: string; welcome?: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>(Tab.Expenses);
  const [showDeleted, setShowDeleted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tripNudgeDismissed, setTripNudgeDismissed] = useState(false);
  // The hero deck's measured slide width and the landed page, so the balance and
  // each pending "they paid you" claim can ride as snapping slides without the
  // hero changing height. Zero until the first layout; the slides fall back to
  // content width for that one frame.
  const [heroSlideW, setHeroSlideW] = useState(0);
  const [heroPage, setHeroPage] = useState(0);
  const heroDeckRef = useRef<ScrollView>(null);

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
  const cancelSettlement = useCancelSettlement(groupId);
  const disputeSettlement = useDisputeSettlement(groupId);

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

  // Date formatters built once per locale, not per row. Constructing an
  // `Intl.DateTimeFormat` is expensive; doing it inside the row renderer meant a
  // fast fling re-allocated a formatter for every recycled cell, slowing
  // `renderItem` enough to outrun recycling and flash blanks. `dateFmt` is the
  // day-and-month stamp on each expense; the two month formatters feed the
  // section headings (same output as before — long month, year only off-year).
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    [locale],
  );
  const monthFmtSameYear = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }),
    [locale],
  );
  const monthFmtWithYear = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    [locale],
  );
  // The Activity tab's relative-time formatter, built once per locale and handed
  // to every row — the same reason the date formatters above are hoisted. The
  // standalone Activity feed already does this; this one used to build an
  // `Intl.RelativeTimeFormat` per row while rendering the whole feed at once.
  const activityRtf = useMemo(
    () =>
      typeof Intl.RelativeTimeFormat === 'function'
        ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
        : undefined,
    [locale],
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
  // The one-time trip nudge: a trip opened straight from create, with no dates
  // on it yet, until it is dismissed. Dates being the tell — a dated trip was
  // already planned at create, and a nudge would be noise.
  const showTripNudge =
    welcome === 'trip' && groupData.type === 'trip' && !groupData.start_date && !tripNudgeDismissed;

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
    { icon: 'download-outline', label: t.groupExport.menu, route: `/group/${groupId}/export` },
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

  // The Balances and Activity tabs ride the same virtualized list as Expenses,
  // one FeedItem per row, so switching to them renders only the handful of rows
  // on screen — not every member and every activity entry at once, which is what
  // made the tab switch stall (they were mapped in full inside the list footer).
  const memberList = members.data ?? [];
  const balanceItems: FeedItem[] = memberList.map((member, index) => ({
    kind: 'balance',
    key: `balance-${member.id}`,
    member,
    balance: ledger.balances.get(member.id) ?? 0n,
    isLast: index === memberList.length - 1,
  }));
  const activityList = activity.data ?? [];
  const activityItems: FeedItem[] = activityList.map((entry, index) => ({
    kind: 'activity',
    key: `activity-${entry.id}`,
    entry,
    isLast: index === activityList.length - 1,
  }));
  // The rows the list shows for the current tab. One source for `data`, so the
  // three tabs are the same list with different contents rather than a list plus
  // two hand-rolled footers.
  const listData: FeedItem[] =
    tab === Tab.Balances ? balanceItems : tab === Tab.Activity ? activityItems : feedItems;

  // A month heading or an expense row. Headings carry the between-section gap the
  // ScrollView used to give for free; the first item needs none, its space comes
  // from the header block above it. The row itself is a memoized component fed
  // only stable props, so a recycled cell that lands on the same expense does no
  // work — the allocation and re-render both moved out of the hot fling path.
  const renderFeedItem = ({ item, index }: { item: FeedItem; index: number }) => {
    if (item.kind === 'month') {
      return (
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
          {monthLabel(monthFmtSameYear, monthFmtWithYear, item.date)}
        </Text>
      );
    }
    if (item.kind === 'expense') {
      return (
        <ExpenseFeedRow
          expense={item.expense}
          isLast={item.isLast}
          // Lifted to a primitive prop so the row does not depend on the disputes
          // Set — keeps its memo compare cheap and stable.
          contested={openDisputes.has(item.expense.id)}
          myMemberId={ledger.myMemberId}
          groupId={groupId}
          locale={locale}
          dateFmt={dateFmt}
          t={t}
          theme={theme}
          nameOf={nameOf}
        />
      );
    }
    if (item.kind === 'balance') {
      const { member, balance, isLast } = item;
      // Flat row: the money meaning is the sign on the amount and its
      // "you are owed / you owe" label, not the row's colour.
      return (
        <View>
          <Row
            style={{
              gap: theme.spacing.md,
              alignItems: 'center',
              paddingVertical: theme.spacing.sm,
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
              {/* Somebody who owes the group money can be nudged from the row that
                  says so, the way Friends already does. Ghosts have nowhere to
                  send it. */}
              {balance < 0n && !isGhost(member) && member.id !== ledger.myMemberId ? (
                <RemindChip groupId={groupId} memberId={member.id} currency={currency} />
              ) : null}
              <MoneyText amount={balance} currency={currency} locale={locale} mode="balance" />
              {member.pending ? <PendingMark /> : null}
            </Row>
          </Row>
          {!isLast ? <View style={{ height: 1, backgroundColor: theme.color.border }} /> : null}
        </View>
      );
    }
    // Activity: the same row shape as the Expenses tab, so the three tabs read as
    // one screen — a soft tinted tile, the event and a relative time beside it,
    // the amount on the right, hairlines between. The group feed rides the
    // mirror, where an activity row carries only `actor_member_id` — not the
    // joined actor the cross-group feed gets — so resolve the actor from this
    // group's members before wording the row.
    const { entry, isLast } = item;
    const money = parseMoney(entry.payload, currency);
    const tint = theme.tint[verbTint(entry.verb)];
    const resolved = entry.actor ? entry : { ...entry, actor: actorFor(entry.actor_member_id) };
    // The full sentence stays the spoken label; the visible title leads with the
    // event and the actor drops to the metadata line, so the feed is skimmable.
    const label = describeActivity(resolved, profile?.id ?? null, blockedIds, t.misc.someone);
    const headline = activityHeadline(entry);
    // No actor on an auto-event — omit it rather than say "Someone".
    const who = resolved.actor
      ? actorName(resolved.actor, profile?.id ?? null, blockedIds, t.misc.someone)
      : null;
    // This feed is flat — no day headings — so the row keeps the full relative
    // wording ("yesterday", "3 days ago"), the day the reader would otherwise
    // have no other way to place. The cross-group Activity tab, which is cut into
    // day sections, uses activityTimestamp to drop that redundant day word.
    const when = relativeTime(locale, entry.created_at, undefined, activityRtf);
    return (
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => router.push(activityTarget(entry) as Href)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Row
            style={{
              gap: theme.spacing.md,
              alignItems: 'center',
              paddingVertical: theme.spacing.sm,
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
              <Ionicons name={verbIcon(entry.verb)} size={iconSize.lg} color={tint.ink} />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="body" numberOfLines={2}>
                {headline}
              </Text>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {who ? `${who} · ${when}` : when}
              </Text>
            </View>
            {money ? (
              // Neutral, not red: an expense total belongs to nobody in
              // particular — it is not a balance you owe. `mode="plain"` is
              // MoneyText's neutral ink, the same on the cross-group feed.
              <MoneyText
                amount={money.amount}
                currency={money.currency}
                locale={locale}
                variant="subheading"
              />
            ) : null}
          </Row>
        </Pressable>
        {!isLast ? <View style={{ height: 1, backgroundColor: theme.color.border }} /> : null}
      </View>
    );
  };

  return (
    <Screen edges={[]}>
      {/* The hero runs dark under the status bar; force light icons for it. */}
      <StatusBar style="light" />
      {/* No entrance re-animation: the screen already slides in natively, and a
          second scale-up on top of that read as an unwanted zoom. */}
      <View style={{ flex: 1 }}>
        <FlashList
          data={listData}
          extraData={`${tab}|${showDeleted}|${locale}`}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          renderItem={renderFeedItem}
          // Belt-and-suspenders on top of the allocation-light, memoized row:
          // render well beyond the viewport so a fast fling down a long ledger
          // never outruns recycling and flashes blank rows (default is 250px,
          // which a hard fling clears in a frame). ~1500px ≈ two dozen rows
          // ahead — cheap now that each row barely costs anything to draw.
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

                {/* The hero deck. The balance and its actions lead; each pending
                  "they paid you" claim rides as its own snapping slide, so a
                  confirmation happens up here on the wash instead of a full-page
                  card in the body. Every slide fills the hero's measured inner
                  width, so the block keeps the balance slide's height and the
                  header above is untouched. With nothing pending it is a single
                  static slide — the hero exactly as before. */}
                <View onLayout={(event) => setHeroSlideW(event.nativeEvent.layout.width)}>
                  <ScrollView
                    ref={heroDeckRef}
                    horizontal
                    pagingEnabled
                    showsHorizontalScrollIndicator={false}
                    scrollEnabled={pendingForMe.length > 0 && heroSlideW > 0}
                    onMomentumScrollEnd={(event) => setHeroPage(heroPageOf(event.nativeEvent))}
                    onContentSizeChange={() => {
                      // Confirming or rejecting a claim drops it from the deck,
                      // shrinking the content. If the view was parked on that
                      // now-gone slide it would show blank — snap back to the
                      // balance slide whenever the landed page no longer exists.
                      // A content-size callback, not an effect, so it stays out
                      // of render and off the hooks path.
                      // The deck is at most two slides now (balance + the single
                      // claim or the many-claims summary), so the last valid page
                      // is 1 while anything is pending, 0 otherwise.
                      const maxPage = pendingForMe.length > 0 ? 1 : 0;
                      if (heroPage > maxPage) {
                        heroDeckRef.current?.scrollTo({ x: 0, animated: false });
                        setHeroPage(0);
                      }
                    }}
                  >
                    {/* Slide 0 — the balance said as a verdict, then the three
                      hero actions (white "add expense" pill, settle, who-pays). */}
                    <View style={{ width: heroSlideW || undefined, gap: theme.spacing.lg }}>
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

                    {/* Exactly one claim gets the fast path — its amount on the
                      wash and the two answers inline (a solid white "Confirm
                      received" and a translucent "Not received"). Two or more
                      collapse to a single summary slide below rather than a stack
                      of cards nobody wants to swipe through. Neither answer moves
                      a balance; both retire the claim. */}
                    {pendingForMe.length === 1 &&
                      pendingForMe.map((settlement) => (
                        <View
                          key={settlement.id}
                          style={{ width: heroSlideW || undefined, gap: theme.spacing.lg }}
                        >
                          <Text
                            variant="caption"
                            tone="onBrand"
                            style={{ opacity: 0.85 }}
                            numberOfLines={1}
                          >
                            {fill(t.group.saysTheyPaidYouWindow, {
                              name: nameOf(settlement.from_member_id),
                              window: plural(
                                locale,
                                daysToConfirm(settlement.initiated_at),
                                t.group.daysToConfirm,
                              ),
                            })}
                          </Text>

                          <MoneyText
                            amount={BigInt(settlement.amount)}
                            currency={settlement.currency}
                            locale={locale}
                            variant="display"
                            tone="default"
                            style={{ color: theme.color.onBrand }}
                          />

                          <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                            <Pressable
                              onPress={() => confirmSettlement.mutate(settlement.id)}
                              disabled={confirmSettlement.isPending || disputeSettlement.isPending}
                              accessibilityRole="button"
                              accessibilityLabel={t.group.confirmReceived}
                              style={({ pressed }) => ({
                                flex: 1,
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: theme.spacing.xs,
                                paddingVertical: theme.spacing.sm + 2,
                                paddingHorizontal: theme.spacing.lg,
                                borderRadius: theme.radius.pill,
                                backgroundColor: '#FFFFFF',
                                opacity: pressed ? 0.85 : 1,
                              })}
                            >
                              <Ionicons
                                name="checkmark"
                                size={iconSize.lg}
                                color={heroGradient[0]}
                              />
                              <Text
                                variant="subheading"
                                style={{ color: heroGradient[0] }}
                                numberOfLines={1}
                              >
                                {t.group.confirmReceived}
                              </Text>
                            </Pressable>
                            {/* The decline, visible rather than in an overflow.
                              Translucent with a hairline so it reads as the
                              secondary answer, not a second primary; the prompt
                              behind it is the real confirmation. */}
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={t.group.rejectSettlement}
                              disabled={confirmSettlement.isPending || disputeSettlement.isPending}
                              onPress={() =>
                                Alert.alert(
                                  t.group.rejectTitle,
                                  fill(t.group.rejectBody, {
                                    name: nameOf(settlement.from_member_id),
                                  }),
                                  [
                                    { text: t.group.keep, style: 'cancel' },
                                    {
                                      text: t.group.rejectConfirm,
                                      style: 'destructive',
                                      onPress: () => disputeSettlement.mutate(settlement.id),
                                    },
                                  ],
                                )
                              }
                              style={({ pressed }) => ({
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: 'center',
                                paddingVertical: theme.spacing.sm + 2,
                                paddingHorizontal: theme.spacing.lg,
                                borderRadius: theme.radius.pill,
                                borderWidth: 1,
                                borderColor: 'rgba(255, 255, 255, 0.5)',
                                opacity: pressed ? 0.7 : 1,
                              })}
                            >
                              <Text variant="subheading" tone="onBrand" numberOfLines={1}>
                                {t.group.rejectSettlement}
                              </Text>
                            </Pressable>
                          </Row>
                        </View>
                      ))}

                    {/* Two or more claims: one summary slide — how many people,
                      the total on the wash, and a Review that opens the full
                      list where each can be confirmed or rejected in one place. */}
                    {pendingForMe.length >= 2 ? (
                      <View style={{ width: heroSlideW || undefined, gap: theme.spacing.lg }}>
                        <Text
                          variant="caption"
                          tone="onBrand"
                          style={{ opacity: 0.85 }}
                          numberOfLines={1}
                        >
                          {plural(locale, pendingForMe.length, t.group.peopleSaidPaid)}
                        </Text>
                        <MoneyText
                          amount={pendingForMe.reduce(
                            (sum, settlement) => sum + BigInt(settlement.amount),
                            0n,
                          )}
                          currency={currency}
                          locale={locale}
                          variant="display"
                          tone="default"
                          style={{ color: theme.color.onBrand }}
                        />
                        <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                          <Pressable
                            onPress={() => router.push(`/group/${groupId}/pending`)}
                            accessibilityRole="button"
                            accessibilityLabel={fill(t.group.reviewClaims, {
                              count: pendingForMe.length,
                            })}
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
                            <Text
                              variant="subheading"
                              style={{ color: heroGradient[0] }}
                              numberOfLines={1}
                            >
                              {fill(t.group.reviewClaims, { count: pendingForMe.length })}
                            </Text>
                            <Ionicons
                              name="chevron-forward"
                              size={iconSize.md}
                              color={heroGradient[0]}
                            />
                          </Pressable>
                        </Row>
                      </View>
                    ) : null}
                  </ScrollView>

                  {/* The dot pager — the "swipe me" signal, only when a claim is
                    waiting. A wide pill marks the landed slide over faint dots. */}
                  {pendingForMe.length > 0 ? (
                    <Row
                      style={{
                        justifyContent: 'center',
                        gap: 6,
                        marginTop: theme.spacing.md,
                      }}
                    >
                      {/* Two dots whenever anything is pending: the balance, and
                        the single claim or the summary of many. */}
                      {Array.from({ length: 2 }).map((_, index) => (
                        <View
                          key={index}
                          style={{
                            width: heroPage === index ? 18 : 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: theme.color.onBrand,
                            opacity: heroPage === index ? 1 : 0.4,
                          }}
                        />
                      ))}
                    </Row>
                  ) : null}
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

                {/* The one-time nudge to plan a fresh trip. Dates and budget were
            moved off the create screen to keep it short; this is where a trip
            gets offered them, once, on its own group. Later dismisses it for
            this visit; the param is gone next time regardless. */}
                {showTripNudge ? (
                  <Card style={{ gap: theme.spacing.md }}>
                    <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                      <Ionicons name="airplane" size={iconSize.md} color={theme.color.brand} />
                      <Text variant="subheading" style={{ flex: 1 }}>
                        {t.extras.tripWelcomeTitle}
                      </Text>
                    </Row>
                    <Text variant="caption" tone="muted">
                      {t.extras.tripWelcomeBody}
                    </Text>
                    <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                      <Button
                        label={t.extras.tripWelcomeAddDates}
                        size="sm"
                        onPress={() => router.push(`/group/${groupId}/settings`)}
                      />
                      <Button
                        label={t.extras.tripWelcomeSetBudget}
                        size="sm"
                        variant="secondary"
                        onPress={() => router.push(`/group/${groupId}/plan`)}
                      />
                      <Button
                        label={t.extras.tripWelcomeLater}
                        size="sm"
                        variant="ghost"
                        onPress={() => setTripNudgeDismissed(true)}
                      />
                    </Row>
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

                {/* The "they paid you" claims now ride the hero deck above as
                  swipeable slides (confirm / reject up there), so the body no
                  longer carries a full-page confirmation card. */}

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
                    {/* Withdraw a payment recorded by mistake or twice. Queued
                        like every other mutation, so even a still-syncing claim
                        cancels cleanly — the create runs before the cancel in
                        the ordered queue. */}
                    <Button
                      label={t.group.cancelSettlement}
                      variant="secondary"
                      fullWidth
                      onPress={() =>
                        Alert.alert(
                          t.group.cancelTitle,
                          fill(t.group.cancelBody, { name: nameOf(settlement.to_member_id) }),
                          [
                            { text: t.group.keep, style: 'cancel' },
                            {
                              text: t.group.cancelConfirm,
                              style: 'destructive',
                              onPress: () => cancelSettlement.mutate(settlement.id),
                            },
                          ],
                        )
                      }
                      disabled={cancelSettlement.isPending}
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
          ListEmptyComponent={
            tab === Tab.Expenses ? (
              // An empty list that only describes itself leaves the one thing to
              // do on the screen to a floating button in the corner. The way out
              // of an empty state belongs inside it.
              <EmptyState
                title={t.nothingYet}
                body={t.nothingYetBody}
                icon={
                  <Ionicons name="receipt-outline" size={iconSize.xxl} color={theme.color.brand} />
                }
                action={
                  <Button
                    label={t.addExpense}
                    onPress={() => router.push(`/group/${groupId}/add-expense`)}
                    icon={<Ionicons name="add" size={iconSize.md} color={theme.color.onBrand} />}
                  />
                }
              />
            ) : tab === Tab.Activity ? (
              <EmptyState
                title={t.nothingYet}
                body={t.group.activityEmptyBody}
                icon={<Ionicons name="pulse" size={iconSize.xxl} color={theme.color.brand} />}
              />
            ) : null
          }
        />

        {/* No FAB: adding an expense now lives on the hero's white pill, the
            same as the dashboard, so a floating button would be a second door
            to the same room. */}
      </View>
    </Screen>
  );
}
