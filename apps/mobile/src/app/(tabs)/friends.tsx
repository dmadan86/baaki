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

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery } from '@tanstack/react-query';
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
  Button,
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
} from '@baaki/ui';

import { fetchPeopleBalances, nudgeToSettle, type PersonBalanceRow } from '@/data/api';
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

  const people = useQuery({
    queryKey: ['people', 'balances'],
    queryFn: fetchPeopleBalances,
  });
  const rows = people.data ?? [];

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

  const owedToYou = sortPeople(
    rows.filter((row) => BigInt(row.net) > 0n),
    sortKey,
    sortDir,
  );
  const youOwe = sortPeople(
    rows.filter((row) => BigInt(row.net) < 0n),
    sortKey,
    sortDir,
  );

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
        <Row style={{ justifyContent: 'space-between', paddingTop: theme.spacing.md }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <Ionicons name="people" size={iconSize.xl} color={theme.color.brand} />
            <Text variant="title">{t.friends}</Text>
          </Row>
          <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            {/* Add somebody who is not in your contacts — just a name and the
                amount between you. A person icon, bare like the rest of the row. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.addPerson.title}
              onPress={() => router.push('/friends/add-person' as never)}
              hitSlop={10}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: theme.spacing.xs })}
            >
              <Ionicons name="person-add-outline" size={iconSize.xl} color={theme.color.text} />
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
        ) : people.isError ? (
          // A failed fetch is not "all square" — say so, and give a way back.
          <EmptyState
            title={t.loadError}
            body={t.loadErrorBody}
            action={<Button label={t.retry} variant="secondary" onPress={() => people.refetch()} />}
          />
        ) : rows.length === 0 ? (
          <EmptyState title={t.tabs.allSquare} body={t.tabs.allSquareBody} />
        ) : (
          <>
            <FriendsSection
              title={t.tabs.owesYou}
              rows={owedToYou}
              locale={locale}
              emptyBody={t.tabs.nobodyOwesYou}
            />
            <FriendsSection
              title={t.tabs.youOweThem}
              rows={youOwe}
              locale={locale}
              emptyBody={t.tabs.youAreNotBehind}
            />

            <Text variant="micro" tone="muted" align="center">
              {t.extras.perCurrencyNote}
            </Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function FriendsSection({
  title,
  rows,
  locale,
  emptyBody,
}: {
  title: string;
  rows: PersonBalanceRow[];
  locale: string;
  emptyBody: string;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader title={title} />
      {rows.length === 0 ? (
        <Card>
          <Text variant="caption" tone="muted">
            {emptyBody}
          </Text>
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
  // Flat WhatsApp row: the money colour is gone from the background, the amount
  // reads in ordinary ink, and the owed/owe meaning is carried by the sign and
  // the section this row sits under. The avatar keeps the person's own colour.
  const owed = BigInt(row.net) > 0n;
  // Only linkable when there is a single group to link to; otherwise this
  // amount is a sum and no one group explains it.
  const onPress = row.only_group_id ? () => router.push(`/group/${row.only_group_id}`) : undefined;

  const body = (
    <Row style={{ paddingVertical: theme.spacing.md, alignItems: 'center' }}>
      <Row style={{ flex: 1, gap: theme.spacing.md, alignItems: 'center' }}>
        <Avatar name={row.display_name} size={44} ghost={row.is_ghost} />
        <View style={{ flex: 1 }}>
          <Text variant="subheading" numberOfLines={1}>
            {row.display_name}
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

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={row.display_name}
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
      setNote(message.includes('NUDGE_RATE_LIMIT') ? t.people.remindedToday : message);
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
