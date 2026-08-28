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

import { useEffect, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  BackHandler,
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
  Button,
  Card,
  directionalIcon,
  EmptyState,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { balanceDirection, copyFor, moneyAccessibilityLabel } from '@waves/core';

import { nudgeToSettle, type PersonBalanceRow } from '@/data/api';
import { useBlockedUsers } from '@/data/blocked';
import { defaultMergeName } from '@/data/mergePeople';
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

/** The human name of a sort key — shared by the menu row and the header's
 *  now-stateful sort control's spoken label. */
function sortLabel(key: SortKey, t: UiStrings): string {
  if (key === SortKey.Amount) return t.sort.amount;
  if (key === SortKey.Date) return t.sort.date;
  return t.sort.name;
}

/**
 * One person and every currency they are unsettled with you in.
 *
 * The mirror returns a row per (person, currency) — currencies never sum
 * (ADR-003), so a person owed in rupees and owing in dollars is two rows. This
 * folds them back into the one human the list shows, keeping each currency's net
 * as its own entry for the row's right edge to stack.
 */
interface PersonGroup {
  person_key: string;
  display_name: string;
  profile_id: string | null;
  /** A ghost only if every one of their rows is — a real account is proof. */
  is_ghost: boolean;
  entries: PersonBalanceRow[];
  /** The largest single-currency balance, for the amount sort. */
  topAbs: bigint;
  /** Newest activity across their rows, for the recent sort. */
  lastActivityAt: string | null;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Later of two ISO timestamps, ignoring null. */
function laterDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

/** Fold the per-currency rows into one entry per person. */
function groupByPerson(rows: PersonBalanceRow[]): PersonGroup[] {
  const map = new Map<string, PersonGroup>();
  for (const row of rows) {
    let g = map.get(row.person_key);
    if (!g) {
      g = {
        person_key: row.person_key,
        display_name: row.display_name,
        profile_id: row.profile_id,
        is_ghost: true,
        entries: [],
        topAbs: 0n,
        lastActivityAt: null,
      };
      map.set(row.person_key, g);
    }
    g.entries.push(row);
    g.is_ghost = g.is_ghost && row.is_ghost;
    if (row.profile_id) g.profile_id = row.profile_id;
    const abs = absBig(BigInt(row.net));
    if (abs > g.topAbs) g.topAbs = abs;
    g.lastActivityAt = laterDate(g.lastActivityAt, row.last_activity_at);
  }
  return [...map.values()];
}

/** Sort people by the chosen key; asc/desc flips whatever the key means. A
 *  person's amount is their biggest single-currency balance (never a
 *  cross-currency sum), their date the newest activity across their rows. */
function sortPersons(people: PersonGroup[], key: SortKey, dir: SortDir): PersonGroup[] {
  const sign = dir === SortDir.Asc ? 1 : -1;
  const cmp = (a: PersonGroup, b: PersonGroup): number => {
    if (key === SortKey.Name) return a.display_name.localeCompare(b.display_name) * sign;
    if (key === SortKey.Date) {
      const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
      const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
      return (at < bt ? -1 : at > bt ? 1 : 0) * sign;
    }
    return (a.topAbs < b.topAbs ? -1 : a.topAbs > b.topAbs ? 1 : 0) * sign;
  };
  return [...people].sort(cmp);
}

export interface CurrencyTotal {
  currency: string;
  net: bigint;
}

/** The net you are up or down in each currency, summed over everyone. Positive:
 *  owed to you. Never summed across currencies (ADR-003). Biggest first. */
function currencyTotals(rows: PersonBalanceRow[]): CurrencyTotal[] {
  const m = new Map<string, bigint>();
  for (const row of rows) m.set(row.currency, (m.get(row.currency) ?? 0n) + BigInt(row.net));
  return [...m.entries()]
    .filter(([, net]) => net !== 0n)
    .map(([currency, net]) => ({ currency, net }))
    .sort((a, b) => (absBig(a.net) < absBig(b.net) ? 1 : absBig(a.net) > absBig(b.net) ? -1 : 0));
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

  // The "add someone" family — add a person, pull from contacts, scan an invite
  // QR — folded behind one `+` so the header reads as a title row, not a
  // five-icon toolbar of mystery glyphs.
  const [addOpen, setAddOpen] = useState(false);

  const pickSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === SortDir.Asc ? SortDir.Desc : SortDir.Asc));
    } else {
      setSortKey(key);
      setSortDir(SORT_META[key].defaultDir);
    }
  };

  // Multiselect merge: long-press a guest to start picking, tap to add/remove,
  // then Merge folds them into one person through the very flow the header's
  // merge entry uses (rename + optional contact + the irreversibility warning),
  // only pre-selected. Only guests (ghosts) are mergeable, so only they are
  // selectable — a real account is already one identity across every group.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());

  // A live mirror of the selection, read by `toggleSelect` so a tap always folds
  // into the very latest set — not a snapshot captured at some earlier render,
  // and not a value that lags behind a passive effect. It is written in the same
  // helper that schedules the state, so a second tap that lands before React has
  // flushed still sees the real set (picking A then B keeps both, never just B).
  const selectedKeysRef = useRef<ReadonlySet<string>>(selectedKeys);
  const applySelection = (next: ReadonlySet<string>): void => {
    selectedKeysRef.current = next;
    setSelectedKeys(next);
  };

  const exitSelect = (): void => {
    setSelectMode(false);
    applySelection(new Set());
  };

  // A long press fires onLongPress (this), then the SAME touch fires the row's
  // onPress on release — which in selection mode is a toggle. Left alone, that
  // release toggles right back off the person the long press just picked, the
  // set empties, and selection mode vanishes the instant you lift your finger.
  // So the long press arms a one-shot guard that the very next toggle consumes
  // and ignores. Any later tap is a real pick.
  const swallowNextToggleRef = useRef(false);

  const enterSelect = (personKey: string): void => {
    swallowNextToggleRef.current = true;
    setSelectMode(true);
    applySelection(new Set([personKey]));
  };

  const toggleSelect = (personKey: string): void => {
    // The release of the long press that just entered selection — ignore it once
    // so the picked person stays picked.
    if (swallowNextToggleRef.current) {
      swallowNextToggleRef.current = false;
      return;
    }
    const next = new Set(selectedKeysRef.current);
    if (next.has(personKey)) next.delete(personKey);
    else next.add(personKey);
    // Dropping the last pick leaves selection mode — an empty selection is no
    // selection.
    if (next.size === 0) exitSelect();
    else applySelection(next);
  };

  const startMerge = (): void => {
    const keys = [...selectedKeys];
    // The Merge action is only enabled at two or more, but guard anyway.
    if (keys.length < 2) return;
    // Pre-fill the merge screen's name from the picked people — one display name
    // per person (a person unsettled in two currencies is two rows but one
    // name), most-common wins, exactly as the merge screen's own default does.
    const nameByKey = new Map<string, string>();
    for (const row of rows) {
      if (selectedKeys.has(row.person_key) && !nameByKey.has(row.person_key)) {
        nameByKey.set(row.person_key, row.display_name);
      }
    }
    const suggestedName = defaultMergeName(
      [...nameByKey.values()].map((display_name) => ({ display_name })),
    );
    const keyParam = keys.map(encodeURIComponent).join(',');
    const nameParam = encodeURIComponent(suggestedName);
    exitSelect();
    router.push(`/friends/merge?keys=${keyParam}&name=${nameParam}` as never);
  };

  // Android hardware back leaves selection mode rather than the tab.
  useEffect(() => {
    if (!selectMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitSelect();
      return true;
    });
    return () => sub.remove();
  }, [selectMode]);

  // One row per person, not per (person, currency). The mirror hands back a row
  // for each currency a person is unsettled in (currencies never mix — ADR-003);
  // folding them into one person is what lets the list read the Splitwise way —
  // a single row whose right edge stacks each currency's net — instead of the
  // same face twice. Memoised on rows + sort, which is all that moves it.
  const persons = useMemo(
    () => sortPersons(groupByPerson(rows), sortKey, sortDir),
    [rows, sortKey, sortDir],
  );

  // The headline's figures: the net you are up or down in each currency, summed
  // across everyone. Never across currencies — there is no honest single number
  // without a rate (ADR-003), so a mixed wallet shows one line per currency.
  const totals = useMemo(() => currencyTotals(rows), [rows]);

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
        {selectMode ? (
          // Selection header: leave the mode, the running count, and Merge —
          // enabled only at two or more, since one person is nothing to merge.
          <Row
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: theme.spacing.md,
            }}
          >
            <Row style={{ alignItems: 'center', gap: theme.spacing.sm, flex: 1 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.common.close}
                onPress={exitSelect}
                hitSlop={10}
                style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
              >
                <Ionicons name="close" size={iconSize.xl} color={theme.color.text} />
              </Pressable>
              <Text variant="heading" numberOfLines={1}>
                {plural(locale, selectedKeys.size, t.mergePeople.selected)}
              </Text>
            </Row>
            <Button
              label={t.mergePeople.entry}
              size="sm"
              disabled={selectedKeys.size < 2}
              onPress={startMerge}
            />
          </Row>
        ) : (
          <Row style={{ justifyContent: 'space-between', paddingTop: theme.spacing.md }}>
            <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
              <Ionicons name="people" size={iconSize.xl} color={theme.color.brand} />
              <Text variant="title">{t.friends}</Text>
            </Row>
            <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
              {/* One primary action — everything that adds a person (type a name,
                pull from contacts, scan an invite QR) lives behind this `+` so a
                first-timer has one obvious door instead of four bare glyphs to
                guess between. Merge is not here: it is a fix, not an add, and it
                gets its own contextual card once there are duplicates. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.tabs.addSomeone}
                onPress={() => setAddOpen(true)}
                hitSlop={10}
                style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
              >
                <Ionicons name="add" size={iconSize.xxxl} color={theme.color.text} />
              </Pressable>
              {/* The sort control now wears its own state: the active key's glyph
                and the direction arrow, so a glance says how the list is ordered
                without opening the menu (fixes the invisible-sort complaint). */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t.sort.by}: ${sortLabel(sortKey, t)}`}
                onPress={() => setSortOpen(true)}
                hitSlop={10}
                style={({ pressed }) => ({
                  opacity: pressed ? 0.5 : 1,
                  padding: theme.spacing.xs,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 2,
                })}
              >
                <Ionicons
                  name={SORT_META[sortKey].icon}
                  size={iconSize.lg}
                  color={theme.color.textMuted}
                />
                <Ionicons
                  name={sortDir === SortDir.Asc ? 'arrow-up' : 'arrow-down'}
                  size={iconSize.sm}
                  color={theme.color.textMuted}
                />
              </Pressable>
            </Row>
          </Row>
        )}

        <AddMenu open={addOpen} onClose={() => setAddOpen(false)} t={t} />

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
            {/* Overall headline — am I up or down, and by how much, before a
              single row is read. This is the one thing group-by-group
              navigation could never answer. One line per currency; never a
              summed cross-currency total (ADR-003). It steps aside mid-merge,
              where the running selection owns the top of the screen. */}
            {!selectMode ? <BalanceHeadline totals={totals} locale={locale} t={t} /> : null}
            {/* Merge used to hide behind a bare header glyph and a long-press
              nobody discovers. When two or more guests could be the same person,
              say so in words with a way in — a stable place to learn the concept
              (hidden in selection mode, where merging is already under way). */}
            {mergeableGuestCount >= 2 && !selectMode ? (
              <MergeHint onPress={() => router.push('/friends/merge' as never)} t={t} />
            ) : null}
            {/* One list, one row per person (Splitwise model). Direction lives on
              the row — a "you owe"/"owes you" micro-label and the money's own
              colour — so no owes/owed tab, and a person unsettled in two
              currencies is one row with both nets stacked, not two faces. */}
            <View>
              {persons.map((person, index) => (
                <View key={person.person_key}>
                  <PersonRow
                    person={person}
                    locale={locale}
                    t={t}
                    selectMode={selectMode}
                    selected={selectedKeys.has(person.person_key)}
                    onEnterSelect={enterSelect}
                    onToggleSelect={toggleSelect}
                  />
                  {index < persons.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: theme.color.border }} />
                  ) : null}
                </View>
              ))}
            </View>
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
            backgroundColor: theme.color.buttonPrimary,
            borderWidth: 3,
            borderColor: theme.color.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="add" size={iconSize.lg} color={theme.color.onButtonPrimary} />
        </View>
      </View>

      <Text variant="heading" align="center">
        {t.tabs.noFriends}
      </Text>
      <Text variant="body" tone="muted" align="center" style={{ maxWidth: 300 }}>
        {t.tabs.noFriendsBody}
      </Text>
      {/* Both ways in, where a first-timer is actually looking — the header `+`
          is easy to miss on an otherwise blank page. Primary types a name;
          secondary pulls from the phone's contacts. */}
      <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm, marginTop: theme.spacing.lg }}>
        <Button
          label={t.tabs.addSomeone}
          onPress={() => router.push('/friends/add-person' as never)}
          fullWidth
        />
        <Button
          label={t.tabs.fromContacts}
          variant="secondary"
          onPress={() => router.push('/friends/contacts')}
          fullWidth
        />
      </View>
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

/**
 * The one figure group-by-group navigation can never show: across every group
 * and person, am I up or down — and by how much. One line per currency, because
 * there is no honest single number across currencies without a rate (ADR-003).
 * Nets to nothing overall? Then it says nothing and the rows below carry it.
 */
function BalanceHeadline({
  totals,
  locale,
  t,
}: {
  totals: readonly CurrencyTotal[];
  locale: string;
  t: UiStrings;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (totals.length === 0) return null;
  return (
    <Card>
      <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
        {t.tabs.overall.toUpperCase()}
      </Text>
      <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.xs }}>
        {totals.map((total) => (
          <Row
            key={total.currency}
            style={{
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: theme.spacing.md,
            }}
          >
            <Text variant="body" tone="muted">
              {total.net > 0n ? t.tabs.youAreOwed : t.tabs.youOweThem}
            </Text>
            <MoneyText
              amount={total.net}
              currency={total.currency}
              locale={locale}
              variant="heading"
              mode="balance"
            />
          </Row>
        ))}
      </View>
    </Card>
  );
}

/**
 * One person, one row — every group and currency they are unsettled with you in,
 * folded into a single line (the Splitwise model). Direction lives on the row: a
 * "you owe" / "owes you" micro-label and the money's own colour, so no owes/owed
 * tab is needed. A person unsettled in two currencies shows both nets stacked at
 * the right edge rather than appearing as two different people.
 */
function PersonRow({
  person,
  locale,
  t,
  selectMode,
  selected,
  onEnterSelect,
  onToggleSelect,
}: {
  person: PersonGroup;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
  selectMode: boolean;
  selected: boolean;
  onEnterSelect: (personKey: string) => void;
  onToggleSelect: (personKey: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { isBlocked } = useBlockedUsers();
  // A blocked person is hidden behind the ghost name and avatar here too, so
  // their identity never surfaces on the list — the amounts are unchanged; only
  // who the row names is.
  const blocked = isBlocked(person.profile_id);
  const shownName = blocked ? t.misc.someone : person.display_name;
  // Only a guest can be merged — a real account is already one identity across
  // every group — so only guest rows take part in a selection.
  const selectable = person.is_ghost;

  const entries = person.entries;
  // The common case: a person with a single balance. It carries the micro-label,
  // the group scope and the badges; a multi-currency person leans on the stacked
  // amounts instead.
  const single = entries.length === 1 ? entries[0] : null;
  const soloGroup = single?.only_group_id ?? null;

  // One group and one currency explains it: open that group. Otherwise the
  // person page splits the balance back out per group and currency.
  const navigate = soloGroup
    ? () => router.push(`/group/${soloGroup}`)
    : () =>
        router.push(
          `/friends/person/${encodeURIComponent(person.person_key)}?name=${encodeURIComponent(
            shownName,
          )}` as never,
        );

  const onPress = selectMode
    ? selectable
      ? () => onToggleSelect(person.person_key)
      : undefined
    : navigate;
  const onLongPress =
    !selectMode && selectable ? () => onEnterSelect(person.person_key) : undefined;

  const subtitle = single
    ? single.group_count === 1
      ? t.tabs.inOneGroup
      : plural(locale, single.group_count, t.tabs.acrossGroups)
    : null;

  // What a screen reader hears: who, then each currency's spoken direction and
  // amount, the group scope, and — for a guest — that they have not joined.
  const moneyLabels = entries.map((e) =>
    moneyAccessibilityLabel(
      { minor: BigInt(e.net), currency: e.currency },
      balanceDirection(BigInt(e.net)),
      copyFor(locale).money,
      { locale },
    ),
  );
  const statusPart = person.is_ghost ? (soloGroup ? t.people.invite : t.tabs.notJoined) : '';
  const rowA11yLabel = [shownName, ...moneyLabels, subtitle ?? '', statusPart]
    .filter(Boolean)
    .join('. ');

  // Biggest currency first when a person spans several.
  const sortedEntries =
    entries.length > 1
      ? [...entries].sort((a, b) =>
          absBig(BigInt(a.net)) < absBig(BigInt(b.net))
            ? 1
            : absBig(BigInt(a.net)) > absBig(BigInt(b.net))
              ? -1
              : 0,
        )
      : entries;

  const body = (
    <Row
      style={{
        paddingVertical: theme.spacing.sm,
        alignItems: 'center',
        gap: theme.spacing.sm,
        // A non-selectable row reads as unavailable while a selection runs.
        opacity: selectMode && !selectable ? 0.4 : 1,
      }}
    >
      {selectMode ? (
        <Ionicons
          name={selected ? 'checkmark-circle' : 'ellipse-outline'}
          size={iconSize.xl}
          color={selected ? theme.color.brand : theme.color.textFaint}
        />
      ) : null}
      <Row style={{ flex: 1, gap: theme.spacing.md, alignItems: 'center' }}>
        <Avatar name={shownName} size={44} ghost={person.is_ghost || blocked} />
        <View style={{ flex: 1 }}>
          <Text variant="subheading" numberOfLines={1}>
            {shownName}
          </Text>
          {subtitle ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </Row>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        {single ? (
          <>
            {/* The one place the row says the direction in words — over the
                coloured amount — so a glance reads owed-vs-owe without leaning on
                red/green alone. */}
            <Text variant="micro" tone="faint">
              {BigInt(single.net) > 0n ? t.tabs.owesYou : t.tabs.youOweThem}
            </Text>
            <MoneyText
              amount={BigInt(single.net)}
              currency={single.currency}
              locale={locale}
              variant="subheading"
              mode="balance"
            />
          </>
        ) : (
          // Multi-currency: one small coloured line per currency — never summed.
          sortedEntries.map((e) => (
            <MoneyText
              key={e.currency}
              amount={BigInt(e.net)}
              currency={e.currency}
              locale={locale}
              variant="caption"
              mode="balance"
            />
          ))
        )}
        {selectMode ? null : person.is_ghost ? (
          // A ghost is somebody you added who has no account yet, so the badge is
          // the useful action: send them this group's invite link — the same link
          // that lets them claim this balance (A25). Offered only when a single
          // group explains it, otherwise there is no one link to share.
          soloGroup ? (
            <Pressable
              onPress={() => router.push(`/group/${soloGroup}/invite`)}
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
        ) : single && BigInt(single.net) > 0n && single.only_group_id ? (
          // They owe you and one group explains it, so there is a single pair to
          // nudge. The server keeps it honest — one a day (ADR-010).
          <RemindButton row={single} />
        ) : null}
      </View>
    </Row>
  );

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      // In selection mode a selectable row is a checkbox; a non-selectable one
      // (a real account — already one identity, nothing to merge) is inert, so it
      // announces neither role nor tap and reads as disabled. Outside selection
      // mode every row is the usual button into the person.
      disabled={selectMode && !selectable}
      accessibilityRole={selectMode ? (selectable ? 'checkbox' : 'none') : 'button'}
      accessibilityState={
        selectMode ? (selectable ? { checked: selected } : { disabled: true }) : undefined
      }
      accessibilityLabel={selectMode ? shownName : rowA11yLabel}
      style={({ pressed }) => ({
        opacity: pressed ? 0.9 : 1,
        // A tick alone can be missed; a picked row also wears a soft fill.
        backgroundColor: selected ? theme.color.surfaceMuted : 'transparent',
      })}
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
              const label = sortLabel(key, t);
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

/**
 * The contextual merge nudge — a card, not a bare header glyph.
 *
 * Merge used to live behind an icon that appeared only when it was usable and a
 * long-press nobody stumbles onto. This says the concept in words and offers the
 * way in, so a user learns "duplicate guests can be merged" at the one moment it
 * is true and actionable. It disappears the instant the duplicates are gone.
 */
function MergeHint({ onPress, t }: { onPress: () => void; t: UiStrings }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t.mergePeople.entry}
      accessibilityHint={t.mergePeople.hint}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card>
        <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.brandSoft,
            }}
          >
            <Ionicons name="git-merge-outline" size={iconSize.xl} color={theme.color.brand} />
          </View>
          <Text variant="caption" tone="muted" style={{ flex: 1 }}>
            {t.mergePeople.hint}
          </Text>
          <Ionicons
            name={directionalIcon('chevron-forward')}
            size={iconSize.lg}
            color={theme.color.textFaint}
          />
        </Row>
      </Card>
    </Pressable>
  );
}

/**
 * The `+` menu — the same corner dropdown SortMenu uses, holding the three ways
 * to add a person: type a name, pull from contacts, scan an invite QR. One door
 * in place of the header's former row of bare glyphs.
 */
function AddMenu({
  open,
  onClose,
  t,
}: {
  open: boolean;
  onClose: () => void;
  t: UiStrings;
}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const go = (path: string): void => {
    onClose();
    router.push(path as never);
  };

  const items: {
    key: string;
    label: string;
    icon: React.ReactNode;
    onPress: () => void;
  }[] = [
    {
      key: 'add',
      label: t.addPerson.title,
      icon: <Ionicons name="person-add-outline" size={iconSize.lg} color={theme.color.text} />,
      onPress: () => go('/friends/add-person'),
    },
    {
      key: 'contacts',
      label: t.tabs.fromContacts,
      icon: (
        <MaterialCommunityIcons
          name="book-account-outline"
          size={iconSize.lg}
          color={theme.color.text}
        />
      ),
      onPress: () => go('/friends/contacts'),
    },
    {
      key: 'scan',
      label: t.misc.scanToJoin,
      icon: <Ionicons name="qr-code-outline" size={iconSize.lg} color={theme.color.text} />,
      onPress: () => go('/scan'),
    },
  ];

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
              {t.tabs.addSomeone}
            </Text>
            {items.map((item) => (
              <Pressable
                key={item.key}
                onPress={item.onPress}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  paddingHorizontal: theme.spacing.lg,
                  paddingVertical: theme.spacing.md,
                  backgroundColor: pressed ? theme.color.surfaceMuted : 'transparent',
                })}
              >
                {item.icon}
                <Text variant="body" style={{ flex: 1 }}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}
