import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { dayNumber, daysBetween, type GuestGate } from '@waves/core';
import {
  Avatar,
  Button,
  directionalIcon,
  EmptyState,
  Gradient,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Skeleton,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { useCaptures, useGroups, useHomeSummary } from '@/data/hooks';
import { useFlagEnabled } from '@/lib/flags';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { foldedCaptureCount } from '@/lib/captureBatch';
import { useGuestGuard } from '@/lib/guestGuard';
import { usePromptSlot } from '@/lib/promptQueue';
import { useDashboardTips } from '@/lib/tips';
import { TourTarget, useTour } from '@/lib/tour';
import { SyncStatusIcon } from '@/components/SyncBanner';
import { ImportProgressBanner } from '@/components/ImportProgressBanner';
import { SkeletonList } from '@/components/Skeletons';
import { useImportedGroupId } from '@/lib/importProgress';
import { useReducedMotion } from '@/lib/reducedMotion';
import { useDefaultCurrency } from '@/lib/currency';
import { QuickAddSheet, useQuickAddActions } from '@/components/QuickAddSheet';
import { OverflowMenu, type OverflowMenuItem } from '@/components/OverflowMenu';
import { useAvatarUrl } from '@/components/ProfileAvatar';
import { groupLabel, GroupType } from '@/data/types';
import { usePullRefresh } from '@/lib/pullRefresh';

/** Dashboard route with duplicate-safe jumps to stable primary destinations. */
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
  // Unassigned captures now live as a badged inbox glyph in the toolbar rather
  // than a section in the feed.
  const captures = useCaptures();
  // A voice batch counts as one draft on the inbox glyph, not one per item.
  const captureCount = foldedCaptureCount(captures.data ?? []);
  const guard = useGuestGuard();
  const tour = useTour();

  // A press-and-hold on any add icon raises the same quick-add sheet — type,
  // scan, or speak an expense — the phone-home-screen quick-actions gesture.
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const quickAddActions = useQuickAddActions();
  const defaultCurrency = useDefaultCurrency();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  // The eye toggle: hide the money on a shared screen, remembered across opens.
  const { hidden: balanceHidden, ready: balanceReady, toggle: toggleBalance } = useBalanceHidden();
  // The carousel's live scroll offset, owned here so the hero background and the
  // balance deck share one value: the background crossfades between the slide
  // colours (SLIDE_GRADIENTS) exactly as the deck moves. Lazy-init, never
  // re-read through `.current` in render (the ref lint the compiler enforces).
  const [heroScrollX] = useState(() => new Animated.Value(0));
  // Each slide fills the hero's inner width; a slide's snap point is that plus
  // the gap. Computed here so the same numbers drive the deck's layout and the
  // background's colour interpolation — one source, so they can never drift.
  const heroInner = width - theme.spacing.xl * 2;
  const heroGap = theme.spacing.md;
  const heroSnap = heroInner + heroGap;
  // The time-of-day line under the name. The *bucket* is sampled once on mount
  // (lazy init, never a bare Date in render — the React Compiler lints that),
  // then the localised word is read at render so it follows a language change.
  const [greetKey] = useState<'morning' | 'afternoon' | 'evening'>(() => {
    const hour = new Date().getHours();
    return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  });
  const displayName = profile?.display_name ?? t.account.you;

  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

  // A ledger import running in the background (see `@/lib/importProgress`): its
  // banner sits above the group list, and when it lands the just-added group
  // slides into the list. This reads *only* the landed group id (a primitive),
  // so the dashboard re-renders on the success transition alone — never on the
  // running/waiting churn, which would otherwise re-render this heavy screen and
  // make the app crawl while an import ran. The banner owns the running state.
  const justAddedId = useImportedGroupId();

  // First time on Home, once the "seen" flag has been read *and the data has
  // loaded*, run the tour. Waiting on the data matters: the coach-marks anchor
  // on the hero and the add buttons, and starting over skeletons spotlights the
  // wrong rectangle until the real content reflows in under the hole. That
  // includes the balance skeleton — `balanceReady` gates the hero's number, so
  // starting before it settles would anchor the hero mark on the placeholder
  // and then shift when the real amount paints.
  //
  // The ref makes this fire exactly once — without it the effect would re-run
  // each time the tour advances (its value changes) and snap back to step one.
  // It remembers itself when finished; "Take the tour again" in the menu replays.
  const tourStarted = useRef(false);
  useEffect(() => {
    if (tourStarted.current) return;
    if (tour.ready && !tour.seen && !loading && balanceReady) {
      tourStarted.current = true;
      tour.start();
    }
  }, [tour.ready, tour.seen, tour, loading, balanceReady]);

  // The tour holds the top of the prompt queue for the whole of a first run —
  // from the moment we know it is owed (ready, not seen), through the wait for
  // data and the tour itself, until it finishes and marks itself seen. While it
  // holds the slot the daily tip stands down; see `TipSheet`.
  usePromptSlot({ id: 'tour', priority: 100, active: tour.active || (tour.ready && !tour.seen) });

  // The header overflow menu (the three-dot dropdown): the settings and the
  // less-used destinations, surfaced from the dashboard rather than only from
  // the profile tab.
  const [menuOpen, setMenuOpen] = useState(false);
  // The bring-your-own AI-key vault is gated behind a flag until it ships: off
  // for everyone with no flag row, on only where the console turns it on.
  const aiKeysEnabled = useFlagEnabled('ai_keys');
  const menuItems: OverflowMenuItem[] = useMemo(
    () => [
      // The `section` keys are internal grouping only (not user-visible): they
      // cluster the rows into account / data / app / settings, and OverflowMenu
      // draws a divider wherever two adjacent rows fall in different sections.
      {
        icon: 'person-circle-outline',
        label: t.account.yourAccount,
        route: '/settings/account',
        section: 'account',
      },
      {
        icon: 'notifications-outline',
        label: t.account.notifications,
        route: '/settings/notifications',
        section: 'account',
      },
      {
        icon: 'archive-outline',
        label: t.group.archivedTitle,
        route: '/settings/archived',
        section: 'data',
      },
      { icon: 'language-outline', label: t.language, route: '/settings/language', section: 'app' },
      {
        icon: 'contrast-outline',
        label: t.account.themeRow,
        route: '/settings/theme',
        section: 'app',
      },
      ...(aiKeysEnabled
        ? [
            {
              icon: 'key-outline' as const,
              label: t.account.aiKeysRow,
              route: '/settings/ai-keys' as const,
              section: 'app',
            },
          ]
        : []),
      {
        icon: 'settings-outline',
        label: t.account.faceSettings,
        route: '/profile',
        section: 'settings',
      },
      {
        icon: 'sparkles-outline',
        label: t.tour.replay,
        onPress: () => tour.start(),
        section: 'settings',
      },
    ],
    [t, aiKeysEnabled, tour],
  );

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
    currency: defaultCurrency,
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

  // The ids of trips running right now, so their rows can wear an "on trip" tag.
  const ongoingTripIds = new Set(activeTrips.map((tr) => tr.id));
  // "Now" sampled once per mount (a lazy initial state, never re-read as a ref
  // in render) so the "New" window is stable across this screen's renders and
  // the React Compiler stays happy — a bare Date.now() in render trips its lint.
  const [nowMs] = useState(() => Date.now());

  return (
    <Screen edges={[]}>
      {/* The hero is a fixed header — it stays put while only the body below it
          scrolls, matching Friends. */}
      {/* The hero: one saturated green card that runs edge to edge and up under
            the status bar — the reference's signature "account panel". It carries
            the whole top of the screen now: the greeting and face, the swipeable
            balance, and the add actions. Everything below it is the plain white
            body. Wrapped as the tour's "hero" anchor so the first coach-mark still
            spotlights the balance. */}
      <TourTarget id="hero">
        <View
          style={{
            paddingTop: insets.top + theme.spacing.md,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.lg,
            borderBottomLeftRadius: theme.radius.xxl,
            borderBottomRightRadius: theme.radius.xxl,
            gap: theme.spacing.xl,
            overflow: 'hidden',
          }}
        >
          {/* One gradient layer per slide, stacked and clipped to the hero's
                rounded corner. Each fades in as its slide reaches centre and out
                as you leave it (opacity peaks at that slide's snap point, zero at
                its neighbours), so the hero crossfades colour in lock-step with
                the swipe. Native-driven opacity off the shared scroll value —
                smooth at 60fps and free at rest. The first layer sits opaque
                behind everything as the base while the balance loads. */}
          {SLIDE_GRADIENTS.map((colors, index) => (
            <Animated.View
              key={colors[0]}
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                index === 0
                  ? null
                  : {
                      opacity: heroScrollX.interpolate({
                        inputRange: [
                          (index - 1) * heroSnap,
                          index * heroSnap,
                          (index + 1) * heroSnap,
                        ],
                        outputRange: [0, 1, 0],
                        extrapolate: 'clamp',
                      }),
                    },
              ]}
            >
              <Gradient colors={colors} radius={0} style={{ flex: 1 }} />
            </Animated.View>
          ))}

          {/* The corner watermark — a faint glyph per slide that crossfades
                as you swipe, off the same scroll value as the colour. */}
          <HeroBackdrop scrollX={heroScrollX} snap={heroSnap} />

          {/* Greeting row: face + "Hi, {name}" over the time of day, then the
                white controls the reference tucks top-right — sync, a shortcut to
                start a group, and the overflow menu. */}
          <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
            <HeroAvatar
              name={displayName}
              photoUrl={avatarUrl}
              onPress={() => router.navigate('/profile')}
              label={t.profile}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.profile}
              onPress={() => router.navigate('/profile')}
              hitSlop={8}
              style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.5 : 1 })}
            >
              <Text variant="heading" tone="onBrand" numberOfLines={1}>
                {t.dashHero.hi.replace('{name}', displayName)}
              </Text>
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
                {t.dashHero[greetKey]}
              </Text>
            </Pressable>
            <SyncStatusIcon onBrand />
            {/* Start a group — moved up here from the action row, so it sits
                  just before the menu. Still the tour's "add a group" anchor. */}
            <TourTarget id="addGroup">
              <HeroIconButton
                icon="group-add"
                family="material"
                label={t.newGroup}
                onPress={openNewGroup}
              />
            </TourTarget>
            <HeroIconButton
              icon="ellipsis-vertical"
              label={t.account.faceSettings}
              onPress={() => setMenuOpen(true)}
            />
          </Row>

          {/* The swipeable balance — net, then owed, then this month — riding
                on the hero's colour rather than in its own card (ADR-004: no total
                across currencies, so each is its own slide). Its scroll drives the
                background crossfade above. While it loads a light placeholder
                stands in so the number never paints confident zeros. */}
          {summary.isLoading || !balanceReady ? (
            <HeroBalanceSkeleton />
          ) : (
            <HeroBalance
              primary={headline}
              monthSpent={summary.monthSpent}
              locale={locale}
              t={t}
              hidden={balanceHidden}
              onToggleHide={toggleBalance}
              scrollX={heroScrollX}
              cardWidth={heroInner}
              gap={heroGap}
              snap={heroSnap}
              // The mirror hydrates instantly, so the balance shows at once.
              // Until this session's first sync settles it is provisional —
              // "updating" rather than an owe/owed verdict, so the net slide's
              // heading never flips when the sync reconciles (see HeroBalance).
              provisional={summary.pendingFirstSync}
            />
          )}

          {/* The add actions: one white "add expense" pill and two translucent
                circles — scan and the inbox. Starting a group moved up to the
                header cluster. */}
          {/* Buttons and the pager travel together as one block, so the pager
                sits just under the buttons rather than a full hero-gap away. */}
          <View style={{ gap: theme.spacing.md }}>
            <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
              <TourTarget id="addExpense">
                <HeroPill
                  icon="add"
                  label={t.addExpense}
                  onPress={() => router.push('/capture')}
                  onLongPress={() => setQuickAddOpen(true)}
                />
              </TourTarget>
              <Row style={{ marginLeft: 'auto', gap: theme.spacing.sm }}>
                {/* A fresh nonce each tap so the capture screen's consumed-once
                      scan guard survives Android recreating it. */}
                <HeroCircle
                  icon="camera-outline"
                  label={t.scanBill}
                  onPress={() => router.push(`/capture?scan=${Date.now()}`)}
                  onLongPress={() => setQuickAddOpen(true)}
                />
                <HeroCircle
                  icon="file-tray-outline"
                  label={t.captures.title}
                  badge={captureCount || undefined}
                  disabled={captureCount === 0}
                  onPress={() => router.navigate('/captures')}
                />
              </Row>
            </Row>

            {/* The swipe pager, right under the buttons. */}
            <HeroDots count={SLIDE_GRADIENTS.length} scrollX={heroScrollX} snap={heroSnap} />
          </View>
        </View>
      </TourTarget>

      <OverflowMenu visible={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />

      <ScrollView
        contentContainerStyle={{
          paddingBottom: clearance,
          // Fill the viewport so the no-groups empty state can centre itself in
          // whatever height is left under the hero rather than hugging it.
          flexGrow: 1,
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
        {/* The white body beneath the hero: the groups list. Tightened to a
            WhatsApp-style side margin (lg) so the list reads dense, not floaty. */}
        <View
          style={{
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.lg,
            gap: theme.spacing.md,
            flexGrow: 1,
          }}
        >
          {/* A background import's progress lands here, just above the groups —
              the person tapped Import, came home, and watches it fill. */}
          <ImportProgressBanner />

          {loading ? (
            <SkeletonList rows={3} />
          ) : list.length === 0 ? (
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <EmptyState
                title={t.tabs.noGroups}
                icon={
                  <Ionicons name="people-outline" size={iconSize.xxl} color={theme.color.brand} />
                }
              />
            </View>
          ) : (
            <>
              {/* The heading carries the door to the full list: the card below is
                  a capped preview, "All groups" opens the whole roster. */}
              <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="subheading">{t.yourGroups}</Text>
                <Pressable
                  onPress={() => router.navigate('/groups')}
                  accessibilityRole="button"
                  accessibilityLabel={t.allGroups}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 2,
                    opacity: pressed ? 0.5 : 1,
                  })}
                >
                  <Text variant="caption" tone="brand" style={{ fontWeight: '700' }}>
                    {t.allGroups}
                  </Text>
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                </Pressable>
              </Row>
              {/* The groups as one clean list on a single card — an emoji chip, the
                  name and its standing, the balance to the right — the banking-app
                  "recent" list the reference leans on, hairline-divided. Capped to
                  a preview; the full list lives behind "All groups". */}
              <View
                style={{
                  backgroundColor: theme.color.surface,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.color.border,
                  overflow: 'hidden',
                }}
              >
                {list.slice(0, GROUPS_PREVIEW).map((group, index) => {
                  const members = summary.membersFor(group.id);
                  const balance = summary.balanceFor(group.id);
                  // A running trip earns a live "on trip" tag; failing that, a
                  // just-made group wears "New" for its first couple of days.
                  const onTrip = ongoingTripIds.has(group.id);
                  const isNew = nowMs - Date.parse(group.created_at) < NEW_GROUP_WINDOW_MS;
                  const tag = onTrip ? t.tagOnTrip : isNew ? t.tagNew : null;
                  return (
                    <GroupRow
                      key={group.id}
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
                      tag={tag}
                      tagTone={onTrip ? 'positive' : 'brand'}
                      divider={index > 0}
                      // The just-imported group slides and fades into place
                      // rather than blinking in under the success banner.
                      enter={group.id === justAddedId}
                      // Its balance materialises a beat after the group row does,
                      // so mask the amount until the ledger lands rather than show
                      // a confident wrong ₹0 that then jumps to the real figure.
                      pendingBalance={group.id === justAddedId && !summary.hasLedger(group.id)}
                      onPress={() => router.push(`/group/${group.id}`)}
                    />
                  );
                })}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      {/* Guests are nudged to secure their account as an animated popup rather
          than an inline banner — once a day, dismissible. Held back while the
          tour is up so the two do not stack on a guest's first run. */}
      {isGuest ? (
        <GuestPopup gate={guard.gate} t={t} onAction={() => router.push('/settings/account')} />
      ) : null}

      {/* The daily tip, surfaced as a sheet on the first Home open of the day —
          one useful, Baaki-specific move at a time, then out of the way until
          tomorrow. Replaces the inline card so a hint asks for a beat of
          attention rather than sitting as furniture nobody reads. */}
      <TipSheet t={t} />

      <QuickAddSheet
        visible={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        actions={quickAddActions}
      />
    </Screen>
  );
}

/** Translucent white on the green hero — the fill the reference gives its
    on-panel controls, one shade for the circles and the icon buttons. */
const HERO_CONTROL_BG = 'rgba(255, 255, 255, 0.16)';

/**
 * The face at the top of the hero. With a photo it is the ordinary Avatar; with
 * none it is a person glyph inside a ringed, *transparent* circle — the hero's
 * colour shows through rather than an initials chip on a tinted disc, so it sits
 * on the wash the way the reference's placeholder does. White glyph and ring, so
 * one treatment reads on green, teal or indigo alike.
 */
function HeroAvatar({
  name,
  photoUrl,
  onPress,
  label,
}: {
  name: string;
  photoUrl?: string | null;
  onPress: () => void;
  label: string;
}) {
  const theme = useTheme();
  if (photoUrl) {
    return (
      <Avatar
        name={name}
        size={44}
        photoUrl={photoUrl}
        accessibilityLabel={label}
        onPress={onPress}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: 'rgba(255, 255, 255, 0.55)',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name="person-outline" size={iconSize.xxl} color={theme.color.onBrand} />
    </Pressable>
  );
}

/** The AsyncStorage key remembering whether the balance is hidden behind the eye. */
const BALANCE_HIDDEN_KEY = 'dashboard:balanceHidden';

/**
 * The eye toggle's state, remembered across opens. Reads once on mount (so a
 * hidden balance stays hidden after a relaunch, not flashing the number first)
 * and writes on every toggle. Defaults to shown.
 */
function useBalanceHidden(): { hidden: boolean; ready: boolean; toggle: () => void } {
  const [hidden, setHidden] = useState(false);
  // `hidden` starts shown and the stored value arrives a frame or more later,
  // so without a gate the real number paints before the mask does — exactly the
  // flash the doc above promises not to do. `ready` flips once the read settles
  // (success or failure) so the caller can hold the skeleton until then.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(BALANCE_HIDDEN_KEY)
      .then((value) => {
        if (alive && value === '1') setHidden(true);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const toggle = useCallback(() => {
    setHidden((was) => {
      const next = !was;
      void AsyncStorage.setItem(BALANCE_HIDDEN_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);
  return { hidden, ready, toggle };
}

/**
 * The primary add action on the green hero — a white pill with an icon and a
 * label, the reference's "add money" button. A press-and-hold raises the
 * quick-add sheet, the same gesture the circles carry.
 */
function HeroPill({
  icon,
  label,
  onPress,
  onLongPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
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
      <Ionicons name={icon} size={iconSize.lg} color={HERO_GREEN[0]} />
      <Text variant="subheading" style={{ color: HERO_GREEN[0] }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One round action on the green hero — a translucent white disc with a white
 * glyph, the reference's on-panel circles (send, swap, more). Optionally a
 * count badge (the inbox) and a dim disabled state (an empty inbox).
 */
function HeroCircle({
  icon,
  label,
  onPress,
  onLongPress,
  badge,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  badge?: number;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}. ${badge}` : label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: 23,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: HERO_CONTROL_BG,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.xl} color={theme.color.onBrand} />
      {badge ? (
        <View
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            paddingHorizontal: 5,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.negative,
            borderWidth: 2,
            borderColor: HERO_GREEN[1],
          }}
        >
          <Text variant="micro" style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '800' }}>
            {badge > 99 ? '99+' : String(badge)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A bare white glyph in the hero's top-right cluster — the sync icon's
    neighbour, the overflow menu's handle. No disc, so it reads lighter than the
    action circles below. */
function HeroIconButton({
  icon,
  label,
  onPress,
  family = 'ionicons',
}: {
  icon: string;
  label: string;
  onPress: () => void;
  /** Which glyph set `icon` names — Ionicons by default, Material for the ones
   *  Ionicons lacks (the two-people-plus "group add"). */
  family?: 'ionicons' | 'material';
}) {
  const theme = useTheme();
  const Glyph = family === 'material' ? MaterialIcons : Ionicons;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
    >
      <Glyph name={icon as never} size={iconSize.xxl} color={theme.color.onBrand} />
    </Pressable>
  );
}

/** How long after creation a group still counts as "New" — 48 hours. */
const NEW_GROUP_WINDOW_MS = 48 * 60 * 60 * 1000;

/** How many groups the dashboard shows inline before deferring to the full
    "All groups" screen — enough to cover most people's active set without the
    home list growing without bound. */
const GROUPS_PREVIEW = 15;

/** The AsyncStorage key holding the day the guest last closed the prompt. */
const GUEST_PROMPT_DISMISS_KEY = 'guestPrompt:dismissedOn';

/** Today as `YYYY-MM-DD` in the device's own zone — the unit a daily nudge counts in. */
function localToday(): string {
  try {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * A dismissal that only lasts the day. The prompt can be closed, but the close
 * is good until midnight: we store the day it was closed on and show the card
 * again on any later day. So a guest is nudged once a day — not nagged on every
 * open, and not silenced for good. `ready` gates the first paint so the card
 * never flashes in and then vanishes when a same-day dismissal loads a beat later.
 */
function useDailyDismiss(key: string): { hidden: boolean; ready: boolean; dismiss: () => void } {
  const [dismissedOn, setDismissedOn] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(key)
      .then((value) => {
        if (alive) setDismissedOn(value);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [key]);
  const dismiss = useCallback(() => {
    const today = localToday();
    setDismissedOn(today);
    void AsyncStorage.setItem(key, today).catch(() => {});
  }, [key]);
  return { hidden: dismissedOn === localToday(), ready, dismiss };
}

/**
 * The guest's standing prompt — a neutral welcome card, not a second brand block.
 *
 * The balance hero right below it wears the brand wash. The old banner sat in
 * `brandSoft`, so the top of a guest's screen was two purple blocks with no
 * hierarchy — the thing the user flagged. This sits quiet in `surface` behind a
 * hairline with a brand icon chip, so the coloured balance reads as the hero and
 * this reads as the aside: the colour-hero-then-neutral-prompt rhythm the finance
 * references lean on (Starling's welcome card over its balance, Buddy's white
 * setup card under its total).
 *
 * A progress bar draws the trial running down — filled for the time left, so a
 * shrinking bar is the countdown you feel at a glance, not a number you have to
 * read. It empties and turns to warning as the days run out, and once the trial
 * is spent the whole card does (the chip, the bar), so "read-only" lands as a
 * real state rather than decoration.
 *
 * The card carries a close: a guest can dismiss it, but only for the day — it
 * returns tomorrow (see `useDailyDismiss`).
 */
function GuestPopup({
  gate,
  t,
  onAction,
}: {
  gate: GuestGate | null;
  t: UiStrings;
  onAction: () => void;
}) {
  const theme = useTheme();
  const { hidden, ready, dismiss } = useDailyDismiss(GUEST_PROMPT_DISMISS_KEY);
  // Take a turn in the shared prompt queue rather than firing on its own: the
  // guest card waits behind the tour and the push/campaign asks and only shows
  // when it is the live winner. `active` is exactly "would show today" (ready and
  // not dismissed), so it never holds the queue — and blocks the lower-priority
  // tip — while it is hidden for the day.
  const wants = ready && !hidden;
  const granted = usePromptSlot({ id: 'guest', priority: 40, active: wants, delayMs: 300 });
  const visible = wants && granted;

  // A gentle scale-and-fade in, the way the reference presents this card. RN
  // Animated (not reanimated) since this file already drives its counters with
  // it. Held in state (lazy init) rather than a ref so the value is not read
  // through `.current` during render.
  const [opacity] = useState(() => new Animated.Value(0));
  const [scale] = useState(() => new Animated.Value(0.92));
  useEffect(() => {
    if (!visible) return;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 7, useNativeDriver: true }),
    ]).start();
  }, [visible, opacity, scale]);

  if (!visible) return null;

  const expired = gate?.expired ?? false;
  const body = expired
    ? t.tabs.guestReadOnly
    : gate
      ? t.tabs.guestDaysLeft.replace('{days}', String(gate.daysLeft))
      : t.tabs.guestBannerBody;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <View
        style={{
          flex: 1,
          backgroundColor: '#00000080',
          alignItems: 'center',
          justifyContent: 'center',
          padding: theme.spacing.xxxl,
        }}
      >
        <Animated.View
          style={[
            {
              width: '100%',
              maxWidth: 360,
              backgroundColor: theme.color.surface,
              borderRadius: theme.radius.lg,
              padding: theme.spacing.xxl,
              alignItems: 'center',
              gap: theme.spacing.lg,
              ...theme.shadow.lifted,
            },
            { opacity, transform: [{ scale }] },
          ]}
        >
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              backgroundColor: theme.color.buttonPrimary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons
              name={expired ? 'lock-closed' : 'shield-checkmark'}
              size={38}
              color={expired ? theme.color.warning : theme.color.onBrand}
            />
          </View>

          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="heading" align="center">
              {t.tabs.addYourDetails}
            </Text>
            <Text variant="body" tone="muted" align="center">
              {body}
            </Text>
          </View>

          <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm }}>
            <Button label={t.signIn.createAccount} size="lg" fullWidth onPress={onAction} />
            <Button
              label={t.entry.notifyNotNow}
              variant="ghost"
              size="lg"
              fullWidth
              onPress={dismiss}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** The day the tip sheet was last shown, so it surfaces once a day and no more. */
const TIP_SHEET_KEY = 'dashboardTips:shownOn';

/**
 * How long the tip waits once it is cleared to show. On a first run this is the
 * beat after the tour finishes before the hint lands; on any other day it is a
 * small settle so the tip does not race the dashboard in. See `usePromptSlot`.
 */
const TIP_DELAY_MS = 1400;

/**
 * The daily tip, as a bottom sheet.
 *
 * It shows itself once on the first Home open of each day — the deck rotates by
 * the day (see `useDashboardTips`), so a new move surfaces each time rather than
 * the same card sitting inline forever. A big icon over the "TIP" kicker, the
 * title and body, then the way out: a primary that walks to the feature when the
 * tip points somewhere (only the receipt scan does today), and a plain "Got it"
 * otherwise. Tapping the backdrop dismisses it too — a hint never traps.
 *
 * The show is stamped for the day the moment it opens, not on close, so a person
 * who reads it and backgrounds the app is not shown it again on the next open.
 */
function TipSheet({ t }: { t: UiStrings }) {
  const theme = useTheme();
  // A Modal renders above the tab navigator, so the tab-bar clearance does not
  // apply here — the sheet has to clear the device's own bottom inset (the
  // Android nav bar / gesture pill) itself, or the button sits under it.
  const insets = useSafeAreaInsets();
  const { tip } = useDashboardTips(t);

  // The day the sheet was last shown, read once on mount — the same shape the
  // guest prompt's daily dismissal uses, and for the same reason: reading it in a
  // plain mount effect (not one gated on the tip loading) is what actually runs.
  // `ready` gates the first paint so the sheet never flashes before we know.
  const [shownOn, setShownOn] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(TIP_SHEET_KEY)
      .then((value) => {
        if (alive) setShownOn(value);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Wants to show, on the merits: read, unshown today, not closed, has a tip.
  const wants = ready && shownOn !== localToday() && !closed && Boolean(tip);
  // But it only actually opens once the prompt queue clears it — behind the
  // tour on a first run, and after a short delay either way (see TIP_DELAY_MS).
  const granted = usePromptSlot({
    id: 'dashboardTip',
    priority: 10,
    active: wants,
    delayMs: TIP_DELAY_MS,
  });
  const open = wants && granted;

  // Stamp the day the moment the sheet is shown — not on close — so someone who
  // reads it and backgrounds the app is not shown it again on the next open. The
  // write goes straight to storage and deliberately does not touch `shownOn`, so
  // the sheet stays up this session until the person closes it.
  const stamped = useRef(false);
  useEffect(() => {
    if (!open || stamped.current) return;
    stamped.current = true;
    void AsyncStorage.setItem(TIP_SHEET_KEY, localToday()).catch(() => {});
  }, [open]);

  const close = () => setClosed(true);
  const act = () => {
    if (tip?.route) {
      // The scan tip's route carries a constant `scan=` sentinel; swap it for a
      // fresh nonce so the capture screen fires the camera exactly once and does
      // not reopen it when Android recreates the screen on the camera's return.
      const href = tip.route.includes('scan=') ? `/capture?scan=${Date.now()}` : tip.route;
      router.push(href as never);
    }
    close();
  };

  // The Modal stays mounted and is driven by `visible` — toggling a freshly
  // mounted Modal's `visible` to true a beat after first render did not present
  // reliably on Android, which is why an earlier version stamped the day but
  // never appeared. With `tip` still loading there is nothing to show yet.
  return (
    <Modal transparent animationType="fade" visible={open} onRequestClose={close}>
      {tip ? (
        /* Tap outside to close — the same escape the campaign popup gives. */
        <Pressable
          onPress={close}
          accessibilityLabel={t.common.close}
          style={{
            flex: 1,
            backgroundColor: 'rgba(10, 10, 26, 0.55)',
            justifyContent: 'flex-end',
          }}
        >
          {/* Swallows the tap so pressing the sheet itself does not dismiss it. A
            bottom sheet, not a centred dialog: it slides up from the bar the tip
            is about, and leaves the balance above it in view. */}
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: theme.color.surface,
              borderTopLeftRadius: theme.radius.xxl,
              borderTopRightRadius: theme.radius.xxl,
              paddingHorizontal: theme.spacing.xxl,
              paddingTop: theme.spacing.xl,
              paddingBottom: theme.spacing.xxl + insets.bottom,
              gap: theme.spacing.lg,
              ...theme.shadow.lifted,
            }}
          >
            {/* A grab handle — the visual grammar of a sheet you can pull down. */}
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.color.border,
              }}
            />

            <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.color.buttonPrimary,
                }}
              >
                <Ionicons name={tip.icon} size={iconSize.xxl} color={theme.color.onBrand} />
              </View>
              <Text variant="micro" tone="brand" style={{ letterSpacing: 0.8 }}>
                {t.tips.label.toUpperCase()}
              </Text>
              <Text variant="title" align="center">
                {tip.title}
              </Text>
              <Text variant="body" tone="muted" align="center">
                {tip.body}
              </Text>
            </View>

            <View style={{ gap: theme.spacing.sm }}>
              {tip.route ? (
                <>
                  <Button label={t.tips.action} size="lg" fullWidth onPress={act} />
                  <Button
                    label={t.misc.gotIt}
                    variant="secondary"
                    size="sm"
                    fullWidth
                    onPress={close}
                  />
                </>
              ) : (
                <Button label={t.misc.gotIt} size="lg" fullWidth onPress={close} />
              )}
            </View>
          </Pressable>
        </Pressable>
      ) : null}
    </Modal>
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
 * One saturated wash per balance slide, so the whole hero takes a colour of its
 * own as you swipe — green for where you stand, teal for what you're owed, indigo
 * for what you've spent. Each is a two-stop diagonal gradient, dark enough that
 * the white ink clears AA on either stop in both themes (like a bank card, the
 * hero keeps its colour whichever theme is on). Money's own red/green still lives
 * on the ledger rows below, where owe-vs-owed has to be told apart at a glance.
 *
 * The order matches the slides in `HeroBalance` (net, owed, month); the hero
 * crossfades between them driven by the carousel's scroll position.
 */
const SLIDE_GRADIENTS = [
  ['#1F6B49', '#0C3A27'], // net — green
  ['#12667A', '#06323D'], // owed — teal
  ['#463F86', '#221C46'], // month — indigo
] as const;

/**
 * One watermark glyph per slide, in the same order (net, owed, month). It rides
 * the corner of the hero as a faint, oversized outline and crossfades on the
 * same scroll value as the colour, so the mark swaps as you swipe: a wallet for
 * where you stand, a rising line for what is owed to you, a calendar for the
 * month's spend. Kept large + low-alpha so it reads as texture behind the
 * balance, not a literal icon competing with it.
 */
const SLIDE_ICONS = ['wallet-outline', 'trending-up-outline', 'calendar-outline'] as const;

/** The first slide's green, reused for the accents that sit on white (the
    add-expense pill's ink) and the badge ring — a fixed brand green, not the
    animated hero colour. */
const HERO_GREEN = SLIDE_GRADIENTS[0];

/**
 * The swipeable balance inside the hero: three views of where you stand, one per
 * swipe, riding transparent on the hero's colour — net first (the number you see
 * on load), then what is owed to you, then what you have spent this month. All in
 * your primary currency, because a total across currencies is a number that does
 * not exist (ADR-004). A dot pager beneath is the "swipe me" signal; the three
 * slides are the same shape, so the block never jumps as you move between them.
 *
 * The scroll offset (`scrollX`) and the slide geometry (`cardWidth`/`gap`/`snap`)
 * are owned by the screen and passed in, so the same value that lays the deck out
 * also drives the hero's colour crossfade — the two can never fall out of step.
 */
function HeroBalance({
  primary,
  monthSpent,
  locale,
  t,
  provisional,
  hidden,
  onToggleHide,
  scrollX,
  cardWidth,
  gap,
  snap,
}: {
  primary: CurrencyTotal;
  /** My share of this month's spend, per currency (from useHomeSummary). */
  monthSpent: readonly { currency: string; amount: bigint }[];
  locale: string;
  t: UiStrings;
  /** True until this session's first sync settles: the net slide's heading is
   *  held at "updating" so it never flips owe↔owed when the sync reconciles. */
  provisional: boolean;
  /** The eye toggle — masks every slide's figure while on. */
  hidden: boolean;
  onToggleHide: () => void;
  /** Shared scroll offset — the screen also reads it to crossfade the hero. */
  scrollX: Animated.Value;
  /** One slide's width, the gap between slides, and the snap step (width + gap). */
  cardWidth: number;
  gap: number;
  snap: number;
}) {
  // The three balance views the dashboard leads with, one per swipe: where you
  // stand overall (net), what is owed to you, and what you have spent this month
  // — all in your primary currency, which is the one the headline is already in
  // (no total across currencies, ADR-004).
  const monthAmount = monthSpent.find((entry) => entry.currency === primary.currency)?.amount ?? 0n;
  // The net slide shows its figure as an ABSOLUTE value, so the owe↔owed
  // direction has to live in the heading — this is the only slide whose sign
  // carries meaning. We fold that verdict into the label itself (a Title-case
  // phrase that matches the other slides' headings) so a single line still
  // tells you which way you stand, now that the old third "sub" line is gone.
  // The real owe↔owed verdict, shown even before the first sync settles: rather
  // than masking it behind an "updating" label, each slide carries a small
  // spinner (see `busy` on MetricSlide) while the sync is still in flight, so
  // the direction is there to read and the spinner says it may yet change.
  const netDirection =
    primary.net === 0n ? t.allSettled : primary.net > 0n ? t.dashHero.netOwed : t.dashHero.netOwe;

  const slides = [
    {
      key: 'net',
      node: (
        <MetricSlide
          label={`${netDirection} · ${primary.currency}`}
          amount={primary.net < 0n ? -primary.net : primary.net}
          currency={primary.currency}
          locale={locale}
          hidden={hidden}
          onToggleHide={onToggleHide}
          busy={provisional}
        />
      ),
    },
    {
      key: 'owed',
      node: (
        <MetricSlide
          label={`${t.dashHero.owedToYou} · ${primary.currency}`}
          amount={primary.owed}
          currency={primary.currency}
          locale={locale}
          hidden={hidden}
          onToggleHide={onToggleHide}
          busy={provisional}
        />
      ),
    },
    {
      key: 'month',
      node: (
        <MetricSlide
          label={`${t.dashHero.monthSpent} · ${primary.currency}`}
          amount={monthAmount}
          currency={primary.currency}
          locale={locale}
          hidden={hidden}
          onToggleHide={onToggleHide}
          busy={provisional}
        />
      ),
    },
  ];

  // Each slide fills the hero's inner width (`cardWidth`), snapping one-to-one.
  // No peek of the next slide: they are transparent on the hero's colour, so a
  // peek would show the next slide's floating text with no card edge to read it
  // as "another card". The dot pager carries the "swipe me" signal instead.
  const rangeFor = (index: number): number[] => [
    (index - 1) * snap,
    index * snap,
    (index + 1) * snap,
  ];

  return (
    <Animated.ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={snap}
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      scrollEventThrottle={16}
      contentContainerStyle={{ gap }}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
        useNativeDriver: true,
      })}
    >
      {slides.map((slide, index) => (
        <Animated.View
          key={slide.key}
          style={{
            width: cardWidth,
            // The centred slide sits at full size; the one being dragged in
            // grows and brightens into focus as it reaches centre. Transform +
            // opacity only, both native-driven.
            opacity: scrollX.interpolate({
              inputRange: rangeFor(index),
              outputRange: [0.75, 1, 0.75],
              extrapolate: 'clamp',
            }),
            transform: [
              {
                scale: scrollX.interpolate({
                  inputRange: rangeFor(index),
                  outputRange: [0.94, 1, 0.94],
                  extrapolate: 'clamp',
                }),
              },
            ],
          }}
        >
          {slide.node}
        </Animated.View>
      ))}
    </Animated.ScrollView>
  );
}

/**
 * The dot pager — the "swipe me" signal, rendered by the screen below the action
 * buttons rather than under the balance. A wide white pill marks the active slide
 * over a row of faint dots that read against any of the slide washes.
 *
 * The pill slides off the carousel's live `scrollX`, native-driven, so it tracks
 * the finger at 60fps exactly like the hero colour crossfade — not off a React
 * state that only lands at `onMomentumScrollEnd`, which is what made the dots lag
 * a beat behind the swipe. Native driver animates transform/opacity only (never
 * width or colour), so the active mark is a fixed-width pill that *translates*
 * across static dots rather than one dot growing and the row reflowing.
 */
const DOT_SIZE = 6;
const DOT_ACTIVE_WIDTH = 18;

function HeroDots({
  count,
  scrollX,
  snap,
}: {
  count: number;
  scrollX: Animated.Value;
  snap: number;
}) {
  const theme = useTheme();
  const gap = theme.spacing.xs;
  const step = DOT_SIZE + gap; // centre-to-centre distance between dots
  const trackWidth = count * DOT_SIZE + Math.max(0, count - 1) * gap;
  // Map scroll offset (0, snap, 2·snap, …) to the pill's position over each dot.
  // interpolate needs ≥2 strictly-ascending inputs, so a lone slide is a static
  // pill with no interpolation.
  const translateX =
    count > 1
      ? scrollX.interpolate({
          inputRange: Array.from({ length: count }, (_, i) => i * snap),
          outputRange: Array.from({ length: count }, (_, i) => i * step),
          extrapolate: 'clamp',
        })
      : 0;
  return (
    <Row style={{ justifyContent: 'center' }}>
      <View style={{ width: trackWidth, height: DOT_SIZE }}>
        <Row style={{ position: 'absolute', left: 0, top: 0, gap }}>
          {Array.from({ length: count }, (_, index) => (
            <View
              key={index}
              style={{
                width: DOT_SIZE,
                height: DOT_SIZE,
                borderRadius: DOT_SIZE / 2,
                backgroundColor: 'rgba(255, 255, 255, 0.35)',
              }}
            />
          ))}
        </Row>
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            // Seat the wide pill centred on the first dot; the translate then
            // carries that centre from dot to dot.
            left: (DOT_SIZE - DOT_ACTIVE_WIDTH) / 2,
            width: DOT_ACTIVE_WIDTH,
            height: DOT_SIZE,
            borderRadius: DOT_SIZE / 2,
            backgroundColor: '#FFFFFF',
            transform: [{ translateX }],
          }}
        />
      </View>
    </Row>
  );
}

/**
 * The balance area while it loads — translucent-white bars on the green that
 * stand in for a `MetricSlide`: a label bar and the big figure. It has the same
 * two lines the loaded slide now has (the sub line is gone).
 *
 * The whole point is that the swap-in is a settle, not a jump, so the skeleton
 * is built to the *exact* height a loaded slide fills. Each bar rides inside a
 * wrapper sized to the real line's height — the label to the caption's 18px
 * line, the figure to the money's 46px line, one `spacing.sm` gap between — so
 * the block is 72px tall either way and the number lands in place instead of
 * shoving the Add-expense button and the group list down (the layout shift the
 * user flagged). A gentle pulse reads as "loading" rather than a dead
 * placeholder. Plain `Skeleton` is themed for light surfaces and would vanish on
 * the green, so these are hand-drawn washes.
 */
function HeroBalanceSkeleton() {
  const theme = useTheme();
  // A slow breathe so the bars read as loading. Lazy-init state, never through a
  // ref in render (the React Compiler lints that), native-driven opacity.
  const [pulse] = useState(() => new Animated.Value(0.5));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const bar = (width: number, height: number) => (
    <View
      style={{ width, height, borderRadius: height / 2, backgroundColor: 'rgba(255,255,255,0.28)' }}
    />
  );
  return (
    <Animated.View style={{ gap: theme.spacing.sm, opacity: pulse }}>
      {/* Label line — the caption+eye row rides an 18px line height. */}
      <View style={{ height: 18, justifyContent: 'center' }}>{bar(120, 12)}</View>
      {/* The figure — the money sits on a 46px line (fontSize 40). */}
      <View style={{ height: 46, justifyContent: 'center' }}>{bar(200, 34)}</View>
    </Animated.View>
  );
}

/**
 * The hero's corner decoration: one faint watermark glyph per balance slide,
 * bled off the bottom-right, that crossfades as the carousel navigates. Each
 * layer peaks in opacity at its own slide's snap point and is zero at its
 * neighbours — the exact interpolation the colour layers use — off the same
 * shared `scrollX`, so the mark swaps in lock-step with the colour and the
 * swipe. Native-driven opacity: smooth at 60fps, free at rest. The hero clips
 * it to the rounded corner (`overflow: 'hidden'`) and `pointerEvents none` so
 * it never eats a tap; white at low alpha reads the same on green/teal/indigo.
 */
function HeroBackdrop({ scrollX, snap }: { scrollX: Animated.Value; snap: number }) {
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {SLIDE_ICONS.map((icon, index) => (
        <Animated.View
          key={icon}
          style={{
            position: 'absolute',
            right: -44,
            bottom: -52,
            opacity: scrollX.interpolate({
              inputRange: [(index - 1) * snap, index * snap, (index + 1) * snap],
              outputRange: [0, 0.16, 0],
              extrapolate: 'clamp',
            }),
          }}
        >
          <Ionicons name={icon} size={208} color={theme.color.onBrand} />
        </Animated.View>
      ))}
    </View>
  );
}

/**
 * One balance slide, riding transparent on the hero's green — a label with the
 * eye toggle to its right and the money big beneath it. Two lines only: the old
 * third "sub" caption is gone, so the slide is tighter and the hero shorter. The
 * label carries everything the sub used to say — on the net slide it is the
 * owe↔owed verdict itself (see `netDirection` in `HeroBalance`), so dropping the
 * sub loses no direction. White ink throughout, so it reads the same in light
 * and dark like a bank card. The eye masks the figure to dots; the toggle sits
 * on every slide (it is the same control repeated as you swipe), so the eye is
 * always to hand wherever you land.
 */
function MetricSlide({
  label,
  amount,
  currency,
  locale,
  hidden,
  onToggleHide,
  busy = false,
}: {
  label: string;
  amount: bigint;
  currency: string;
  locale: string;
  hidden: boolean;
  onToggleHide: () => void;
  /** Sync still in flight — a small spinner beside the eye says the figure may
   *  yet change, without hiding the real label behind an "updating" placeholder. */
  busy?: boolean;
}) {
  const theme = useTheme();
  const { t } = useStrings();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="caption" tone="onBrand" numberOfLines={1} style={{ flexShrink: 1 }}>
          {label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hidden ? t.dashHero.showBalance : t.dashHero.hideBalance}
          onPress={onToggleHide}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 0.85 })}
        >
          <Ionicons
            name={hidden ? 'eye-off-outline' : 'eye-outline'}
            size={iconSize.md}
            color={theme.color.onBrand}
          />
        </Pressable>
        {busy ? (
          <ActivityIndicator
            size="small"
            color={theme.color.onBrand}
            accessibilityLabel={t.dashHero.updating}
          />
        ) : null}
      </Row>
      {hidden ? (
        <Text tone="onBrand" style={{ fontSize: 40, lineHeight: 46, fontWeight: '700' }}>
          {'••••••'}
        </Text>
      ) : (
        <MoneyText
          amount={amount}
          currency={currency as never}
          locale={locale}
          tone="onBrand"
          style={{ fontSize: 40, lineHeight: 46, fontWeight: '700' }}
        />
      )}
    </View>
  );
}

/**
 * One group as a clean list row — an emoji chip, the name over its member count
 * and standing, the balance to the right coloured by who owes whom. The banking
 * "recent" row applied to a group; the whole row is the tap into the group.
 */
function GroupRow({
  title,
  memberLabel,
  coverEmoji,
  balance,
  currency,
  locale,
  statusLabel,
  pendingLabel,
  tag,
  tagTone,
  divider,
  enter = false,
  pendingBalance = false,
  onPress,
}: {
  title: string;
  memberLabel: string;
  coverEmoji: string | null;
  balance: bigint;
  currency: string;
  locale: string;
  statusLabel: string;
  pendingLabel: string | null;
  tag: string | null;
  tagTone: 'positive' | 'brand';
  /** True while this group's balance is still materialising (just after an
      import): the amount is masked with a skeleton instead of a wrong zero. */
  pendingBalance?: boolean;
  /** A hairline above the row — every row but the first, so the card reads as
      one divided list rather than a stack of loose cards. */
  divider: boolean;
  /** True for a row that has just arrived (a fresh import): it fades and slides
      into place on mount rather than blinking in. */
  enter?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  // Money's own colour, kept for the ledger even though the hero is green:
  // owed-to-you positive, you-owe negative, square is quiet.
  const tone = balance === 0n ? 'muted' : balance > 0n ? 'positive' : 'negative';

  // The entrance: start dropped and clear, settle into place. Only for a row
  // flagged `enter` (a just-imported group), and never under reduce motion —
  // otherwise the row is static at rest. Lazy-init state, never a ref read in
  // render (the React Compiler lints that), transform+opacity native-driven.
  const shouldAnimate = enter && !reduceMotion;
  const anim = useState(() => new Animated.Value(shouldAnimate ? 0 : 1))[0];
  useEffect(() => {
    if (!shouldAnimate) return;
    const run = Animated.spring(anim, {
      toValue: 1,
      friction: 8,
      tension: 60,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [shouldAnimate, anim]);

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${statusLabel}`}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          paddingHorizontal: theme.spacing.xs,
          borderTopWidth: divider ? 1 : 0,
          borderTopColor: theme.color.border,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: theme.color.surfaceMuted,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 20 }}>{coverEmoji ?? '👥'}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Text variant="body" numberOfLines={1} style={{ flexShrink: 1, fontWeight: '600' }}>
              {title}
            </Text>
            {tag ? (
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                  borderRadius: 6,
                  backgroundColor:
                    tagTone === 'positive' ? theme.color.positiveSoft : theme.color.brandSoft,
                }}
              >
                <Text
                  variant="micro"
                  tone={tagTone === 'positive' ? 'positive' : 'brand'}
                  style={{ fontWeight: '700' }}
                >
                  {tag}
                </Text>
              </View>
            ) : null}
          </Row>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {pendingLabel ?? `${memberLabel} · ${statusLabel}`}
          </Text>
        </View>
        {pendingBalance ? (
          <Skeleton width={64} height={16} radius={6} animated={!reduceMotion} />
        ) : (
          <MoneyText
            amount={balance < 0n ? -balance : balance}
            currency={currency as never}
            locale={locale}
            tone={tone}
            style={{ fontWeight: '700' }}
          />
        )}
      </Pressable>
    </Animated.View>
  );
}
