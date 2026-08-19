import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';

import { dayNumber, daysBetween, GUEST_TRIAL_DAYS, type GuestGate } from '@waves/core';
import {
  Avatar,
  Button,
  Card,
  ChipRow,
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
} from '@waves/ui';

import { useGroups, useHomeSummary } from '@/data/hooks';
import { CountUpMoney, PressableScale } from '@/lib/anim';
import { useMotion } from '@/lib/motion';
import { deviceDefaultCurrency, plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';
import { useDashboardTips } from '@/lib/tips';
import { SyncStatusIcon } from '@/components/SyncBanner';
import { SkeletonList } from '@/components/Skeletons';
import { GroupCard } from '@/components/GroupCard';
import { UnassignedCapturesCard } from '@/components/UnassignedCapturesCard';
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
  const guard = useGuestGuard();

  const list = groups.data ?? [];
  const loading = groups.isLoading || summary.isLoading;

  // The header overflow menu (the three-dot dropdown): the settings and the
  // less-used destinations, surfaced from the dashboard rather than only from
  // the profile tab.
  const [menuOpen, setMenuOpen] = useState(false);
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
      {
        icon: 'key-outline',
        label: t.account.aiKeysRow,
        route: '/settings/ai-keys',
        section: 'app',
      },
      {
        icon: 'settings-outline',
        label: t.account.faceSettings,
        route: '/profile',
        section: 'settings',
      },
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
          {/* The sync state as one glyph, to the left of the camera — a quiet
              cloud when there are unsent changes or no connection, a turning
              arrow mid-sync, a red mark for a refused change. Nothing when all is
              well. It replaces the wide banner the dashboard used to carry. */}
          <SyncStatusIcon />
          {/* Bare icons, no button chrome — the header reads as a title row, not
              a toolbar of pills. Create a group: the plainest way to start one,
              sitting with the other top actions rather than inside the group
              list where its button crowded the title row. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.newGroup}
            onPress={openNewGroup}
            hitSlop={10}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
          >
            {/* People glyph with a small "+" badge, so the action reads as
                "create a group" rather than "go to groups". The badge sits in a
                page-coloured disc at the corner so the plus separates cleanly
                from the people strokes underneath it. */}
            <View>
              <Ionicons name="people-outline" size={iconSize.xxl} color={theme.color.text} />
              <View
                style={{
                  position: 'absolute',
                  right: -5,
                  bottom: -5,
                  borderRadius: 999,
                  backgroundColor: theme.color.bg,
                }}
              >
                <Ionicons name="add-circle" size={iconSize.base} color={theme.color.brand} />
              </View>
            </View>
          </Pressable>
          {/* Straight to the camera: the icon is a scanner, so it opens one
              rather than a form to fill in first (the capture screen reads the
              `scan` flag and launches the camera on mount). A fresh `Date.now()`
              nonce each tap — not a constant `1` — so the capture screen's
              consumed-once guard survives Android recreating it on the camera's
              return, yet a genuine second tap still counts as new (the fix for
              the camera reopening a second time on its own). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.captures.captureCta}
            onPress={() => router.push(`/capture?scan=${Date.now()}`)}
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

        {/* Expenses caught without a group yet (A34). Sits near the top so an
            inbox with something in it is the first thing after the balance, not
            a screen nobody remembers to open. The same card is in the Inbox. */}
        <UnassignedCapturesCard />

        {isGuest ? (
          <GuestPrompt gate={guard.gate} t={t} onPress={() => router.push('/settings/account')} />
        ) : null}

        {/* One deck, one row of dots. The balance rides at the front as the first
            slide — the number you see on load — then any second currency (no
            total across them, ADR-004), any running trip, and the two shortcuts.
            This used to be a flat balance card with a *second* swipeable deck
            beneath it, which read as two carousels stacked; the finance apps in
            the category (Cleo, Monzo, Wise) all keep balances as slides of a
            single deck. While the balance loads a hero-shaped skeleton stands in
            rather than a card of confident zeros the query has not returned. */}
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

        {loading ? (
          <SkeletonList rows={3} />
        ) : list.length === 0 ? (
          <EmptyState
            title={t.tabs.noGroups}
            body={t.tabs.noGroupsBody}
            icon={<Ionicons name="people-outline" size={iconSize.xxl} color={theme.color.brand} />}
            action={<Button label={t.newGroup} onPress={openNewGroup} />}
          />
        ) : (
          <View>
            {/* No action here anymore — "new group" lives in the top toolbar
                next to the camera, so the title row never crowds or clips. */}
            <SectionHeader title={t.yourGroups} />
            {presentTypes.length > 1 ? (
              <CategoryStrip types={presentTypes} active={active} onSelect={setCategory} t={t} />
            ) : null}
            <View>
              {visible.map((group, index) => {
                const members = summary.membersFor(group.id);
                const balance = summary.balanceFor(group.id);
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
                      onPress={() => router.push(`/group/${group.id}`)}
                    />
                    {index < visible.length - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>

      {/* The one always-there way to add a spend by hand — a floating action in
          the bottom-right, the place finance apps put it (Buddy, Airwallex). The
          bar's centre is the mic (speak it) and the header camera scans a bill;
          this is the third, plainest route: type it. It sits above the bar via
          the same clearance the scroll uses, so it never covers the last row. */}
      <AddExpenseFab label={t.addExpense} bottom={clearance} />

      {/* The daily tip, surfaced as a sheet on the first Home open of the day —
          one useful, Baaki-specific move at a time, then out of the way until
          tomorrow. Replaces the inline card so a hint asks for a beat of
          attention rather than sitting as furniture nobody reads. */}
      <TipSheet t={t} />
    </Screen>
  );
}

/**
 * The dashboard's add-expense action, floating over the bottom-right.
 *
 * Routes to the capture screen — the group-optional "capture an expense" form —
 * so it works the same whether or not the person has a group yet: they type the
 * amount now and decide where it belongs later. The header camera opens that
 * same screen straight into scan mode; this opens it blank, to type.
 *
 * Wrapped in a `box-none` overlay so only the button itself takes touches — the
 * transparent area around it lets the list underneath scroll and tap through.
 */
function AddExpenseFab({ label, bottom }: { label: string; bottom: number }) {
  const theme = useTheme();
  const size = 60;
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', right: theme.spacing.xl, bottom, left: 0, top: 0 }}
    >
      <View
        pointerEvents="box-none"
        style={{ flex: 1, justifyContent: 'flex-end', alignItems: 'flex-end' }}
      >
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => router.push('/capture')}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.color.brand,
            alignItems: 'center',
            justifyContent: 'center',
            ...theme.shadow.lifted,
          }}
        >
          <Ionicons name="add" size={32} color={theme.color.onBrand} />
        </PressableScale>
      </View>
    </View>
  );
}

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
function GuestPrompt({
  gate,
  t,
  onPress,
}: {
  gate: GuestGate | null;
  t: UiStrings;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { hidden, ready, dismiss } = useDailyDismiss(GUEST_PROMPT_DISMISS_KEY);
  if (!ready || hidden) return null;

  const expired = gate?.expired ?? false;
  const body = expired
    ? t.tabs.guestReadOnly
    : gate
      ? t.tabs.guestDaysLeft.replace('{days}', String(gate.daysLeft))
      : t.tabs.guestBannerBody;
  const accent = expired ? theme.color.warning : theme.color.brand;
  // The fraction of the trial still left — the bar empties from the right as the
  // days burn down. Clamped so a stale clock can't over- or under-fill it.
  const remaining = gate ? Math.max(0, Math.min(1, gate.daysLeft / GUEST_TRIAL_DAYS)) : 1;

  // One compact band: the whole card is the way to sign up (the chevron says so),
  // so there is no separate button, no icon chip, no title line — just the status,
  // a hairline countdown under it, and a close. The earlier card stacked a chip,
  // a heading, a full-width button and the bar; that read as bloated for what is
  // an aside above the balance.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t.tabs.addYourDetails}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card style={{ gap: theme.spacing.sm }}>
        <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted" numberOfLines={2} style={{ flex: 1, minWidth: 0 }}>
            {body}
          </Text>
          <Ionicons name="chevron-forward" size={iconSize.base} color={accent} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.close}
            onPress={dismiss}
            hitSlop={10}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
          >
            <Ionicons name="close" size={iconSize.md} color={theme.color.textFaint} />
          </Pressable>
        </Row>

        {gate ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: GUEST_TRIAL_DAYS, now: gate.daysLeft }}
            style={{
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.color.border,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                width: `${remaining * 100}%`,
                height: '100%',
                borderRadius: 2,
                backgroundColor: accent,
              }}
            />
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

/** The day the tip sheet was last shown, so it surfaces once a day and no more. */
const TIP_SHEET_KEY = 'dashboardTips:shownOn';

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

  const open = ready && shownOn !== localToday() && !closed && Boolean(tip);

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
 * The group filter as a row of compact pills — a leading "All", then one per
 * group type the person actually has, each an inline icon + label. The active
 * pill wears the brand fill; the rest sit quiet on the surface. It scrolls
 * sideways, so more types never crowd the row.
 *
 * This was a strip of chunky 74px icon-over-label tiles; the finance apps in the
 * category (Splitwise, PayPal, Monzo) filter with small pills, not tiles, so it
 * now reuses the shared {@link ChipRow} — lighter to read and one fewer bespoke
 * control to keep in step with the rest of the app.
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
  const options: {
    value: GroupType | 'all';
    label: string;
    icon: (color: string) => React.ReactNode;
  }[] = [
    {
      value: 'all',
      label: t.filterAll,
      icon: (color) => <Ionicons name="apps" size={iconSize.sm} color={color} />,
    },
    ...types.map((type) => ({
      value: type,
      label: categoryLabel(type, t),
      icon: (color: string) => (
        <Ionicons name={CATEGORY_ICON[type]} size={iconSize.sm} color={color} />
      ),
    })),
  ];

  return <ChipRow options={options} value={active} onChange={onSelect} />;
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
  const [page, setPage] = useState(0);

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

      {/* The deck can lose a slide under a stale index — a trip ends, a
          currency settles — so the live dot is clamped, not trusted. */}
      <Row style={{ justifyContent: 'center', gap: theme.spacing.xs }}>
        {slides.map((slide, index) => (
          <View
            key={slide.key}
            style={{
              width: index === Math.min(page, slides.length - 1) ? 18 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor:
                index === Math.min(page, slides.length - 1)
                  ? theme.color.brand
                  : theme.color.border,
            }}
          />
        ))}
      </Row>
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
