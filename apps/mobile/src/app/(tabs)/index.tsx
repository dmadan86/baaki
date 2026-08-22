import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  Animated,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';

import { dayNumber, daysBetween, type GuestGate } from '@waves/core';
import {
  Avatar,
  Button,
  EmptyState,
  Gradient,
  iconSize,
  Row,
  Screen,
  Skeleton,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { useCaptures, useGroups, useHomeSummary } from '@/data/hooks';
import { CountUpMoney, PressableScale } from '@/lib/anim';
import { useMotion } from '@/lib/motion';
import { useFlagEnabled } from '@/lib/flags';
import { deviceDefaultCurrency, plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';
import { usePromptSlot } from '@/lib/promptQueue';
import { useDashboardTips } from '@/lib/tips';
import { TourTarget, useTour } from '@/lib/tour';
import { SyncStatusIcon } from '@/components/SyncBanner';
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
  // Unassigned captures now live as a badged inbox glyph in the toolbar rather
  // than a section in the feed.
  const captures = useCaptures();
  const captureCount = captures.data?.length ?? 0;
  const guard = useGuestGuard();
  const tour = useTour();

  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

  // First time on Home, once the "seen" flag has been read *and the data has
  // loaded*, run the tour. Waiting on the data matters: the coach-marks anchor
  // on the hero and the add buttons, and starting over skeletons spotlights the
  // wrong rectangle until the real content reflows in under the hole.
  //
  // The ref makes this fire exactly once — without it the effect would re-run
  // each time the tour advances (its value changes) and snap back to step one.
  // It remembers itself when finished; "Take the tour again" in the menu replays.
  const tourStarted = useRef(false);
  useEffect(() => {
    if (tourStarted.current) return;
    if (tour.ready && !tour.seen && !loading) {
      tourStarted.current = true;
      tour.start();
    }
  }, [tour.ready, tour.seen, tour, loading]);

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
      {
        icon: 'cloud-done-outline',
        label: t.backup.title,
        route: '/settings/backup',
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

  // The ids of trips running right now, so their rows can wear an "on trip" tag.
  const ongoingTripIds = new Set(activeTrips.map((tr) => tr.id));
  // "Now" sampled once per mount (a lazy initial state, never re-read as a ref
  // in render) so the "New" window is stable across this screen's renders and
  // the React Compiler stays happy — a bare Date.now() in render trips its lint.
  const [nowMs] = useState(() => Date.now());

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
          {/* The sync state as one glyph, to the left of the camera — a quiet
              cloud when there are unsent changes or no connection, a turning
              arrow mid-sync, a red mark for a refused change. Nothing when all is
              well. It replaces the wide banner the dashboard used to carry. */}
          <SyncStatusIcon />
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

        {/* One deck of swipeable cards. The balance rides at the front as the first
            slide — the number you see on load — then any second currency (no
            total across them, ADR-004), any running trip, and the two shortcuts.
            This used to be a flat balance card with a *second* swipeable deck
            beneath it, which read as two carousels stacked; the finance apps in
            the category (Cleo, Monzo, Wise) all keep balances as slides of a
            single deck. While the balance loads a hero-shaped skeleton stands in
            rather than a card of confident zeros the query has not returned. */}
        <TourTarget id="hero">
          {summary.isLoading || summary.pendingFirstSync ? (
            <HeroSkeleton />
          ) : (
            <HeroDeck
              primary={headline}
              trips={activeTrips}
              totals={summary.totals.slice(1)}
              locale={locale}
              t={t}
            />
          )}
        </TourTarget>

        {/* The things you start on this screen, as plain icon buttons under the
            deck: scan, add a spend, make a group, open the inbox. */}
        <Row
          style={{
            justifyContent: 'space-evenly',
            columnGap: theme.spacing.sm,
            paddingVertical: theme.spacing.xs,
          }}
        >
          {/* Scan a receipt leads the row. The camera moved out of the header
              to sit with the other add actions. A fresh nonce each tap so the
              capture screen's consumed-once scan guard survives Android
              recreating it. */}
          <AddAction
            icon="camera-outline"
            label={t.scanBill}
            onPress={() => router.push(`/capture?scan=${Date.now()}`)}
          />
          <AddAction
            icon="add"
            label={t.addExpense}
            tourId="addExpense"
            onPress={() => router.push('/capture')}
          />
          <AddAction icon="people" label={t.newGroup} tourId="addGroup" onPress={openNewGroup} />
          {/* The captures inbox always holds its place in the row. It carries a
              count while something is waiting; with an empty inbox it stays put
              but sits dim and unpressable. */}
          <AddAction
            icon="file-tray-outline"
            label={t.captures.title}
            badge={captureCount || undefined}
            disabled={captureCount === 0}
            onPress={() => router.push('/captures')}
          />
        </Row>

        {loading ? (
          <SkeletonList rows={3} />
        ) : list.length === 0 ? (
          <EmptyState
            title={t.tabs.noGroups}
            icon={<Ionicons name="people-outline" size={iconSize.xxl} color={theme.color.brand} />}
          />
        ) : (
          <View>
            <View>
              {list.map((group, index) => {
                const members = summary.membersFor(group.id);
                const balance = summary.balanceFor(group.id);
                // A running trip earns a live "on trip" tag; failing that, a
                // just-made group wears "New" for its first couple of days.
                const onTrip = ongoingTripIds.has(group.id);
                const isNew = nowMs - Date.parse(group.created_at) < NEW_GROUP_WINDOW_MS;
                const tag = onTrip ? t.tagOnTrip : isNew ? t.tagNew : null;
                return (
                  <View key={group.id}>
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
                      tag={tag}
                      tagTone={onTrip ? 'positive' : 'brand'}
                      onPress={() => router.push(`/group/${group.id}`)}
                    />
                    {index < list.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Guests are nudged to secure their account as an animated popup rather
          than an inline banner — once a day, dismissible. Held back while the
          tour is up so the two do not stack on a guest's first run. */}
      {isGuest && !tour.active ? (
        <GuestPopup gate={guard.gate} t={t} onAction={() => router.push('/settings/account')} />
      ) : null}

      {/* The daily tip, surfaced as a sheet on the first Home open of the day —
          one useful, Baaki-specific move at a time, then out of the way until
          tomorrow. Replaces the inline card so a hint asks for a beat of
          attention rather than sitting as furniture nobody reads. */}
      <TipSheet t={t} />
    </Screen>
  );
}

/**
 * One quick-add button under the deck: a plain inked glyph with its label
 * beneath — no filled disc, the way a services row reads. The actions are the
 * same ones the FAB and the new-group flow reach, surfaced where the eye lands
 * after the balance.
 */
function AddAction({
  icon,
  label,
  onPress,
  badge,
  disabled,
  tourId,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  /** An optional count on the glyph — e.g. how many captures are waiting. */
  badge?: number;
  /** Keep the button in place but dim and unpressable — e.g. an empty inbox. */
  disabled?: boolean;
  /** When set, the glyph (only) is a tour target, so a coach-mark's hole hugs
      the icon rather than the icon plus its caption. */
  tourId?: string;
}) {
  const theme = useTheme();
  const iconTarget = (
    <View
      style={{
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name={icon} size={28} color={theme.color.text} />
      {badge ? (
        <View
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            paddingHorizontal: 5,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.brand,
            borderWidth: 2,
            borderColor: theme.color.bg,
          }}
        >
          <Text
            variant="micro"
            style={{ color: theme.color.onBrand, fontSize: 11, fontWeight: '800' }}
          >
            {badge > 99 ? '99+' : String(badge)}
          </Text>
        </View>
      ) : null}
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}. ${badge}` : label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        alignItems: 'center',
        gap: theme.spacing.xs,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      {tourId ? <TourTarget id={tourId}>{iconTarget}</TourTarget> : iconTarget}
      <Text variant="caption" tone="muted" numberOfLines={1} style={{ textAlign: 'center' }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** How long after creation a group still counts as "New" — 48 hours. */
const NEW_GROUP_WINDOW_MS = 48 * 60 * 60 * 1000;

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
  const { animated } = useMotion();
  const { hidden, ready, dismiss } = useDailyDismiss(GUEST_PROMPT_DISMISS_KEY);
  const visible = ready && !hidden;

  // A gentle scale-and-fade in, the way the reference presents this card. RN
  // Animated (not reanimated) since this file already drives its counters with
  // it; motion off starts it settled. Held in state (lazy init) rather than a
  // ref so the value is not read through `.current` during render.
  const [opacity] = useState(() => new Animated.Value(animated ? 0 : 1));
  const [scale] = useState(() => new Animated.Value(animated ? 0.92 : 1));
  useEffect(() => {
    if (!visible || !animated) return;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 7, useNativeDriver: true }),
    ]).start();
  }, [visible, animated, opacity, scale]);

  if (!visible) return null;

  const expired = gate?.expired ?? false;
  const body = expired
    ? t.tabs.guestReadOnly
    : gate
      ? t.tabs.guestDaysLeft.replace('{days}', String(gate.daysLeft))
      : t.tabs.guestBannerBody;
  const accent = expired ? theme.color.warning : theme.color.brand;

  return (
    <Modal visible transparent animationType={animated ? 'fade' : 'none'} onRequestClose={dismiss}>
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
              backgroundColor: theme.color.brandSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons
              name={expired ? 'lock-closed' : 'shield-checkmark'}
              size={38}
              color={accent}
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
                  backgroundColor: theme.color.brandSoft,
                }}
              >
                <Ionicons name={tip.icon} size={iconSize.xxl} color={theme.color.brand} />
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

/** The one fixed height every hero slide takes, so the balance, trip and action
    cards are exactly the same size in the deck — a minimum let the balance card
    (the tallest content) grow past the others and the deck looked ragged. The
    loading skeleton takes this same height, so the swap in is a clean fill. Tall
    enough for the balance card's content at the default text size (~191px). */
export const HERO_CARD_HEIGHT = 196;

/**
 * The one swipeable deck on the dashboard: a peek of the next card at the right
 * edge and a dot pager beneath. The balance rides at the front as the first
 * slide — the number you see on load, never behind a gesture on arrival — then
 * any running trip (the most "now" thing), any second currency (a total across
 * them is a number that does not exist, ADR-004), and the two shortcut slides
 * (scan a receipt, add a person) that turn the empty right of the deck into a
 * shortcut instead of dead space.
 *
 * Every slide is the same height (`HERO_CARD_HEIGHT`) so the deck never jumps as
 * you swipe — the pattern Cleo and Wise use for a balance-card carousel. The peek
 * and the pager are the two signals that say "swipe me", so they stay even for a
 * single slide; the peek drops to zero in that lone case so one card fills the
 * width.
 */
function HeroDeck({
  primary,
  trips,
  totals,
  locale,
  t,
}: {
  primary: CurrencyTotal;
  trips: readonly TripSlide[];
  totals: readonly CurrencyTotal[];
  locale: string;
  t: UiStrings;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { animated } = useMotion();
  // Lazy-initialised once and never replaced (the same pattern the voice mic’s
  // animations use); a plain `useRef().current` read trips react-hooks/refs.
  const [scrollX] = useState(() => new Animated.Value(0));

  const slides = [
    {
      key: `cur:${primary.currency}:primary`,
      node: <BalanceCard total={primary} locale={locale} t={t} />,
    },
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
          onPress={() => router.push(`/capture?scan=${Date.now()}`)}
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

  // Each card’s distance from centred, in scroll units — the three points a
  // card passes through as it moves from the peek on the right, to centred, to
  // the peek on the left. Interpolating on the live offset (not on a settled
  // page) is what makes the growth track the finger instead of snapping after
  // momentum ends: Apple’s “hint in the direction of the gesture”.
  const rangeFor = (index: number): number[] => [
    (index - 1) * snap,
    index * snap,
    (index + 1) * snap,
  ];

  return (
    <View style={{ gap: theme.spacing.md }}>
      <Animated.ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={snap}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        scrollEventThrottle={16}
        contentContainerStyle={{ gap, paddingRight: peek }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
          useNativeDriver: true,
        })}
      >
        {slides.map((slide, index) => (
          <Animated.View
            key={slide.key}
            style={{
              width: cardWidth,
              // The centred card sits at full size; its neighbours fall back a
              // touch, so the peek reads as depth and the incoming card grows
              // into focus as you swipe to it. Transform + opacity only, both
              // native-driven. Motion off leaves every card flat and full.
              ...(animated
                ? {
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
                  }
                : null),
            }}
          >
            {slide.node}
          </Animated.View>
        ))}
      </Animated.ScrollView>
    </View>
  );
}

/**
 * The deck while the balance is still loading — the front card at its real height
 * with a sliver of the next one at the right (the peek), and a three-dot pager
 * beneath. Shaped so the swap to the real deck is a fill, not a jump: same
 * height, same peek, same dots.
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
      {/* The front card and the peek sliver, clipped so the sliver never widens
          the row past the gutter. */}
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
          gap: theme.spacing.sm,
          overflow: 'hidden',
        }}
      >
        <HeroBackdropIcon name={icon} />
        <View style={{ gap: 2, paddingRight: 72 }}>
          <Text variant="subheading" tone="onBrand" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="micro" tone="onBrand" numberOfLines={2} style={{ opacity: 0.9 }}>
            {body}
          </Text>
        </View>
        <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
          <Text variant="micro" tone="onBrand" style={{ fontWeight: '700' }}>
            {cta}
          </Text>
          <Ionicons name="arrow-forward" size={iconSize.base} color={theme.color.onBrand} />
        </Row>
      </Gradient>
    </PressableScale>
  );
}

/**
 * One balance card, coloured by its verdict: a teal wash when the net is owed
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
      {/* Currencies are never summed (ADR-004), so the deck can carry a card per
          currency. The code rides in the heading — not just a corner chip — so
          two balance cards read as "your USD" and "your INR", never as two
          identical "Your balance". */}
      <Text variant="caption" tone="onBrand">
        {`${t.yourBaaki} · ${total.currency}`}
      </Text>

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
          gap: theme.spacing.sm,
          height: HERO_CARD_HEIGHT,
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        <HeroBackdropIcon name="airplane-outline" />
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Row style={{ gap: theme.spacing.sm, alignItems: 'center', flex: 1 }}>
            <Text variant="caption">{trip.coverEmoji ?? '🧳'}</Text>
            <Text variant="caption" tone="onBrand" numberOfLines={1} style={{ flex: 1 }}>
              {trip.title}
            </Text>
          </Row>
          <Text variant="micro" tone="onBrand">
            {trip.currency}
          </Text>
        </Row>

        <Text tone="onBrand" style={{ fontSize: 24, lineHeight: 30, fontWeight: '700' }}>
          {t.tripDay.replace('{day}', String(trip.day)).replace('{total}', String(trip.total))}
        </Text>

        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <Text variant="micro" tone="onBrand">
              {net === 0n ? t.allSettled : net > 0n ? t.youAreOwed : t.youOwe}
            </Text>
            <CountUpMoney
              amount={net < 0n ? -net : net}
              currency={trip.currency as never}
              locale={locale}
              tone="onBrand"
              variant="caption"
            />
          </View>
          <Text variant="micro" tone="onBrand">
            {t.plan}
          </Text>
        </Row>
      </Gradient>
    </PressableScale>
  );
}
