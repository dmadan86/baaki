import { useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, I18nManager, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Badge,
  directionalIcon,
  Gradient,
  iconSize,
  MoneyText,
  Row,
  Text,
  useTheme,
} from '@waves/ui';

import { useConfirmSettlement, useDisputeSettlement, useSettlementProof } from '@/data/hooks';
import { groupLabel, type GroupRow, type MemberRow, type SettlementRow } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { GroupPhoto } from '@/components/GroupPhoto';
import { SyncStatusIcon } from '@/components/SyncBanner';

/**
 * Which hero slide a paging scroll has landed on, correct in both directions.
 * Android reports a horizontal ScrollView's offset from the physical left even
 * under RTL (logical first slide at the far right); iOS handles RTL natively.
 * Only the Android-RTL case is flipped, so the dot pager tracks the same slide
 * the reader sees.
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
 * the server's `waves_auto_confirm_settlements` job enforces, from when the
 * payer recorded it. Never below one; a claim past the window is auto-confirmed
 * by the cron and has already left the pending list.
 */
const AUTO_CONFIRM_DAYS = 7;
function daysToConfirm(initiatedIso: string, now: number = Date.now()): number {
  const parsed = Date.parse(initiatedIso);
  if (!Number.isFinite(parsed)) return AUTO_CONFIRM_DAYS;
  const left = AUTO_CONFIRM_DAYS * 86_400_000 - (now - parsed);
  return Math.max(1, Math.ceil(left / 86_400_000));
}

/**
 * One round translucent action on the group hero — a white glyph on a dim white
 * disc, the same on-panel circle the dashboard hero uses. Icon-only; its name
 * rides on the accessibility label.
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
        width: 42,
        height: 42,
        borderRadius: 21,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.18)',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.lg} color={theme.color.onBrand} />
    </Pressable>
  );
}

/**
 * The group's fixed hero: the top controls, then a paging deck whose first slide
 * is the balance and its actions and whose second (only when something is
 * pending) is the incoming "they paid you" claim — one claim inline, or a
 * summary that opens the full review list for many. Rendered above the feed and
 * pinned, so the list scrolls under it rather than carrying it off the top.
 */
export function GroupHero({
  groupId,
  group,
  members,
  profileId,
  currency,
  myBalance,
  pending,
  pendingForMe,
  heroGradient,
  nameOf,
  onOpenMenu,
}: {
  groupId: string;
  group: GroupRow;
  members: readonly MemberRow[];
  profileId: string | null;
  currency: string;
  myBalance: bigint;
  pending: bigint;
  pendingForMe: readonly SettlementRow[];
  heroGradient: readonly string[];
  nameOf: (memberId: string | null) => string;
  onOpenMenu: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t, locale } = useStrings();
  const confirmSettlement = useConfirmSettlement(groupId);
  const disputeSettlement = useDisputeSettlement(groupId);

  const [heroSlideW, setHeroSlideW] = useState(0);
  const [heroPage, setHeroPage] = useState(0);
  const heroDeckRef = useRef<ScrollView>(null);

  const busy = confirmSettlement.isPending || disputeSettlement.isPending;

  // The one inline claim, if that is the case we are in — used to look up whether
  // the payer attached a proof, so the fast path can offer to show it before the
  // payee confirms rather than asking them to trust the amount blind. Called with
  // an empty id (a harmless null lookup) whenever there is not exactly one claim,
  // so the hook count never changes.
  const soleClaim = pendingForMe.length === 1 ? pendingForMe[0] : null;
  const soleProof = useSettlementProof(soleClaim?.id ?? '');

  const rejectPrompt = (settlement: SettlementRow): void => {
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

  return (
    <Gradient
      radius={0}
      colors={heroGradient}
      style={{
        paddingTop: insets.top + theme.spacing.md,
        paddingHorizontal: theme.spacing.xl,
        paddingBottom: theme.spacing.md,
        borderBottomLeftRadius: theme.radius.xxl,
        borderBottomRightRadius: theme.radius.xxl,
        gap: theme.spacing.lg,
      }}
    >
      <Row style={{ gap: theme.spacing.sm }}>
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
          <GroupPhoto photoPath={group.photo_path} emoji={group.cover_emoji} size={34} />
          <View style={{ flexShrink: 1 }}>
            <Text variant="subheading" tone="onBrand" numberOfLines={1}>
              {groupLabel(group, members ?? [], profileId)}
            </Text>
            <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }}>
              {plural(locale, members?.length ?? 0, t.memberCount)}
            </Text>
          </View>
        </Pressable>
        <SyncStatusIcon onBrand groupId={groupId} />
        <Pressable
          onPress={() => router.push(`/group/${groupId}/invite`)}
          accessibilityRole="button"
          accessibilityLabel={t.people.inviteTitle}
          hitSlop={10}
        >
          <Ionicons name="qr-code-outline" size={iconSize.xl} color={theme.color.onBrand} />
        </Pressable>
        <Pressable
          onPress={onOpenMenu}
          accessibilityRole="button"
          accessibilityLabel={t.group.more}
          hitSlop={10}
        >
          <Ionicons name="ellipsis-vertical" size={iconSize.xl} color={theme.color.onBrand} />
        </Pressable>
      </Row>

      {/* The paging deck: balance and actions lead; a pending claim (one inline,
          or a summary of many) rides as the second slide. */}
      <View onLayout={(event) => setHeroSlideW(event.nativeEvent.layout.width)}>
        <ScrollView
          ref={heroDeckRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEnabled={pendingForMe.length > 0 && heroSlideW > 0}
          onMomentumScrollEnd={(event) => setHeroPage(heroPageOf(event.nativeEvent))}
          onContentSizeChange={() => {
            // Acting on a claim drops it from the deck; if the view was parked on
            // that now-gone slide it would show blank — snap back to the balance
            // slide. A content-size callback, not an effect, so it stays off the
            // hooks path. At most two slides, so the last valid page is 1 while
            // anything is pending, 0 otherwise.
            const maxPage = pendingForMe.length > 0 ? 1 : 0;
            if (heroPage > maxPage) {
              heroDeckRef.current?.scrollTo({ x: 0, animated: false });
              setHeroPage(0);
            }
          }}
        >
          {/* Slide 0 — balance as a verdict, then the three hero actions. */}
          <View style={{ width: heroSlideW || undefined, gap: theme.spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
                {myBalance === 0n ? t.allSettled : myBalance > 0n ? t.youAreOwed : t.youOwe}
              </Text>
              {pending !== 0n ? <Badge label={t.pendingConfirmation} tone="brand" /> : null}
            </Row>

            <MoneyText
              amount={myBalance}
              currency={currency}
              locale={locale}
              mode="balance"
              variant="title"
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
                  paddingVertical: theme.spacing.sm,
                  paddingHorizontal: theme.spacing.lg,
                  borderRadius: theme.radius.pill,
                  backgroundColor: '#FFFFFF',
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Ionicons name="add" size={iconSize.lg} color={heroGradient[0]} />
                <Text variant="subheading" style={{ color: heroGradient[0] }} numberOfLines={1}>
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
                  label={group.simplify_debts ? t.simplify : t.whoPaysWhom}
                  onPress={() => router.push(`/group/${groupId}/simplify`)}
                />
              </Row>
            </Row>
          </View>

          {/* Exactly one claim: the fast path, amount and the two answers inline. */}
          {pendingForMe.length === 1 &&
            pendingForMe.map((settlement) => (
              <View
                key={settlement.id}
                style={{ width: heroSlideW || undefined, gap: theme.spacing.md }}
              >
                <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }} numberOfLines={1}>
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
                  variant="title"
                  tone="default"
                  style={{ color: theme.color.onBrand }}
                />

                <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                  <Pressable
                    onPress={() => confirmSettlement.mutate(settlement.id)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={t.group.confirmReceived}
                    style={({ pressed }) => ({
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: theme.spacing.xs,
                      paddingVertical: theme.spacing.sm,
                      paddingHorizontal: theme.spacing.lg,
                      borderRadius: theme.radius.pill,
                      backgroundColor: '#FFFFFF',
                      opacity: pressed ? 0.85 : 1,
                    })}
                  >
                    <Ionicons name="checkmark" size={iconSize.lg} color={heroGradient[0]} />
                    <Text variant="subheading" style={{ color: heroGradient[0] }} numberOfLines={1}>
                      {t.group.confirmReceived}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t.group.rejectSettlement}
                    disabled={busy}
                    onPress={() => rejectPrompt(settlement)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingVertical: theme.spacing.sm,
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

                {/* The payer's evidence is on the review screen; surface a way in
                    only when there is actually a proof to look at. */}
                {soleProof.data ? (
                  <Pressable
                    onPress={() => router.push(`/group/${groupId}/pending`)}
                    accessibilityRole="button"
                    accessibilityLabel={t.proof.view}
                    hitSlop={8}
                    style={({ pressed }) => ({
                      alignSelf: 'flex-start',
                      opacity: pressed ? 0.6 : 0.9,
                    })}
                  >
                    <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
                      <Ionicons
                        name="image-outline"
                        size={iconSize.sm}
                        color={theme.color.onBrand}
                      />
                      <Text
                        variant="micro"
                        tone="onBrand"
                        style={{ textDecorationLine: 'underline' }}
                      >
                        {t.proof.view}
                      </Text>
                    </Row>
                  </Pressable>
                ) : null}
              </View>
            ))}

          {/* Two or more: a summary that opens the full review list. */}
          {pendingForMe.length >= 2 ? (
            <View style={{ width: heroSlideW || undefined, gap: theme.spacing.md }}>
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }} numberOfLines={1}>
                {plural(locale, pendingForMe.length, t.group.peopleSaidPaid)}
              </Text>
              <MoneyText
                amount={pendingForMe.reduce(
                  (sum, settlement) => sum + BigInt(settlement.amount),
                  0n,
                )}
                currency={currency}
                locale={locale}
                variant="title"
                tone="default"
                style={{ color: theme.color.onBrand }}
              />
              <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                <Pressable
                  onPress={() => router.push(`/group/${groupId}/pending`)}
                  accessibilityRole="button"
                  accessibilityLabel={fill(t.group.reviewClaims, { count: pendingForMe.length })}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.xs,
                    paddingVertical: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.lg,
                    borderRadius: theme.radius.pill,
                    backgroundColor: '#FFFFFF',
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <Text variant="subheading" style={{ color: heroGradient[0] }} numberOfLines={1}>
                    {fill(t.group.reviewClaims, { count: pendingForMe.length })}
                  </Text>
                  <Ionicons name="chevron-forward" size={iconSize.md} color={heroGradient[0]} />
                </Pressable>
              </Row>
            </View>
          ) : null}
        </ScrollView>

        {pendingForMe.length > 0 ? (
          <Row style={{ justifyContent: 'center', gap: 6, marginTop: theme.spacing.sm }}>
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
  );
}
