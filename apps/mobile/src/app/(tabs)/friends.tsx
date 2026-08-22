/**
 * Everybody you are not square with, across every group.
 *
 * Two things this screen refuses to do, because both would put a confident
 * wrong number in front of somebody:
 *
 * It never adds two currencies together. Somebody can owe you ₹500 and be owed
 * €20, and there is no honest single figure without a rate — so they appear as
 * two lines rather than one invented total (ADR-003).
 *
 * It never merges two ghosts with the same name. Nothing proves the Ravi in
 * your Goa group is the Ravi in your flat group, and merging two people's
 * debts is not something you can undo once it is done. Only people with an
 * account are followed across groups, because a profile id is proof.
 */

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  iconSize,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { nudgeToSettle, type PersonBalanceRow } from '@/data/api';
import { useBlockedUsers } from '@/data/blocked';
import { useKnownPeopleCount, usePeopleBalances } from '@/data/hooks';
import { useAuth } from '@/lib/auth';
import { PeopleSkeleton } from '@/components/Skeletons';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { usePullRefresh } from '@/lib/pullRefresh';

enum SortKey {
  Amount = 'amount',
  Date = 'date',
  Name = 'name',
}

enum SortDir {
  Asc = 'asc',
  Desc = 'desc',
}

/** Each key's icon and the direction it opens in — biggest/newest first, A→Z. */
const SORT_META: Record<SortKey, { icon: keyof typeof Ionicons.glyphMap; defaultDir: SortDir }> = {
  [SortKey.Amount]: { icon: 'cash-outline', defaultDir: SortDir.Desc },
  [SortKey.Date]: { icon: 'time-outline', defaultDir: SortDir.Desc },
  [SortKey.Name]: { icon: 'text-outline', defaultDir: SortDir.Asc },
};

const SORT_ORDER: readonly SortKey[] = [SortKey.Amount, SortKey.Date, SortKey.Name];

/** Sort a section by the chosen key; asc/desc flips whatever the key means. */
function sortPeople(rows: PersonBalanceRow[], key: SortKey, dir: SortDir): PersonBalanceRow[] {
  const sign = dir === SortDir.Asc ? 1 : -1;
  const cmp = (a: PersonBalanceRow, b: PersonBalanceRow): number => {
    if (key === SortKey.Name) return a.display_name.localeCompare(b.display_name) * sign;
    if (key === SortKey.Date) {
      const at = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
      const bt = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
      return (at < bt ? -1 : at > bt ? 1 : 0) * sign;
    }
    const av = BigInt(a.net);
    const aAbs = av < 0n ? -av : av;
    const bv = BigInt(b.net);
    const bAbs = bv < 0n ? -bv : bv;
    return (aAbs < bAbs ? -1 : aAbs > bAbs ? 1 : 0) * sign;
  };
  return [...rows].sort(cmp);
}

export default function FriendsScreen() {
  const theme = useTheme();
  const pull = usePullRefresh();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();

  const { profile } = useAuth();
  // Local-first (ADR-005): who owes whom is computed from the mirror, so Friends
  // works with no connection — the same rows the RPC returns, folded by the
  // viewer's own ghost merges pulled into the mirror (A38).
  const people = usePeopleBalances(profile?.id ?? null);
  const rows = people.data;
  // Nobody yet, or everybody square? Both arrive here as an empty `rows`, and
  // they want opposite screens — see `EmptyFriends`.
  const known = useKnownPeopleCount(profile?.id ?? null);

  // The merge entry earns its place in the header only once there are two or
  // more guests to merge — for everyone else it would be a control that leads to
  // an empty screen. Counted by distinct person, so a guest unsettled in two
  // currencies is one, not two.
  const mergeableGuestCount = new Set(
    rows.filter((row) => row.is_ghost).map((row) => row.person_key),
  ).size;

  // The sort the whole list obeys. Tapping a key in the menu switches to it;
  // tapping the key already chosen flips its direction — amount and recent
  // activity open biggest/newest first, name A→Z, and either can be reversed.
  const [sortKey, setSortKey] = useState<SortKey>(SortKey.Amount);
  const [sortDir, setSortDir] = useState<SortDir>(SortDir.Desc);
  const [sortOpen, setSortOpen] = useState(false);

  const pickSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === SortDir.Asc ? SortDir.Desc : SortDir.Asc));
    } else {
      setSortKey(key);
      setSortDir(SORT_META[key].defaultDir);
    }
  };

  // The two lists are a filter plus an O(n log n) sort each, and every render —
  // opening or closing the sort menu, a pull-to-refresh tick — used to run both
  // again and hand back freshly allocated arrays. They only actually change when
  // the rows or the chosen sort change, so memoise on exactly those.
  const owedToYou = useMemo(
    () =>
      sortPeople(
        rows.filter((row) => BigInt(row.net) > 0n),
        sortKey,
        sortDir,
      ),
    [rows, sortKey, sortDir],
  );
  const youOwe = useMemo(
    () =>
      sortPeople(
        rows.filter((row) => BigInt(row.net) < 0n),
        sortKey,
        sortDir,
      ),
    [rows, sortKey, sortDir],
  );

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
          // So the empty state can take the room the list is not using and sit
          // in the middle of it. With a list present this changes nothing.
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
        <Row style={{ justifyContent: 'space-between', paddingTop: theme.spacing.md }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <Ionicons name="people" size={iconSize.xl} color={theme.color.brand} />
            <Text variant="title">{t.friends}</Text>
          </Row>
          <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            {/* Merge same-person guests into one — only once there are at least
                two guests to merge, so the control never leads to a dead end. */}
            {mergeableGuestCount >= 2 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.mergePeople.entry}
                onPress={() => router.push('/friends/merge' as never)}
                hitSlop={10}
                style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
              >
                <Ionicons name="git-merge-outline" size={iconSize.xl} color={theme.color.text} />
              </Pressable>
            ) : null}
            {/* Add somebody who is not in your contacts — just a name and the
                amount between you. A person icon, bare like the rest of the row. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.addPerson.title}
              onPress={() => router.push('/friends/add-person' as never)}
              hitSlop={10}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
            >
              {/* Optically one step down: Ionicons draws `person-add-outline`'s
                  single figure larger in its viewbox than `people-outline` and
                  the three-dot, so at an equal nominal size it reads bigger.
                  lg here makes the three header icons appear the same size. */}
              <Ionicons name="person-add-outline" size={iconSize.md} color={theme.color.text} />
            </Pressable>
            {/* Pull people from the phone's address book — icon only, no button
                chrome, so the header reads as a title row not a toolbar. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.tabs.fromContacts}
              onPress={() => router.push('/friends/contacts')}
              hitSlop={10}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
            >
              <Ionicons name="people-outline" size={iconSize.xl} color={theme.color.text} />
            </Pressable>
            {/* Point the camera at a group's invite QR to join it — the read
                lands in the same join flow an invite link opens. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.misc.scanToJoin}
              onPress={() => router.push('/scan')}
              hitSlop={10}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
            >
              <Ionicons name="qr-code-outline" size={iconSize.lg} color={theme.color.text} />
            </Pressable>
            {/* The sort control — a bare vertical three-dot beside the button,
                opening the same corner dropdown the rest of the app uses. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.sort.by}
              onPress={() => setSortOpen(true)}
              hitSlop={10}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
            >
              <Ionicons name="ellipsis-vertical" size={iconSize.xl} color={theme.color.text} />
            </Pressable>
          </Row>
        </Row>

        <SortMenu
          open={sortOpen}
          onClose={() => setSortOpen(false)}
          sortKey={sortKey}
          sortDir={sortDir}
          onPick={pickSort}
          t={t}
        />

        {people.isLoading ? (
          <PeopleSkeleton />
        ) : rows.length === 0 ? (
          <EmptyFriends hasPeople={known.data > 0} t={t} />
        ) : (
          <>
            <FriendsSection
              title={t.tabs.owesYou}
              rows={owedToYou}
              locale={locale}
              emptyBody={t.tabs.nobodyOwesYou}
              emptyIcon="people-outline"
            />
            <FriendsSection
              title={t.tabs.youOweThem}
              rows={youOwe}
              locale={locale}
              emptyBody={t.tabs.youAreNotBehind}
              emptyIcon="checkmark-circle-outline"
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * The screen with nothing on it — which is two screens, not one.
 *
 * Somebody who has never added anyone and somebody who has ten friends and is
 * square with all of them both arrive here with no rows, and they need opposite
 * things said to them. "All square" is a small congratulation, and showing it to
 * a person with no friends at all is a category error: they are not square, they
 * are empty. So the first state names that and the second keeps the
 * congratulation for the people who earned it.
 *
 * The two states are drawn differently on purpose. "All square" stays a small
 * congratulation — the shared `EmptyState` glyph, no button, nothing to escape.
 * "No friends" is a first run, the emptiest the app ever looks, and the finance
 * apps in the category (Splitwise, Venmo, Wise) all meet that moment with a
 * warm hero and a way in rather than a lone stroke icon — so it gets its own
 * `NoFriendsHero`: two faces to say "people", and both ways to add one (type a
 * name, or pull from contacts) where a first-timer is actually looking, since
 * the header icons are easy to miss on an otherwise blank page.
 */
function EmptyFriends({ hasPeople, t }: { hasPeople: boolean; t: UiStrings }): React.JSX.Element {
  const theme = useTheme();

  if (!hasPeople) return <NoFriendsHero t={t} />;

  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <EmptyState
        title={t.tabs.allSquare}
        body={t.tabs.allSquareBody}
        icon={
          <Ionicons name="checkmark-done-outline" size={iconSize.xxl} color={theme.color.brand} />
        }
      />
    </View>
  );
}

/**
 * The first-run hero: two overlapping faces with a small plus, then the two
 * ways to add someone. The back face wears a pastel sky tint and the front the
 * brand, so the pair reads as two different people at a glance rather than one
 * icon doubled; the plus badge sits on the seam where a new person would join.
 * The whole mark is Views and Ionicons — the app has no illustration pipeline,
 * and a built medallion themes itself in dark mode for free.
 */
function NoFriendsHero({ t }: { t: UiStrings }): React.JSX.Element {
  const theme = useTheme();
  const sky = theme.tint.sky;
  const D = 68; // one face

  return (
    <View
      style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: theme.spacing.sm }}
    >
      {/* Face pair + plus badge. Fixed box so the overlap and badge can be
          placed absolutely without the layout guessing at their size. */}
      <View style={{ width: D * 1.7, height: D, marginBottom: theme.spacing.lg }}>
        <Face x={0} d={D} bg={sky.bg} ink={sky.ink} borderColor={theme.color.surface} />
        <Face
          x={D * 0.7}
          d={D}
          bg={theme.color.brandSoft}
          ink={theme.color.brand}
          borderColor={theme.color.surface}
        />
        <View
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: theme.color.brand,
            borderWidth: 3,
            borderColor: theme.color.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="add" size={iconSize.lg} color={theme.color.onBrand} />
        </View>
      </View>

      <Text variant="heading" align="center">
        {t.tabs.noFriends}
      </Text>
    </View>
  );
}

/** One circular face in the hero pair. */
function Face({
  x,
  d,
  bg,
  ink,
  borderColor,
}: {
  x: number;
  d: number;
  bg: string;
  ink: string;
  borderColor: string;
}): React.JSX.Element {
  return (
    <View
      style={{
        position: 'absolute',
        left: x,
        width: d,
        height: d,
        borderRadius: d / 2,
        backgroundColor: bg,
        borderWidth: 3,
        borderColor,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name="person" size={d * 0.5} color={ink} />
    </View>
  );
}

function FriendsSection({
  title,
  rows,
  locale,
  emptyBody,
  emptyIcon,
}: {
  title: string;
  rows: PersonBalanceRow[];
  locale: string;
  emptyBody: string;
  /** Glyph for the empty card — says "state, not error" before the line is read. */
  emptyIcon: React.ComponentProps<typeof Ionicons>['name'];
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader title={title} />
      {rows.length === 0 ? (
        <Card>
          {/* Mobbin pass: an empty section is mostly air; a lone grey sentence
              reads as a screen that failed. A tinted glyph over the line names
              it as a resting state (cf. Zip "all paid up", Splitwise settled). */}
          <View
            style={{
              alignItems: 'center',
              gap: theme.spacing.xs,
              paddingVertical: theme.spacing.sm,
            }}
          >
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.color.brandSoft,
              }}
            >
              <Ionicons name={emptyIcon} size={22} color={theme.color.brand} />
            </View>
            <Text variant="caption" tone="muted" align="center">
              {emptyBody}
            </Text>
          </View>
        </Card>
      ) : (
        <View>
          {rows.map((row, index) => (
            <View key={`${row.person_key}-${row.currency}`}>
              <FriendCard row={row} locale={locale} t={t} />
              {index < rows.length - 1 ? (
                <View style={{ height: 1, backgroundColor: theme.color.border }} />
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function FriendCard({
  row,
  locale,
  t,
}: {
  row: PersonBalanceRow;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
}): React.JSX.Element {
  const theme = useTheme();
  const { isBlocked } = useBlockedUsers();
  // A blocked person is hidden behind the ghost name and the ghost avatar here
  // too, so their identity never surfaces on the Friends list — the amount and
  // everything the row does with it are unchanged; only who it names is.
  const blocked = isBlocked(row.profile_id);
  const shownName = blocked ? t.misc.someone : row.display_name;
  // Flat WhatsApp row: the money colour is gone from the background, the amount
  // reads in ordinary ink, and the owed/owe meaning is carried by the sign and
  // the section this row sits under. The avatar keeps the person's own colour.
  const owed = BigInt(row.net) > 0n;
  // One group explains the balance: open it. Several do: the amount is a sum, so
  // open the person instead — a screen that splits it back out per group. Either
  // way the row is now a doorway; it used to be a dead end once it spanned two.
  const onPress = row.only_group_id
    ? () => router.push(`/group/${row.only_group_id}`)
    : () =>
        router.push(
          // The route is typed once expo regenerates its route map; `as never`
          // matches how the other friends/* pushes bridge that gap.
          `/friends/person/${encodeURIComponent(row.person_key)}?name=${encodeURIComponent(
            shownName,
          )}` as never,
        );

  const body = (
    <Row style={{ paddingVertical: theme.spacing.md, alignItems: 'center' }}>
      <Row style={{ flex: 1, gap: theme.spacing.md, alignItems: 'center' }}>
        <Avatar name={shownName} size={44} ghost={row.is_ghost || blocked} />
        <View style={{ flex: 1 }}>
          <Text variant="subheading" numberOfLines={1}>
            {shownName}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {row.group_count === 1
              ? t.tabs.inOneGroup
              : plural(locale, row.group_count, t.tabs.acrossGroups)}
          </Text>
        </View>
      </Row>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        {/* Semantic money colour (owed green, owe red) is the one signal that
            tells direction at a glance — the section header alone is lost the
            moment it scrolls off. Sign is spoken via the balance a11y label. */}
        <MoneyText
          amount={BigInt(row.net)}
          currency={row.currency}
          locale={locale}
          variant="subheading"
          mode="balance"
        />
        {row.is_ghost ? (
          // A ghost is somebody you added who has no Baaki account yet, so the
          // badge is the useful action rather than a verdict: send them this
          // group's invite link, which is the same link that lets them claim
          // this very row (A25). Only offered when a single group explains the
          // balance — otherwise there is no one link to share. Its own
          // Pressable so tapping it invites rather than opening the group.
          row.only_group_id ? (
            <Pressable
              onPress={() => router.push(`/group/${row.only_group_id}/invite`)}
              accessibilityRole="button"
              accessibilityLabel={t.people.invite}
              hitSlop={12}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Badge label={t.people.invite} tone="brand" />
            </Pressable>
          ) : (
            <Badge label={t.tabs.notJoined} />
          )
        ) : owed && row.only_group_id ? (
          // They owe you and one group explains it, so there is a single pair
          // to nudge. The server keeps it honest — one a day, never to a
          // ghost, never for nothing — so the button only has to ask (ADR-010).
          <RemindButton row={row} />
        ) : null}
      </View>
    </Row>
  );

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={shownName}
      style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/**
 * The one-tap nudge on a card for somebody who owes you.
 *
 * Once tapped it does not offer to be tapped again — it settles into a quiet
 * "Reminded", and if the server says the daily limit is already spent it says
 * "Nudged today" in the same muted voice rather than an error. Being told off
 * for caring twice is exactly the collections-agency feeling ADR-010 forbids,
 * so a rate limit reads here as reassurance that it already went, not a wall.
 * Its own Pressable, so a tap nudges rather than opening the group behind it.
 */
function RemindButton({ row }: { row: PersonBalanceRow }): React.JSX.Element | null {
  const theme = useTheme();
  const { t } = useStrings();
  const [note, setNote] = useState<string | null>(null);

  const nudge = useMutation({
    mutationFn: () =>
      nudgeToSettle({
        groupId: row.only_group_id ?? '',
        toMemberId: row.member_id,
        currency: row.currency,
      }),
    onSuccess: () => setNote(t.people.reminded),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      // A backend message is neither translated nor meant for the person being
      // nudged. The limit case is the one that has something true to say.
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
  if (nudge.isPending) return <ActivityIndicator size="small" color={theme.color.brand} />;

  return (
    <Pressable
      onPress={() => nudge.mutate()}
      accessibilityRole="button"
      accessibilityLabel={t.people.remind}
      hitSlop={12}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Badge label={t.people.remind} tone="brand" />
    </Pressable>
  );
}

/**
 * The sort dropdown — a bare corner card, WhatsApp-style, matching the app's
 * other overflow menus. One row per key with its icon; the active key wears the
 * brand ink and a direction arrow, and tapping it again flips the arrow.
 */
function SortMenu({
  open,
  onClose,
  sortKey,
  sortDir,
  onPick,
  t,
}: {
  open: boolean;
  onClose: () => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onPick: (key: SortKey) => void;
  t: UiStrings;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t.common.close}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.12)' }}
      >
        <View
          style={{
            position: 'absolute',
            top: insets.top + 56,
            right: theme.spacing.xl,
            minWidth: 220,
            borderRadius: theme.radius.lg,
            ...theme.shadow.lifted,
          }}
        >
          <View
            style={{
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.color.border,
              backgroundColor: theme.color.surface,
              paddingVertical: theme.spacing.xs,
              overflow: 'hidden',
            }}
          >
            <Text
              variant="micro"
              tone="faint"
              style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs }}
            >
              {t.sort.by}
            </Text>
            {SORT_ORDER.map((key) => {
              const active = key === sortKey;
              const label =
                key === SortKey.Amount
                  ? t.sort.amount
                  : key === SortKey.Date
                    ? t.sort.date
                    : t.sort.name;
              return (
                <Pressable
                  key={key}
                  onPress={() => onPick(key)}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: active }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.md,
                    backgroundColor: pressed ? theme.color.surfaceMuted : 'transparent',
                  })}
                >
                  <Ionicons
                    name={SORT_META[key].icon}
                    size={iconSize.lg}
                    color={active ? theme.color.brand : theme.color.textMuted}
                  />
                  <Text
                    variant="body"
                    style={{ flex: 1, color: active ? theme.color.brand : theme.color.text }}
                  >
                    {label}
                  </Text>
                  {active ? (
                    <Ionicons
                      name={sortDir === SortDir.Asc ? 'arrow-up' : 'arrow-down'}
                      size={iconSize.md}
                      color={theme.color.brand}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}
