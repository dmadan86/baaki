import { useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import {
  Button,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { SkeletonList } from '@/components/Skeletons';

/**
 * Below this many groups a search field is ceremony — the list is short enough
 * to take in at a glance, and a box asking "which one?" over four rows reads as
 * clutter, not help.
 */
const SEARCH_THRESHOLD = 6;

const absBig = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * The full, browsable list of every group — the "All groups" door off the
 * dashboard's capped preview.
 *
 * It used to be a flat directory: every row equal, newest-first, no way in but
 * to read the whole thing. A money screen has a sharper job than a directory —
 * it should answer "where do I need to act?" before it answers "what do I
 * have?". So the groups that owe or are owed (or are waiting on a confirmation)
 * sort to the top, biggest balances first; the settled ones fall below a quiet
 * "Settled" divider, dimmed, present but not competing. A search field appears
 * once the roster is long enough to need one, and the door to a new group sits
 * where a new-thing button belongs — top-right, and again inside the empty
 * state, so the first-time reader is never staring at "No groups yet" with no
 * way forward.
 */
export default function AllGroupsScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { profile } = useAuth();
  const summary = useHomeSummary(profile?.id ?? null);
  const groups = useGroups();
  const list = useMemo(() => groups.data ?? [], [groups.data]);
  const loading = groups.isLoading || summary.isLoading;

  const [query, setQuery] = useState('');
  const searchRef = useRef<TextInput>(null);
  const trimmed = query.trim().toLowerCase();

  // Decorate every group with the three facts a row shows — balance, whether a
  // settlement is pending, the member count — then split into the ones needing
  // action and the ones settled, each sorted, and thread a "Settled" divider
  // between them. Rebuilt as one memo so a fast scroll isn't recomputing per
  // frame.
  const rows = useMemo(() => {
    const decorated = list.map((group) => {
      const members = summary.membersFor(group.id);
      const balance = summary.balanceFor(group.id);
      const pending = summary.hasPending(group.id);
      return {
        group,
        label: groupLabel(group, members, profile?.id),
        balance,
        pending,
        count: summary.memberCountFor(group.id),
        needsAction: pending || balance !== 0n,
      };
    });

    const filtered = trimmed
      ? decorated.filter((d) => d.label.toLowerCase().includes(trimmed))
      : decorated;

    // Biggest balances first among the ones needing action; a pending-but-zero
    // group still belongs in the action block, just after the real debts.
    const active = filtered
      .filter((d) => d.needsAction)
      .sort((a, b) => {
        const x = absBig(a.balance);
        const y = absBig(b.balance);
        return x === y ? 0 : y > x ? 1 : -1;
      });
    const settled = filtered.filter((d) => !d.needsAction);

    type Entry = (typeof decorated)[number];
    type Row = { kind: 'group'; item: Entry } | { kind: 'header'; label: string };
    const out: Row[] = active.map((item) => ({ kind: 'group', item }));
    // Only announce "Settled" when there's a mix above it — a screen that is all
    // settled doesn't need a header telling it so.
    if (settled.length && active.length) out.push({ kind: 'header', label: t.settledHeader });
    for (const item of settled) out.push({ kind: 'group', item });

    return out;
  }, [list, summary, profile?.id, trimmed, t.settledHeader]);

  const showSearch = list.length >= SEARCH_THRESHOLD;

  const header = (
    <View style={{ paddingTop: theme.spacing.md, gap: theme.spacing.lg }}>
      <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.xxl}
            color={theme.color.text}
          />
        </IconButton>
        <Text variant="title" style={{ flex: 1 }}>
          {t.groupsTitle}
        </Text>
        {/* The new-group door, where a new-thing button belongs. It repeats in
            the empty state below, so it's reachable whether or not any group
            exists yet. */}
        <IconButton label={t.newGroup} onPress={() => router.push('/new-group')}>
          <Ionicons name="add" size={iconSize.xxl} color={theme.color.brand} />
        </IconButton>
      </Row>

      {showSearch ? (
        <Pressable
          onPress={() => searchRef.current?.focus()}
          accessible={false}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            height: 44,
            paddingHorizontal: theme.spacing.lg,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.color.surfaceMuted,
          }}
        >
          <Ionicons name="search" size={iconSize.md} color={theme.color.textFaint} />
          <TextInput
            ref={searchRef}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            accessibilityRole="search"
            accessibilityLabel={t.searchGroups}
            placeholder={t.searchGroups}
            placeholderTextColor={theme.color.textFaint}
            style={{ flex: 1, fontSize: 16, color: theme.color.text, paddingVertical: 0 }}
          />
          {query ? (
            <Pressable
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel={t.pickers.clearSearch}
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={iconSize.md} color={theme.color.textFaint} />
            </Pressable>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );

  const empty = loading ? (
    <View style={{ paddingTop: theme.spacing.xl }}>
      <SkeletonList rows={5} />
    </View>
  ) : trimmed ? (
    // A search that matched nothing — the reason the list is empty is the query,
    // so the mark and words say "nothing matched", not "you have no groups".
    <View style={{ paddingTop: theme.spacing.xxxl }}>
      <EmptyState
        icon={<Ionicons name="search-outline" size={iconSize.xxl} color={theme.color.brand} />}
        title={t.noGroupsMatch}
      />
    </View>
  ) : (
    // The true first-run empty: reassure, explain lightly what a "group" is for,
    // and hand over the one action that moves you off this screen.
    <View style={{ paddingTop: theme.spacing.xxxl }}>
      <EmptyState
        icon={<Ionicons name="people-outline" size={iconSize.xxl} color={theme.color.brand} />}
        title={t.tabs.noGroups}
        body={t.noGroupsBody}
        action={<Button label={t.newGroup} onPress={() => router.push('/new-group')} />}
      />
    </View>
  );

  return (
    <Screen>
      <FlashList
        data={rows}
        keyExtractor={(row) => (row.kind === 'header' ? 'settled-header' : row.item.group.id)}
        getItemType={(row) => row.kind}
        // The group-ledger settings: render well ahead of the viewport so a fast
        // fling doesn't flash blank rows, and re-render rows when the money,
        // language or search behind them changes.
        drawDistance={1500}
        extraData={[summary, locale, trimmed]}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
        }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: theme.color.border }} />
        )}
        renderItem={({ item: row }) => {
          if (row.kind === 'header') {
            return (
              <Text
                variant="caption"
                tone="muted"
                style={{ paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.xs }}
              >
                {row.label}
              </Text>
            );
          }

          const { group, balance, pending, count } = row.item;
          const statusLabel =
            balance === 0n ? t.allSettled : balance > 0n ? t.youAreOwed : t.youOwe;
          // Status first, member count second: the reader's question is "do I
          // owe or am I owed?", not "how many people". Pending keeps its context
          // rather than replacing it — it used to swallow the member count whole.
          const subtitle = pending
            ? `${t.pendingConfirmation} · ${plural(locale, count, t.memberCount)}`
            : `${statusLabel} · ${plural(locale, count, t.memberCount)}`;
          // Settled groups are present, not urgent: dimmed so the eye lands on
          // the rows that still need something.
          const dim = !row.item.needsAction;

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${row.item.label}. ${statusLabel}`}
              onPress={() => router.push(`/group/${group.id}`)}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Row
                style={{
                  gap: theme.spacing.md,
                  alignItems: 'center',
                  paddingVertical: theme.spacing.sm,
                  opacity: dim ? 0.55 : 1,
                }}
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
                  <Text style={{ fontSize: 20 }}>{group.cover_emoji ?? '👥'}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text
                    variant="body"
                    numberOfLines={1}
                    style={{ flexShrink: 1, fontWeight: '600' }}
                  >
                    {row.item.label}
                  </Text>
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {subtitle}
                  </Text>
                </View>
                <MoneyText
                  amount={balance}
                  currency={group.default_currency as never}
                  locale={locale}
                  mode="balance"
                  variant="subheading"
                />
              </Row>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
