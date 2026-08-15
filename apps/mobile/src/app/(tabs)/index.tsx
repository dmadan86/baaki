import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, useWindowDimensions, View } from 'react-native';

import { dayNumber, daysBetween } from '@baaki/core';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Gradient,
  iconSize,
  Row,
  Screen,
  SectionHeader,
  Skeleton,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useCaptures, useGroups, useHomeSummary } from '@/data/hooks';
import { CountUpMoney, PressableScale, Stagger } from '@/lib/anim';
import { useMotion } from '@/lib/motion';
import { deviceDefaultCurrency, plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';
import { SyncBanner } from '@/components/SyncBanner';
import { SkeletonList } from '@/components/Skeletons';
import { GroupCard } from '@/components/GroupCard';
import { OverflowMenu, type OverflowMenuItem } from '@/components/OverflowMenu';
import { useAvatarUrl } from '@/components/ProfileAvatar';
import { groupLabel, GroupType } from '@/data/types';
import { usePullRefresh } from '@/lib/pullRefresh';

export default function HomeScreen() {
  const theme = useTheme();
  const pull = usePullRefresh();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { profile, isGuest } = useAuth();
  // The header avatar sits in the private bucket, so its path has to be signed
  // before an Image can show it — the same resolution the profile screen does.
  // Without this the dashboard falls back to initials while settings shows the
  // photo, which reads as the picture "not loading" on the home screen.
  const avatarUrl = useAvatarUrl(profile?.avatar_url);

  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);
  const captures = useCaptures();
  const guard = useGuestGuard();

  // Captures waiting in the personal inbox (A34) — surfaced as a card and a
  // badged header entry so a caught expense is not forgotten before it lands in
  // a group.
  const captureCount = captures.data?.length ?? 0;

  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

  // The header overflow menu (the three-dot dropdown): the settings and the
  // less-used destinations, surfaced from the dashboard rather than only from
  // the profile tab.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuItems: OverflowMenuItem[] = useMemo(
    () => [
      { icon: 'person-circle-outline', label: t.account.yourAccount, route: '/settings/account' },
      {
        icon: 'notifications-outline',
        label: t.account.notifications,
        route: '/settings/notifications',
      },
      { icon: 'archive-outline', label: t.group.archivedTitle, route: '/settings/archived' },
      { icon: 'cloud-done-outline', label: t.backup.title, route: '/settings/backup' },
      { icon: 'language-outline', label: t.language, route: '/settings/language' },
      { icon: 'contrast-outline', label: t.account.themeRow, route: '/settings/theme' },
      { icon: 'settings-outline', label: t.account.faceSettings, route: '/profile' },
    ],
    [t],
  );

  // The group list gets a category filter strip — but only worth showing once
  // there is more than one kind of group to sort between. Chips appear in the
  // canonical group-type order, and only for types the person actually has, so
  // no chip ever leads to an empty shelf. 'all' is the resting state.
  const [category, setCategory] = useState<GroupType | 'all'>('all');
  const presentTypes = GROUP_TYPE_ORDER.filter((type) => list.some((g) => g.type === type));
  // A filter can outlive the group it matched — leaving the last trip snaps the
  // strip back to 'all' rather than a chip pointing at nothing.
  const active = category !== 'all' && presentTypes.includes(category) ? category : 'all';
  const visible = active === 'all' ? list : list.filter((g) => g.type === active);

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
    .filter((g) => g.type === GroupType.Trip && g.start_date && g.end_date)
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
        <Row style={{ paddingTop: theme.spacing.md, alignItems: 'center', gap: theme.spacing.md }}>
          {/* Your own face at the top of your own dashboard reads as a way in
              to your account, so it is one. It goes to the same place the last
              tab does rather than somewhere only reachable from here — two
              routes to one screen, not a second screen that drifts. */}
          <Avatar
            name={profile?.display_name ?? t.account.you}
            size={44}
            photoUrl={avatarUrl}
            accessibilityLabel={t.profile}
            onPress={() => router.navigate('/profile')}
          />
          {/* Just the name, next to the avatar — the greeting was a word that
              said nothing and pushed the name down into a caption. The name is
              a tap target too, to the same account screen the avatar opens: the
              whole name-and-face cluster reads as one way in, not a live icon
              beside dead text. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.profile}
            onPress={() => router.navigate('/profile')}
            hitSlop={8}
            style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.5 : 1 })}
          >
            <Text variant="heading" numberOfLines={1}>
              {profile?.display_name ?? t.account.you}
            </Text>
          </Pressable>
          {/* Bare icons, no button chrome — the header reads as a title row, not
              a toolbar of pills. Straight to the camera: the icon is a scanner,
              so it opens one rather than a form to fill in first (the capture
              screen reads the `scan` flag and launches the camera on mount). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.captures.captureCta}
            onPress={() => router.push('/capture?scan=1')}
            hitSlop={10}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
          >
            <Ionicons name="camera-outline" size={iconSize.xxl} color={theme.color.text} />
          </Pressable>
          {/* The overflow: the settings and the less-used destinations, dropped
              from here rather than owning a tab. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.account.faceSettings}
            onPress={() => setMenuOpen(true)}
            hitSlop={10}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
          >
            <Ionicons name="ellipsis-vertical" size={iconSize.xxl} color={theme.color.text} />
          </Pressable>
        </Row>

        <OverflowMenu visible={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />

        <SyncBanner />

        {/* Expenses caught without a group yet (A34). Sits near the top so an
            inbox with something in it is the first thing after the balance, not
            a screen nobody remembers to open. */}
        {captureCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.captures.unassigned}
            onPress={() => router.push('/captures')}
          >
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <View
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.color.brandSoft,
                }}
              >
                <Ionicons
                  name="file-tray-full-outline"
                  size={iconSize.xl}
                  color={theme.color.brand}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="subheading">{t.captures.unassigned}</Text>
                <Text variant="caption" tone="muted">
                  {plural(locale, captureCount, t.captures.unassignedBody)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={iconSize.lg} color={theme.color.textFaint} />
            </Card>
          </Pressable>
        ) : null}

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
            rather than one sum that would be a lie. While the balance is still
            loading a hero-shaped skeleton stands in, rather than a card of
            confident zeros the query has not actually returned yet. */}
        {summary.isLoading ? (
          <HeroSkeleton />
        ) : (
          <HeroCarousel
            trips={activeTrips}
            totals={summary.totals.length > 0 ? summary.totals : [headline]}
            locale={locale}
            t={t}
          />
        )}

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
                <Button
                  label={t.newGroup}
                  size="sm"
                  icon={<Ionicons name="add" size={iconSize.base} color={theme.color.onBrand} />}
                  onPress={openNewGroup}
                  style={{ height: 32, paddingHorizontal: theme.spacing.md, gap: theme.spacing.xs }}
                />
              }
            />
            {presentTypes.length > 1 ? (
              <CategoryStrip types={presentTypes} active={active} onSelect={setCategory} t={t} />
            ) : null}
            <View>
              {visible.map((group, index) => {
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
                    {index < visible.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
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

/** The group types in the order chips appear — matches the new-group picker. */
const GROUP_TYPE_ORDER: readonly GroupType[] = [
  GroupType.Trip,
  GroupType.Home,
  GroupType.Couple,
  GroupType.Event,
  GroupType.Other,
];

/** One Ionicon per group type, echoing the emoji the new-group picker uses. */
const CATEGORY_ICON: Record<GroupType, keyof typeof Ionicons.glyphMap> = {
  [GroupType.Trip]: 'airplane',
  [GroupType.Home]: 'home',
  [GroupType.Couple]: 'heart',
  [GroupType.Event]: 'sparkles',
  [GroupType.Other]: 'people',
};

/** The localized label for a group type, from the same strings the picker uses. */
function categoryLabel(type: GroupType, t: UiStrings): string {
  switch (type) {
    case GroupType.Trip:
      return t.extras.typeTrip;
    case GroupType.Home:
      return t.extras.typeHome;
    case GroupType.Couple:
      return t.extras.typeCouple;
    case GroupType.Event:
      return t.extras.typeEvent;
    case GroupType.Other:
      return t.extras.typeOther;
  }
}

/**
 * The group filter as a strip of icon-over-label tiles — a leading "All" chip,
 * then one per group type the person actually has. The active tile wears the
 * brand fill with a soft shadow; the rest sit quiet in white behind a hairline
 * border. The strip scrolls sideways, so more types never crowd the row.
 */
function CategoryStrip({
  types,
  active,
  onSelect,
  t,
}: {
  types: readonly GroupType[];
  active: GroupType | 'all';
  onSelect: (value: GroupType | 'all') => void;
  t: UiStrings;
}) {
  const theme = useTheme();

  const chips: { key: GroupType | 'all'; icon: keyof typeof Ionicons.glyphMap; label: string }[] = [
    { key: 'all', icon: 'apps', label: t.filterAll },
    ...types.map((type) => ({
      key: type,
      icon: CATEGORY_ICON[type],
      label: categoryLabel(type, t),
    })),
  ];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.xs }}
    >
      {chips.map((chip) => {
        const selected = chip.key === active;
        const ink = selected ? theme.color.onBrand : theme.color.text;
        return (
          <PressableScale
            key={chip.key}
            onPress={() => onSelect(chip.key)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={chip.label}
          >
            <View
              style={{
                width: 74,
                paddingVertical: theme.spacing.md,
                borderRadius: theme.radius.lg,
                alignItems: 'center',
                gap: theme.spacing.xs,
                backgroundColor: selected ? theme.color.brand : theme.color.surface,
                borderWidth: 1,
                borderColor: selected ? theme.color.brand : theme.color.border,
                ...(selected ? theme.shadow.soft : null),
              }}
            >
              <Ionicons
                name={chip.icon}
                size={iconSize.xl}
                color={selected ? theme.color.onBrand : theme.color.textMuted}
              />
              <Text variant="micro" numberOfLines={1} style={{ color: ink }}>
                {chip.label}
              </Text>
            </View>
          </PressableScale>
        );
      })}
    </ScrollView>
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

/** The one fixed height every hero slide takes, so the balance, trip and action
    cards are exactly the same size in the deck — a minimum let the balance card
    (the tallest content) grow past the others and the deck looked ragged. The
    loading skeleton takes this same height, so the swap in is a clean fill. Tall
    enough for the balance card's content at the default text size (~191px). */
export const HERO_CARD_HEIGHT = 196;

/**
 * The dashboard hero: a swipeable deck of cards with a peek of the next one at
 * the right edge and a dot pager beneath (the live dot stretched into a pill),
 * modelled on the podcast-style featured carousel. Any trip running today rides
 * at the front — the most "now" thing on the dashboard — then one card per
 * currency (a total across currencies is a number that does not exist, ADR-004),
 * then the action slides (scan a receipt, add a person) that turn the empty
 * right of the deck into a shortcut instead of dead space.
 *
 * Unlike a bare card, the deck always shows its dots — the peek and the pager
 * are the two signals that say "swipe me", so they stay even when there is a
 * single slide (a fresh account with one currency and no trip). The peek is
 * dropped to zero in that lone case so a single card still fills the width.
 */
function HeroCarousel({
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
    {
      key: 'act:scan',
      node: (
        <ActionSlide
          icon="scan-outline"
          title={t.dashHero.scanTitle}
          body={t.dashHero.scanBody}
          cta={t.dashHero.scanCta}
          colors={theme.gradient.brand}
          onPress={() => router.push('/capture?scan=1')}
        />
      ),
    },
    {
      key: 'act:invite',
      node: (
        <ActionSlide
          icon="person-add-outline"
          title={t.dashHero.inviteTitle}
          body={t.dashHero.inviteBody}
          cta={t.dashHero.inviteCta}
          colors={theme.gradient.accent}
          onPress={() => router.push('/friends/add-person')}
        />
      ),
    },
  ];

  // The deck sits inside the screen's `spacing.xl` gutter. A card is that inner
  // width less a sliver, so the next card's edge shows through on the right; the
  // sliver collapses to nothing when there is only one slide to swipe to.
  const available = width - theme.spacing.xl * 2;
  const gap = theme.spacing.md;
  const peek = slides.length > 1 ? theme.spacing.xxl + theme.spacing.xs : 0;
  const cardWidth = available - peek;
  // Snap card-to-card; the trailing pad lets the last card reach its own snap
  // point instead of stopping a peek short of the edge.
  const snap = cardWidth + gap;

  return (
    <View style={{ gap: theme.spacing.md }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={snap}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        scrollEventThrottle={16}
        contentContainerStyle={{ gap, paddingRight: peek }}
        onMomentumScrollEnd={(event) =>
          setPage(Math.round(event.nativeEvent.contentOffset.x / snap))
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

/**
 * The hero while the balance is still loading — a card-shaped block at the exact
 * `HERO_CARD_HEIGHT` the real deck uses, with a sliver of the next card at the
 * right (the peek) and a three-dot pager beneath. Shaped so the swap to the real
 * carousel is a fill, not a jump: same height, same peek, same dots.
 */
function HeroSkeleton() {
  const theme = useTheme();
  const { animated } = useMotion();
  const { width } = useWindowDimensions();
  const available = width - theme.spacing.xl * 2;
  const peek = theme.spacing.xxl + theme.spacing.xs;
  const cardWidth = available - peek;
  return (
    <View style={{ gap: theme.spacing.md }}>
      {/* The card and the peek sliver, clipped so the sliver never widens the
          row past the gutter. */}
      <View style={{ flexDirection: 'row', gap: theme.spacing.md, overflow: 'hidden' }}>
        <Skeleton
          width={cardWidth}
          height={HERO_CARD_HEIGHT}
          radius={theme.radius.lg}
          animated={animated}
        />
        <Skeleton
          width={peek}
          height={HERO_CARD_HEIGHT}
          radius={theme.radius.lg}
          animated={animated}
        />
      </View>
      <Row style={{ justifyContent: 'center', gap: theme.spacing.xs }}>
        {[0, 1, 2].map((dot) => (
          <View
            key={dot}
            style={{
              width: dot === 0 ? 18 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: dot === 0 ? theme.color.brand : theme.color.border,
            }}
          />
        ))}
      </Row>
    </View>
  );
}

/**
 * A hero action card — the promo-style slide that rides at the tail of the deck.
 * It wears the same gradient wash as the balance cards so the deck reads as one
 * family, with an oversized icon bled into the bottom-right as the "illustration"
 * the reference design leans on, and a call to action beneath the copy. The whole
 * card is the tap target.
 */
/**
 * The faint oversized icon bled off a hero card's bottom-right corner — the
 * "illustration" every slide in the deck carries, so the balance, trip and
 * action cards all read as one family rather than some plain and some drawn on.
 * The card's `Gradient` must set `overflow: 'hidden'` so the bleed clips to the
 * rounded corner. `pointerEvents none` so it never eats the card's own tap.
 */
function HeroBackdropIcon({ name }: { name: keyof typeof Ionicons.glyphMap }) {
  const theme = useTheme();
  return (
    <Ionicons
      name={name}
      size={140}
      color={theme.color.onBrand}
      accessible={false}
      style={{
        position: 'absolute',
        right: -20,
        bottom: -28,
        opacity: 0.16,
        pointerEvents: 'none',
      }}
    />
  );
}

function ActionSlide({
  icon,
  title,
  body,
  cta,
  colors,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  cta: string;
  colors: readonly string[];
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      <Gradient
        colors={colors}
        radius={theme.radius.lg}
        style={{
          padding: theme.spacing.xl,
          height: HERO_CARD_HEIGHT,
          justifyContent: 'space-between',
          gap: theme.spacing.lg,
          overflow: 'hidden',
        }}
      >
        <HeroBackdropIcon name={icon} />
        <View style={{ gap: theme.spacing.xs, paddingRight: 88 }}>
          <Text variant="subheading" tone="onBrand">
            {title}
          </Text>
          <Text variant="caption" tone="onBrand" style={{ opacity: 0.9 }}>
            {body}
          </Text>
        </View>
        <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
          <Text variant="caption" tone="onBrand" style={{ fontWeight: '700' }}>
            {cta}
          </Text>
          <Ionicons name="arrow-forward" size={iconSize.base} color={theme.color.onBrand} />
        </Row>
      </Gradient>
    </PressableScale>
  );
}

/**
 * One balance card, coloured by its verdict: a green wash when the net is owed
 * to you, red when you owe, and the neutral brand wash once everything is
 * settled — so the card's colour, not just its number, tells you where you
 * stand at a glance. The net big, the owed/owe split beneath.
 */
function BalanceCard({ total, locale, t }: { total: CurrencyTotal; locale: string; t: UiStrings }) {
  const theme = useTheme();
  const wash =
    total.net > 0n
      ? theme.gradient.positive
      : total.net < 0n
        ? theme.gradient.negative
        : theme.gradient.brand;
  return (
    <Gradient
      colors={wash}
      radius={theme.radius.lg}
      style={{
        padding: theme.spacing.xl,
        gap: theme.spacing.lg,
        height: HERO_CARD_HEIGHT,
        justifyContent: 'space-between',
        overflow: 'hidden',
      }}
    >
      <HeroBackdropIcon name="wallet-outline" />
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
        radius={theme.radius.lg}
        style={{
          padding: theme.spacing.xl,
          gap: theme.spacing.lg,
          height: HERO_CARD_HEIGHT,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <HeroBackdropIcon name="airplane-outline" />
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
