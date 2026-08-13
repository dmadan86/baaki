import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { RefreshControl, ScrollView, useWindowDimensions, View } from 'react-native';

import { dayNumber, daysBetween } from '@baaki/core';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Gradient,
  IconButton,
  Row,
  Screen,
  SectionHeader,
  Text,
  TintCard,
  useTabBarClearance,
  useTheme,
  type TintName,
} from '@baaki/ui';

import { useGroups, useHomeSummary } from '@/data/hooks';
import { CountUpMoney, PressableScale, Stagger } from '@/lib/anim';
import { deviceDefaultCurrency, plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';
import { SyncBanner } from '@/components/SyncBanner';
import { SkeletonList } from '@/components/Skeletons';
import { GroupCard } from '@/components/GroupCard';
import { groupLabel } from '@/data/types';
import { usePullRefresh } from '@/lib/pullRefresh';

export default function HomeScreen() {
  const theme = useTheme();
  const pull = usePullRefresh();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { profile, isGuest } = useAuth();

  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);
  const guard = useGuestGuard();

  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

  // A guest tapping "new group" past their limit is sent to sign up rather than
  // into a form the server would refuse (ADR-006 addendum). A full user's guard
  // waves this through.
  const openNewGroup = (): void => {
    if (guard.blockAddGroup()) return;
    router.push('/new-group');
  };

  /**
   * The headline is one currency, because there is no such thing as a total
   * across several (ADR-004). The rest are counted underneath rather than added
   * in, which is what the profile screen already does with settled totals.
   *
   * With no groups there is nothing to be owed in, so the zero is shown in the
   * same currency a new group would start in on this phone — otherwise the
   * empty state reads ₹0 and the first group then counts in dollars.
   */
  const headline = summary.totals[0] ?? {
    currency: deviceDefaultCurrency(),
    net: 0n,
    owed: 0n,
    owing: 0n,
  };

  // A trip that is running today earns a card at the front of the balance deck:
  // it is the most "now" thing on the dashboard, and it is the one tap into the
  // planner nobody finds behind the group menu. "Running" is decided in the
  // trip's own timezone, not the phone's — a Goa trip run from Dubai turns over
  // at midnight in Goa (the same rule `dayNumber` and the planner already use).
  const activeTrips: readonly TripSlide[] = list
    .filter((g) => g.type === 'trip' && g.start_date && g.end_date)
    .map((g) => {
      const day = dayNumber(todayIn(g.time_zone), g.start_date, g.end_date);
      if (day === null) return null;
      return {
        id: g.id,
        title: groupLabel(g, summary.membersFor(g.id), profile?.id),
        coverEmoji: g.cover_emoji,
        currency: g.default_currency,
        day,
        total: daysBetween(g.start_date!, g.end_date!).length,
        balance: summary.balanceFor(g.id),
      };
    })
    .filter((t): t is TripSlide => t !== null);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
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
        <Row style={{ paddingTop: theme.spacing.md }}>
          {/* Your own face at the top of your own dashboard reads as a way in
              to your account, so it is one. It goes to the same place the last
              tab does rather than somewhere only reachable from here — two
              routes to one screen, not a second screen that drifts. */}
          <Avatar
            name={profile?.display_name ?? 'You'}
            size={46}
            accessibilityLabel={t.profile}
            onPress={() => router.navigate('/profile')}
          />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="muted">
              {t.greeting},
            </Text>
            <Text variant="heading" numberOfLines={1}>
              {profile?.display_name ?? 'You'}
            </Text>
          </View>
          <IconButton label={t.tabs.inbox} onPress={() => router.push('/inbox')}>
            <Ionicons name="notifications-outline" size={22} color={theme.color.text} />
          </IconButton>
        </Row>

        <SyncBanner />

        {isGuest ? (
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">
              {t.tabs.guestBanner}
            </Text>
            <Text variant="caption" tone="muted">
              {guard.gate?.expired
                ? t.tabs.guestReadOnly
                : guard.gate
                  ? t.tabs.guestDaysLeft.replace('{days}', String(guard.gate.daysLeft))
                  : t.tabs.guestBannerBody}
            </Text>
            <Button
              label={t.tabs.addYourDetails}
              variant="secondary"
              size="sm"
              onPress={() => router.push('/settings/account')}
            />
          </Card>
        ) : null}

        {/* The balance, one card per currency — there is no total across them
            (ADR-004), so several currencies read as several cards you swipe
            rather than one sum that would be a lie. */}
        <BalanceCarousel
          trips={activeTrips}
          totals={summary.totals.length > 0 ? summary.totals : [headline]}
          locale={locale}
          t={t}
        />

        {/* The dashboard's shortcuts, in the reference's shape: two big washed
            tiles for the things you start most, then a row of pastel tiles for
            the rest. Only once there is a group to act on — a brand-new account
            gets the empty state's single "new group" prompt instead of five
            tiles that would all just send it back here. */}
        {list.length > 0 ? (
          <QuickActions primaryGroupId={list[0]!.id} onNewGroup={openNewGroup} t={t} />
        ) : null}

        {loading ? (
          <SkeletonList rows={3} />
        ) : list.length === 0 ? (
          <EmptyState
            title={t.tabs.noGroups}
            body={t.tabs.noGroupsBody}
            action={<Button label={t.newGroup} onPress={openNewGroup} />}
          />
        ) : (
          <View>
            <SectionHeader
              title={t.yourGroups}
              action={
                <Text variant="caption" tone="brand" onPress={openNewGroup}>
                  {t.newGroup}
                </Text>
              }
            />
            <View style={{ gap: theme.spacing.md }}>
              {list.map((group, index) => {
                const members = summary.membersFor(group.id);
                const balance = summary.balanceFor(group.id);
                return (
                  <Stagger key={group.id} index={index}>
                    <GroupCard
                      id={group.id}
                      title={groupLabel(group, members, profile?.id)}
                      memberLabel={plural(locale, summary.memberCountFor(group.id), t.memberCount)}
                      coverEmoji={group.cover_emoji}
                      balance={balance}
                      currency={group.default_currency}
                      locale={locale}
                      statusLabel={
                        balance === 0n ? t.allSettled : balance > 0n ? t.youAreOwed : t.youOwe
                      }
                      pendingLabel={summary.hasPending(group.id) ? t.pendingConfirmation : null}
                      onPress={() => router.push(`/group/${group.id}`)}
                    />
                  </Stagger>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * The shortcut deck under the balance.
 *
 * Two washed hero tiles for the two things you start most — a new group, and an
 * expense on the group you touched last — then a pastel row for settling,
 * scanning a bill, and the inbox. The group-bound actions target the most
 * recent group (`primaryGroupId`); picking a different one is what its own card
 * lower down is for.
 */
function QuickActions({
  primaryGroupId,
  onNewGroup,
  t,
}: {
  primaryGroupId: string;
  onNewGroup: () => void;
  t: UiStrings;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader title={t.tabs.quickActions} />

      <Row style={{ gap: theme.spacing.md, alignItems: 'stretch' }}>
        <HeroTile
          colors={theme.gradient.brand}
          icon="people"
          label={t.newGroup}
          onPress={onNewGroup}
        />
        <HeroTile
          colors={theme.gradient.accent}
          icon="add"
          label={t.addExpense}
          onPress={() => router.push(`/group/${primaryGroupId}/add-expense`)}
        />
      </Row>

      <Row style={{ gap: theme.spacing.md, alignItems: 'stretch' }}>
        <QuickTile
          tint="mint"
          icon="swap-horizontal"
          label={t.settleUp}
          onPress={() => router.push(`/group/${primaryGroupId}/settle`)}
        />
        <QuickTile
          tint="peach"
          icon="scan"
          label={t.expense.scan}
          onPress={() => router.push(`/group/${primaryGroupId}/itemize`)}
        />
        <QuickTile
          tint="sky"
          icon="mail"
          label={t.tabs.inbox}
          onPress={() => router.push('/inbox')}
        />
      </Row>
    </View>
  );
}

/** A big washed tile — an icon chip over its label, filling half the row. */
function HeroTile({
  colors,
  icon,
  label,
  onPress,
}: {
  colors: readonly string[];
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ flex: 1 }}
    >
      <Gradient
        colors={colors}
        radius={theme.radius.lg}
        style={{ padding: theme.spacing.lg, height: 116, justifyContent: 'space-between' }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(255, 255, 255, 0.22)',
          }}
        >
          <Ionicons name={icon} size={22} color={theme.color.onBrand} />
        </View>
        <Text variant="subheading" tone="onBrand" numberOfLines={1}>
          {label}
        </Text>
      </Gradient>
    </PressableScale>
  );
}

/** A small pastel tile — a white icon badge over a one-word label. */
function QuickTile({
  tint,
  icon,
  label,
  onPress,
}: {
  tint: TintName;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const ink = theme.tint[tint].ink;
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ flex: 1 }}
    >
      <TintCard
        tint={tint}
        style={{
          borderRadius: theme.radius.lg,
          paddingVertical: theme.spacing.lg,
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: theme.radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.surface,
          }}
        >
          <Ionicons name={icon} size={22} color={ink} />
        </View>
        <Text variant="caption" numberOfLines={1} style={{ color: ink }}>
          {label}
        </Text>
      </TintCard>
    </PressableScale>
  );
}

/** One currency's standing: the net, and the two sides that make it up. */
type CurrencyTotal = { currency: string; net: bigint; owed: bigint; owing: bigint };

/** A running trip's card: where it is in its own run, and its standing. */
type TripSlide = {
  id: string;
  title: string;
  coverEmoji: string | null;
  currency: string;
  /** 1-based day the trip is on today, in its own timezone. */
  day: number;
  /** Total days the trip spans, both ends inclusive. */
  total: number;
  /** Net in the group's currency: >0 owed to you, <0 you owe. */
  balance: bigint;
};

/** Today as `YYYY-MM-DD` in a given timezone, never the server's. */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The balance as a swipeable deck. Any trip running today rides at the front —
 * it is the most "now" thing on the dashboard — then one card per currency,
 * because a total across currencies is a number that does not exist (ADR-004).
 * A single card shows bare; two or more get a pager with a dot each, the live
 * one stretched into a pill. Dots count slides, not currencies — the trip card
 * is a slide like any other.
 */
function BalanceCarousel({
  trips,
  totals,
  locale,
  t,
}: {
  trips: readonly TripSlide[];
  totals: readonly CurrencyTotal[];
  locale: string;
  t: UiStrings;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const cardWidth = width - theme.spacing.xl * 2;
  const [page, setPage] = useState(0);

  const slides = [
    ...trips.map((trip) => ({
      key: `trip:${trip.id}`,
      node: <TripCard trip={trip} locale={locale} t={t} />,
    })),
    ...totals.map((total) => ({
      key: `cur:${total.currency}`,
      node: <BalanceCard total={total} locale={locale} t={t} />,
    })),
  ];

  const only = slides[0];
  if (!only) return null;
  if (slides.length === 1) {
    return only.node;
  }

  return (
    <View style={{ gap: theme.spacing.md }}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(event) =>
          setPage(Math.round(event.nativeEvent.contentOffset.x / cardWidth))
        }
      >
        {slides.map((slide) => (
          <View key={slide.key} style={{ width: cardWidth }}>
            {slide.node}
          </View>
        ))}
      </ScrollView>

      <Row style={{ justifyContent: 'center', gap: theme.spacing.xs }}>
        {slides.map((slide, index) => (
          <View
            key={slide.key}
            style={{
              width: index === page ? 18 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: index === page ? theme.color.brand : theme.color.border,
            }}
          />
        ))}
      </Row>
    </View>
  );
}

/** One balance card: the brand wash, the net big, the owed/owe split beneath. */
function BalanceCard({ total, locale, t }: { total: CurrencyTotal; locale: string; t: UiStrings }) {
  const theme = useTheme();
  return (
    <Gradient radius={theme.radius.md} style={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text variant="caption" tone="onBrand">
          {t.yourBaaki}
        </Text>
        <Text variant="micro" tone="onBrand">
          {total.currency}
        </Text>
      </Row>

      <View>
        <CountUpMoney
          amount={total.net < 0n ? -total.net : total.net}
          currency={total.currency as never}
          locale={locale}
          tone="onBrand"
          style={{ fontSize: 40, lineHeight: 46, fontWeight: '700' }}
        />
        <Text variant="caption" tone="onBrand">
          {total.net === 0n ? t.allSettled : total.net > 0n ? t.overallOwed : t.overallOwe}
        </Text>
      </View>

      <Row style={{ gap: theme.spacing.xxl }}>
        <View>
          <Text variant="micro" tone="onBrand">
            {t.youAreOwed}
          </Text>
          <CountUpMoney
            amount={total.owed}
            currency={total.currency as never}
            locale={locale}
            tone="onBrand"
          />
        </View>
        <View>
          <Text variant="micro" tone="onBrand">
            {t.youOwe}
          </Text>
          <CountUpMoney
            amount={total.owing}
            currency={total.currency as never}
            locale={locale}
            tone="onBrand"
          />
        </View>
      </Row>
    </Gradient>
  );
}

/**
 * A running trip's card — the accent wash to set it apart from the brand
 * balance cards, its day out of the total big, its standing beneath. The whole
 * card is the way into the planner that the group's ••• menu otherwise hides.
 */
function TripCard({ trip, locale, t }: { trip: TripSlide; locale: string; t: UiStrings }) {
  const theme = useTheme();
  const net = trip.balance;
  return (
    <PressableScale
      onPress={() => router.push(`/group/${trip.id}/plan`)}
      accessibilityRole="button"
      accessibilityLabel={trip.title}
    >
      <Gradient
        colors={theme.gradient.accent}
        radius={theme.radius.md}
        style={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}
      >
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Row style={{ gap: theme.spacing.sm, alignItems: 'center', flex: 1 }}>
            <Text variant="subheading">{trip.coverEmoji ?? '🧳'}</Text>
            <Text variant="subheading" tone="onBrand" numberOfLines={1} style={{ flex: 1 }}>
              {trip.title}
            </Text>
          </Row>
          <Text variant="micro" tone="onBrand">
            {trip.currency}
          </Text>
        </Row>

        <View>
          <Text tone="onBrand" style={{ fontSize: 34, lineHeight: 40, fontWeight: '700' }}>
            {t.tripDay.replace('{day}', String(trip.day)).replace('{total}', String(trip.total))}
          </Text>
          <Text variant="caption" tone="onBrand">
            {net === 0n ? t.allSettled : net > 0n ? t.youAreOwed : t.youOwe}
          </Text>
        </View>

        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <CountUpMoney
            amount={net < 0n ? -net : net}
            currency={trip.currency as never}
            locale={locale}
            tone="onBrand"
          />
          <Text variant="caption" tone="onBrand">
            {t.plan}
          </Text>
        </Row>
      </Gradient>
    </PressableScale>
  );
}
