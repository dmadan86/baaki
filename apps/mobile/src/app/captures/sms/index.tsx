/**
 * Bank messages — its own screen, which is the whole point of it.
 *
 * This used to be part of Review, and it should not have been. Review is the
 * short list of things genuinely waiting on a person: four drafts, each one a
 * question with an answer. Bank messages are a *stream* — a quarter of them is
 * hundreds of rows, most of which nobody needs to do anything about — and
 * pouring a stream into a list of questions makes the questions unfindable.
 * Worse, it made the list change while nobody was looking: an hourly job would
 * add eleven rows to the screen a person was in the middle of reading.
 *
 * So they are two screens, and the verbs are different. Review is answered.
 * This is *worked*: searched, narrowed by date, ticked in batches, placed
 * together. Everything below follows from that.
 *
 * ## The shape
 *
 * **Three piles, not one list.** Spent, Received, Neither — `classifySms`
 * decides which, and the third is the one that earns the feature its keep. Every
 * row in it is a debit: a credit card bill paid out of the same account that
 * made the purchases, a wallet loaded, a fund bought, cash from a machine. Read
 * as expenses they double-count a whole month, and an app that showed them as
 * spending would be wrong in a way its user could feel but not explain. They are
 * shown, named, and not counted.
 *
 * **A scan is an event you can watch.** Not a number that changes on another
 * screen. `SmsScanSheet` owns the choice, the progress and the outcome.
 *
 * **The promise is on the screen, not in a settings page.** One line under the
 * title, and again inside the scan while somebody is watching their own bank
 * messages being read. It is the reason this feature can exist at all and it is
 * worth the two lines.
 *
 * **Ticking is the main verb, so the tick boxes are always there.** Not behind
 * a long press. "Select all" means the rows on screen — never the ones a search
 * is hiding, which is the one mistake here that would cost real money.
 *
 * ## What syncs, and what does not
 *
 * The messages live in a device-only database that the sync engine cannot see
 * (`lib/smsMessageStore.ts`). Placing rows in a group writes ordinary expenses
 * — the shop, the amount, the day — and nothing else. The bodies stay on the
 * phone. Nothing on this path reports a count, a merchant or a body to Sentry,
 * Clarity or any analytics.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import { randomUUID } from 'expo-crypto';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import { MutationKind, peopleSignatureKey, SmsKind } from '@waves/core';
import {
  Button,
  ChipRow,
  Divider,
  EmptyState,
  iconSize,
  MoneyText,
  Row,
  Screen,
  SegmentedTabs,
  Sheet,
  Text,
  useTheme,
} from '@waves/ui';

import {
  DestinationPicker,
  type DestinationSelection,
  type PersonChoice,
} from '@/components/DestinationPicker';
import { ScreenHero, useHeroStatusBar } from '@/components/ScreenHero';
import { filterLabel, SmsFilterSheet } from '@/components/SmsFilterSheet';
import { SignInWall } from '@/components/SignInWall';
import { SmsMessageRow } from '@/components/SmsMessageRow';
import { SmsScanSheet } from '@/components/SmsScanSheet';
import {
  useAddGhostMember,
  useAssignCapture,
  useCaptures,
  useCreateGroup,
  useGroupPeopleSignatures,
  useGroups,
  useHomeSummary,
  useOneToOneGroupIds,
  usePeopleBalances,
} from '@/data/hooks';
import { groupLabel, GroupType, isViewer } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { planCaptureAssign, type AssignMember } from '@/lib/captureBulkAssign';
import { useBottomClearance } from '@/lib/clearance';
import { friendlyError } from '@/lib/errors';
import { useGuestGuard } from '@/lib/guestGuard';
import { router } from '@/lib/navigation';
import {
  allSelected,
  DEFAULT_DATE_FILTER,
  selectedRows,
  smsInboxRows,
  sumOf,
  toggleAll,
  toggleSelected,
  waitingCounts,
  type SmsDateFilter,
} from '@/lib/smsInbox';
import { reloadMessages, useSmsMessages } from '@/lib/smsMessages';
import { SmsSettlement, type StoredSms } from '@/lib/smsMessageTypes';
import { settleMessages } from '@/lib/smsMessageStore';
import { smsCaptureId } from '@/lib/smsCaptureId';
import { useSmsInboxReader } from '@/lib/smsFeature';
import { smsRowAsCapture, splitPlaceable } from '@/lib/smsPlacement';
import { useToast } from '@/lib/toast';
import { usePlaceInPersonal } from '@/lib/usePlaceInPersonal';
import { useSync } from '@/sync';

/** The quick date windows, as chip values. `'more'` opens the filter sheet. */
type Quick = '7' | '30' | '90' | 'all' | 'more';

export default function SmsInboxScreen(): React.JSX.Element | null {
  const theme = useTheme();
  // White clock and battery over the hero's wash, for as long as this screen is
  // the one in front — and handed back on the way out, which a mounted
  // `<StatusBar>` does not do (`useHeroStatusBar`).
  useHeroStatusBar();
  const { t, locale } = useStrings();
  const clearance = useBottomClearance();
  const { session, isGuest } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const reader = useSmsInboxReader();

  /**
   * Who to resolve "me" against: the session's user id, not the profile's.
   *
   * Same id, different arrival times — the session is restored from storage at
   * launch, the profile is a network fetch. Using the profile here made two
   * things wrong for as long as that fetch took: the group list was filtered by
   * a comparison that matches the first *ghost* rather than you (see
   * `data/types.isViewer`), and `myMemberId` — who goes down as having paid —
   * resolved the same way. An expense filed in that window would have named a
   * ghost as the payer.
   */
  const viewerId = session?.user?.id ?? null;
  const { rows, loading, reload } = useSmsMessages();
  const toast = useToast();
  // The shared path to the private ledger, behind the sheet's "Just me" row.
  const placeInPersonal = usePlaceInPersonal();
  const guard = useGuestGuard();

  const [kind, setKind] = useState<SmsKind>(SmsKind.Expense);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState<SmsDateFilter>(DEFAULT_DATE_FILTER);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [scanOpen, setScanOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // One slow clock for the whole screen — "2 days ago" on every row reads it,
  // and none of them may call Date.now() while rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const visible = useMemo(
    () => smsInboxRows({ rows, kind, query, date, now }),
    [rows, kind, query, date, now],
  );
  const counts = useMemo(() => waitingCounts(rows), [rows]);
  const period = useMemo(() => sumOf(visible), [visible]);

  // Note what is *not* here: a pass that prunes the selection when the list
  // changes. It is unnecessary, and an effect that calls setState on every
  // render of a filtered list is a cascade waiting to happen. `chosen` below is
  // the intersection of what is ticked and what is on screen, so a key left
  // over from a row that has since been placed or filtered away is counted by
  // nothing and placed by nothing. The selection is cleared outright once a
  // placement succeeds.
  const chosen = useMemo(() => selectedRows(visible, selected), [visible, selected]);
  const chosenTotal = useMemo(() => sumOf(chosen), [chosen]);

  // ─────────────────────────────────────────────── where things go ──

  const groups = useGroups();
  const summary = useHomeSummary(viewerId);
  const people = usePeopleBalances(viewerId);
  const oneToOne = useOneToOneGroupIds();
  const signatures = useGroupPeopleSignatures(viewerId);
  const createGroup = useCreateGroup();
  const assignCapture = useAssignCapture();
  const captures = useCaptures();
  const { mutate } = useSync();

  const [newGroupId, setNewGroupId] = useState(() => randomUUID());
  const [newMemberId, setNewMemberId] = useState(() => randomUUID());
  const addGhost = useAddGhostMember(newGroupId);

  // Only groups the viewer still belongs to. Leaving sets `left_at` and does
  // not remove the row, so a left group lingers in the local mirror.
  const assignableGroups = useMemo(
    () =>
      (groups.data ?? []).filter((group) =>
        summary.membersFor(group.id).some((member) => isViewer(member, viewerId)),
      ),
    [groups.data, summary, viewerId],
  );

  const peopleChoices = useMemo(() => {
    const byGroup = new Map<string, PersonChoice>();
    for (const row of people.data ?? []) {
      if (!row.only_group_id || !oneToOne.data.has(row.only_group_id)) continue;
      byGroup.set(row.only_group_id, {
        personKey: row.person_key,
        name: row.display_name,
        groupId: row.only_group_id,
      });
    }
    return [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [people.data, oneToOne.data]);

  const groupBySignature = useMemo(() => {
    const map = new Map<string, string>();
    for (const sig of signatures.data) {
      const key = peopleSignatureKey(sig.names);
      if (!map.has(key)) map.set(key, sig.groupId);
    }
    return map;
  }, [signatures.data]);

  /**
   * Ticked messages into a group, as ordinary expenses.
   *
   * Each row is its own attempt. One that refuses does not take the others with
   * it, and it is left ticked rather than vanishing into a success message that
   * would be a lie. Both writes ride the offline queue (ADR-005), so this works
   * with no network and survives being killed halfway.
   *
   * A row that already reached Review has a capture; that capture is closed
   * against the expense it became, so the same spend does not sit in two
   * places. A row that never became one simply has nothing to close.
   */
  const placeInGroup = useCallback(
    async (input: {
      groupId: string;
      label: string;
      members: readonly AssignMember[];
      myMemberId: string | null;
      currency: string;
    }): Promise<void> => {
      if (placing) return;
      if (guard.blockWrite()) return;
      setPlacing(true);
      try {
        const { placeable, unusable } = splitPlaceable(chosen);
        const ids = new Map<string, string>();
        for (const row of placeable) {
          ids.set(row.dedupeKey, await smsCaptureId(ownerId, row.dedupeKey));
        }

        const plan = planCaptureAssign({
          captures: placeable.map((row) => smsRowAsCapture(row, ownerId, ids.get(row.dedupeKey)!)),
          members: input.members,
          myMemberId: input.myMemberId,
          currency: input.currency,
        });

        // Which of these Review already holds, so its draft can be closed.
        const openCaptureIds = new Set((captures.data ?? []).map((capture) => capture.id));

        const done: string[] = [];
        let failed = unusable.length + plan.unusable.length;
        let firstError: unknown = undefined;
        for (const write of plan.writes) {
          try {
            await mutate(MutationKind.ExpenseCreate, input.groupId, write.payload);
            if (openCaptureIds.has(write.captureId)) {
              // Only once the expense is on the queue: a draft closed before
              // its expense exists is a spend that quietly disappeared.
              await assignCapture.mutateAsync({
                captureId: write.captureId,
                groupId: input.groupId,
                expenseId: write.expenseId,
              });
            }
            done.push(write.captureId);
          } catch (caught) {
            failed += 1;
            // Kept rather than dropped: a counted refusal with its reason
            // discarded is a failure nobody can look at afterwards.
            if (firstError === undefined) firstError = caught;
          }
        }

        // Map the expense ids back to the messages they came from, and mark
        // those messages as answered.
        const byId = new Map([...ids].map(([key, id]) => [id, key]));
        const settledKeys = done
          .map((id) => byId.get(id))
          .filter((key): key is string => key !== undefined);
        await settleMessages(
          ownerId,
          settledKeys,
          SmsSettlement.Placed,
          (key) => ids.get(key) ?? null,
        );
        await reloadMessages(ownerId);
        setSelected(new Set());

        if (settledKeys.length > 0) {
          toast.show(
            plural(locale, settledKeys.length, t.smsInbox.placed).replaceAll('{name}', input.label),
          );
        }
        if (failed > 0) {
          // The count *and* the reason. A refusal reported only as a number is
          // one nobody can act on or look up afterwards; `friendlyError` renders
          // it and reports it in the same breath.
          const why =
            firstError === undefined
              ? null
              : friendlyError(firstError, t.captures.couldNotSave, 'sms.placeItem');
          toast.show(
            [plural(locale, failed, t.captures.assignBatchSomeFailed), why]
              .filter(Boolean)
              .join(' '),
            'negative',
          );
        }
      } catch (caught) {
        toast.show(friendlyError(caught, t.captures.couldNotSave, 'sms.place'), 'negative');
      } finally {
        setPlacing(false);
      }
    },
    [
      assignCapture,
      captures.data,
      chosen,
      guard,
      locale,
      mutate,
      ownerId,
      placing,
      t.captures.assignBatchSomeFailed,
      t.captures.couldNotSave,
      t.smsInbox.placed,
      toast,
    ],
  );

  /**
   * The ticked messages as private personal expenses — the "Just me" row.
   *
   * The records and the closing of any Review drafts are the shared path's job
   * (`usePlaceInPersonal`); what stays here is this screen's own bookkeeping,
   * which no other caller has: a placed message is marked answered so it stops
   * appearing as something still waiting, and the list is reloaded from the
   * device store. Only the ones that actually landed are settled — settling a
   * message whose record never got written would hide a spend that was never
   * recorded.
   */
  const keepForMyself = useCallback(async (): Promise<void> => {
    if (placing) return;
    setPickerOpen(false);
    if (chosen.length === 0) return;
    setPlacing(true);
    try {
      const { placeable, unusable } = splitPlaceable(chosen);
      const ids = new Map<string, string>();
      for (const row of placeable) {
        ids.set(row.dedupeKey, await smsCaptureId(ownerId, row.dedupeKey));
      }
      const done = await placeInPersonal({
        lockKey: placeable[0]?.dedupeKey ?? 'personal',
        items: placeable.map((row) => smsRowAsCapture(row, ownerId, ids.get(row.dedupeKey)!)),
      });

      const byId = new Map([...ids].map(([key, id]) => [id, key]));
      const settledKeys = done
        .map((id) => byId.get(id))
        .filter((key): key is string => key !== undefined);
      await settleMessages(
        ownerId,
        settledKeys,
        SmsSettlement.Placed,
        (key) => ids.get(key) ?? null,
      );
      await reloadMessages(ownerId);
      setSelected(new Set());

      // A message the parser could not turn into an amount never had a record
      // to try, and the shared path never saw it — so it is reported here, next
      // to the count that did land, rather than silently dropped.
      if (unusable.length > 0) {
        toast.show(plural(locale, unusable.length, t.captures.assignBatchSomeFailed), 'negative');
      }
    } catch (caught) {
      toast.show(friendlyError(caught, t.captures.couldNotSave, 'sms.personal'), 'negative');
    } finally {
      setPlacing(false);
    }
  }, [
    chosen,
    locale,
    ownerId,
    placeInPersonal,
    placing,
    t.captures.assignBatchSomeFailed,
    t.captures.couldNotSave,
    toast,
  ]);

  const chooseExistingGroup = useCallback(
    (groupId: string): void => {
      setPickerOpen(false);
      const members = summary.membersFor(groupId);
      const group = assignableGroups.find((row) => row.id === groupId);
      void placeInGroup({
        groupId,
        label: group ? groupLabel(group, members, viewerId) : '',
        members,
        myMemberId: members.find((member) => isViewer(member, viewerId))?.id ?? null,
        currency: group?.default_currency ?? chosen[0]?.currency ?? 'INR',
      });
    },
    [assignableGroups, chosen, placeInGroup, viewerId, summary],
  );

  // The People tab, confirmed. If they already share a group it is that group's
  // expense; if not, the group is made here — a lone name is the 1:1 case,
  // several is a real group, both named after whoever is in them.
  const assignToPeople = useCallback(
    async (names: string[]): Promise<void> => {
      const clean = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
      if (clean.length === 0) return;

      const shared = groupBySignature.get(peopleSignatureKey(clean));
      if (shared) {
        chooseExistingGroup(shared);
        return;
      }

      const groupId = newGroupId;
      const currency = chosen[0]?.currency ?? 'INR';
      setPickerOpen(false);
      const ghostIds: string[] = [];
      try {
        await createGroup.mutateAsync({
          groupId,
          creatorMemberId: newMemberId,
          name: clean.join(', '),
          type: GroupType.Other,
          currency,
        });
        for (const name of clean) ghostIds.push(await addGhost.mutateAsync(name));
      } catch (caught) {
        toast.show(
          friendlyError(caught, t.captures.couldNotSave, 'sms.newPeopleGroup'),
          'negative',
        );
        return;
      }
      setNewGroupId(randomUUID());
      setNewMemberId(randomUUID());
      // The group and its people exist only on the queue so far, so the mirror
      // cannot list its members yet. Their ids were minted here.
      void placeInGroup({
        groupId,
        label: clean.join(', '),
        members: [{ id: newMemberId }, ...ghostIds.map((id) => ({ id }))],
        myMemberId: newMemberId,
        currency,
      });
    },
    [
      addGhost,
      chooseExistingGroup,
      chosen,
      createGroup,
      groupBySignature,
      newGroupId,
      newMemberId,
      placeInGroup,
      t.captures.couldNotSave,
      toast,
    ],
  );

  /** Set aside: not an expense, or not one worth splitting. */
  const setAside = useCallback(async (): Promise<void> => {
    const keys = chosen.map((row) => row.dedupeKey);
    if (keys.length === 0) return;
    await settleMessages(ownerId, keys, SmsSettlement.Dismissed);
    await reloadMessages(ownerId);
    setSelected(new Set());
    toast.show(plural(locale, keys.length, t.smsInbox.setAsideDone));
  }, [chosen, locale, ownerId, t.smsInbox.setAsideDone, toast]);

  // ───────────────────────────────────────────────────── rendering ──

  const quick: Quick =
    date.kind === 'window' ? (date.days === 0 ? 'all' : (String(date.days) as Quick)) : 'more';

  const onQuick = useCallback((value: Quick): void => {
    if (value === 'more') {
      setFilterOpen(true);
      return;
    }
    setDate(
      value === 'all'
        ? { kind: 'window', days: 0 }
        : { kind: 'window', days: Number(value) as 7 | 30 | 90 },
    );
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: StoredSms }) => (
      <SmsMessageRow
        row={item}
        selected={selected.has(item.dedupeKey)}
        locale={locale}
        now={now}
        t={t}
        onToggle={() => setSelected((current) => toggleSelected(current, item.dedupeKey))}
        onOpen={() =>
          router.push({ pathname: '/captures/sms/[key]', params: { key: item.dedupeKey } })
        }
      />
    ),
    [locale, now, selected, t],
  );

  // A guest is turned away with a reason rather than a blank screen. It comes
  // before the reader check because `useSmsInboxReader` is false for them as
  // well, and "nothing here" answers none of the question they would have.
  if (isGuest) return <SignInWall area="sms" />;

  // Asked again here rather than trusted from the screen that pushed: a deep
  // link, a stale back stack, or the flag switching off while this was open
  // must all end the same way.
  if (!reader) return null;

  const everythingTicked = allSelected(visible, selected);

  // What the hero's number is *of*, in the same words the tab below it wears —
  // the figure changes when you switch pile, so it has to say which pile.
  const kindLabel =
    kind === SmsKind.Expense
      ? t.smsInbox.tabExpenses
      : kind === SmsKind.Income
        ? t.smsInbox.tabIncome
        : t.smsInbox.tabOther;

  return (
    <Screen edges={[]}>
      {/* Bank messages opens on the same panel a group does. It is not a
          sub-page of Review — it is a screen people come to and work, and it
          used to announce itself with the small-glyph-and-title row of a
          settings page. Same shell as the group hero (`ScreenHero`), so the
          two cannot drift.

          The panel carries three things: what this is and the promise about
          where the messages stay, the figure for the pile currently shown, and
          the search. Search belongs up here rather than in a band of its own —
          it is how this screen is used, and on the panel it costs no vertical
          room at all. */}
      <ScreenHero
        icon="chatbubbles"
        title={t.smsInbox.title}
        // The promise, where it cannot be missed. Not a settings page, not a
        // paragraph — one line, under the name of the thing it is about.
        subtitle={t.smsInbox.onDevice}
        back={{ label: t.common.back, onPress: () => router.back() }}
        actions={[
          {
            icon: 'options-outline',
            label: t.smsInbox.filterTitle,
            onPress: () => setFilterOpen(true),
          },
          { icon: 'refresh', label: t.smsInbox.scan, onPress: () => setScanOpen(true) },
        ]}
      >
        <View style={{ gap: theme.spacing.md }}>
          {/* The figure that justified the old band under the tabs: a filtered
              list with no total makes a person add the rows up themselves. No
              money for the third pile, deliberately — those are the rows that
              must not be summed as spending — so it shows how many there are
              instead. */}
          {chosen.length > 0 ? (
            /* Ticked rows take the panel over, exactly as they do on Review:
                the count is a state and states are reported up here, which
                leaves the bar at the bottom holding nothing but actions. The
                period's total is not lost — the bar shows the total of what
                is *selected*, which while choosing is the more useful of the
                two figures anyway. */
            <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
              <Text variant="title" tone="onBrand" numberOfLines={1} style={{ flex: 1 }}>
                {plural(locale, chosen.length, t.smsInbox.selected)}
              </Text>
              <Button
                label={everythingTicked ? t.smsInbox.selectNone : t.smsInbox.selectAll}
                variant="onBrandOutline"
                size="sm"
                onPress={() => setSelected((current) => toggleAll(visible, current))}
              />
            </Row>
          ) : period.count > 0 ? (
            <View>
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }} numberOfLines={1}>
                {kindLabel}
              </Text>
              {period.total !== null && kind !== SmsKind.Other ? (
                <MoneyText
                  amount={period.total}
                  currency={period.currency}
                  locale={locale}
                  variant="title"
                  tone="default"
                  style={{ color: theme.color.onBrand }}
                />
              ) : (
                <Text variant="title" tone="onBrand">
                  {plural(locale, period.count, t.smsImport.messageCount)}
                </Text>
              )}
              {/* Said out loud rather than left to be noticed: a total that
                  quietly skipped rows is a number with nothing to question. */}
              {period.uncounted > 0 && kind !== SmsKind.Other ? (
                <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }}>
                  {plural(locale, period.uncounted, t.smsInbox.notCounted)}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Search. A plain field rather than an icon that expands into one:
              this screen is a list people come to *look through*, and a search
              hidden behind a tap on a list like that is a search most people
              never use. On the panel it wears the dim white of every other
              on-hero control rather than the body's muted grey. */}
          <Row
            style={{
              alignItems: 'center',
              gap: theme.spacing.sm,
              paddingHorizontal: theme.spacing.lg,
              height: 44,
              borderRadius: theme.radius.pill,
              backgroundColor: 'rgba(255, 255, 255, 0.18)',
            }}
          >
            <Ionicons name="search" size={iconSize.sm} color={theme.color.onBrand} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t.smsInbox.searchPlaceholder}
              placeholderTextColor="rgba(255, 255, 255, 0.7)"
              accessibilityLabel={t.smsInbox.searchPlaceholder}
              autoCorrect={false}
              style={{ flex: 1, color: theme.color.onBrand, fontSize: 15, paddingVertical: 0 }}
            />
            {query !== '' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.smsInbox.searchClear}
                hitSlop={8}
                onPress={() => setQuery('')}
              >
                <Ionicons name="close-circle" size={iconSize.sm} color={theme.color.onBrand} />
              </Pressable>
            ) : null}
          </Row>
        </View>
      </ScreenHero>

      <View style={{ paddingHorizontal: theme.spacing.xl, paddingVertical: theme.spacing.md }}>
        <ChipRow
          options={[
            { value: '7', label: t.smsInbox.last7 },
            { value: '30', label: t.smsInbox.last30 },
            { value: '90', label: t.smsInbox.last90 },
            { value: 'all', label: t.smsInbox.allTime },
            // The fifth chip wears whatever the sheet chose, so a month or a
            // range is visible on the screen rather than only inside the sheet
            // that set it.
            {
              value: 'more',
              label:
                date.kind === 'window' ? t.smsInbox.filterByMonth : filterLabel(date, locale, t),
            },
          ]}
          value={quick}
          onChange={onQuick}
        />
      </View>

      <SegmentedTabs
        value={kind}
        onChange={setKind}
        // A glyph on each, the same convention the group ledger's three tabs
        // wear. Direction is the whole distinction between the first two, so
        // the marks carry it: money leaving, money arriving, and a pile that is
        // neither and must never be summed as either.
        tabs={[
          {
            value: SmsKind.Expense,
            label: countLabel(t.smsInbox.tabExpenses, counts[SmsKind.Expense]),
            icon: (color) => (
              <Ionicons name="arrow-up-circle-outline" size={iconSize.md} color={color} />
            ),
          },
          {
            value: SmsKind.Income,
            label: countLabel(t.smsInbox.tabIncome, counts[SmsKind.Income]),
            icon: (color) => (
              <Ionicons name="arrow-down-circle-outline" size={iconSize.md} color={color} />
            ),
          },
          {
            value: SmsKind.Other,
            label: countLabel(t.smsInbox.tabOther, counts[SmsKind.Other]),
            icon: (color) => (
              <Ionicons name="help-circle-outline" size={iconSize.md} color={color} />
            ),
          },
        ]}
      />

      {/* One gesture, on one line, and only while nothing is ticked — once
          something is, the same control is on the panel beside the count,
          which is where a scope control belongs and is a shorter reach from
          the row that was just tapped. Two homes, never both at once.

          "Select all" means the rows on screen, never the ones a search is
          hiding: the one mistake here that would cost real money. */}
      {visible.length > 0 && chosen.length === 0 ? (
        <Row
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingVertical: theme.spacing.xs,
            alignItems: 'center',
            justifyContent: 'flex-end',
          }}
        >
          <Button
            label={everythingTicked ? t.smsInbox.selectNone : t.smsInbox.selectAll}
            variant="ghost"
            size="sm"
            onPress={() => setSelected((current) => toggleAll(visible, current))}
          />
        </Row>
      ) : null}

      <FlashList
        data={loading ? [] : visible}
        keyExtractor={(item) => item.dedupeKey}
        renderItem={renderRow}
        extraData={selected}
        // The group ledger's number, which is the one that has actually been
        // tuned: 1500 was still being outrun by a hard fling down a long list,
        // and blank rows flashing past is the failure people report. ~2500px is
        // three dozen rows ahead, cheap when each row is light to draw.
        drawDistance={2500}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={Divider}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance + (chosen.length > 0 ? 80 : 0),
        }}
        ListEmptyComponent={
          loading ? null : (
            <View style={{ paddingTop: theme.spacing.xxxl }}>
              <EmptyState
                icon={
                  <Ionicons
                    name={rows.length === 0 ? 'chatbubbles-outline' : 'checkmark-done-outline'}
                    size={iconSize.huge}
                    color={theme.color.brand}
                  />
                }
                // Three empty states, because there are three reasons to be
                // empty and one message for all of them would be wrong twice.
                title={
                  rows.length === 0
                    ? t.smsInbox.emptyNothingYet
                    : query !== ''
                      ? t.smsInbox.emptyNoMatch
                      : t.smsInbox.emptyAllDone
                }
                body={
                  rows.length === 0
                    ? t.smsInbox.emptyNothingYetBody
                    : query !== ''
                      ? t.smsInbox.emptyNoMatchBody
                      : t.smsInbox.emptyAllDoneBody
                }
                action={
                  rows.length === 0 ? (
                    <Button label={t.smsInbox.scan} onPress={() => setScanOpen(true)} />
                  ) : null
                }
              />
            </View>
          )
        }
      />

      {/* The action bar, present only when something is ticked. It carries the
          count *and* the total, because "add 6" and "add ₹4,310" are two
          different things to be sure about before pressing. */}
      {chosen.length > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            paddingBottom: clearance,
            gap: theme.spacing.sm,
            backgroundColor: theme.color.surface,
            borderTopWidth: 1,
            borderTopColor: theme.color.border,
          }}
        >
          {/* What the selection *costs*, and nothing else — the count that
              used to lead this line is on the panel now. This figure stays
              down here on purpose: it is the one number that has to be read
              in the same glance as the button that commits it. */}
          {chosenTotal.total !== null || chosenTotal.uncounted > 0 ? (
            <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
              {chosenTotal.total !== null ? (
                <MoneyText
                  amount={chosenTotal.total}
                  currency={chosenTotal.currency}
                  locale={locale}
                  variant="caption"
                />
              ) : null}
              {/* The same disclosure the band above carries, and for the same
                  reason — more so here, because this figure sits directly
                  beside the button that acts on the rows. A total that quietly
                  skipped rows would be wrong exactly where somebody is about
                  to commit. */}
              {chosenTotal.uncounted > 0 ? (
                <Text variant="micro" tone="muted">
                  {plural(locale, chosenTotal.uncounted, t.smsInbox.notCounted)}
                </Text>
              ) : null}
            </Row>
          ) : null}
          <Row style={{ gap: theme.spacing.sm }}>
            {/* Both placements are buttons of the same build — a bare text
                link beside a filled pill reads as a footnote, and "set aside"
                is not a footnote, it is half of what this bar is for. */}
            <Button
              label={plural(locale, chosen.length, t.smsInbox.setAside)}
              variant="secondary"
              style={{ flex: 1 }}
              // No confirm. Setting aside is reversible — the row comes back
              // from the detail screen — and a dialog in front of a reversible
              // action is a dialog people learn to dismiss without reading.
              onPress={() => void setAside()}
            />
            <Button
              label={plural(locale, chosen.length, t.smsInbox.addToGroup)}
              style={{ flex: 1.4 }}
              disabled={placing}
              onPress={() => setPickerOpen(true)}
            />
          </Row>
        </View>
      ) : null}

      <SmsScanSheet
        visible={scanOpen}
        ownerId={ownerId}
        onClose={() => setScanOpen(false)}
        onFinished={() => void reload()}
      />

      <SmsFilterSheet
        visible={filterOpen}
        rows={rows}
        value={date}
        onApply={(next) => {
          setDate(next);
          setFilterOpen(false);
        }}
        onClose={() => setFilterOpen(false)}
      />

      {/* The same picker the Review screen and the voice review open, so
          "where does this go?" is one control in the app rather than three. */}
      <Sheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        padded={false}
        closeLabel={t.common.close}
        style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.md, maxHeight: '80%' }}
      >
        <Text variant="heading">{t.captures.assignTitle}</Text>
        <Row style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="caption" tone="muted">
            {plural(locale, chosen.length, t.smsInbox.selected)}
          </Text>
          {chosenTotal.total !== null ? (
            <MoneyText
              amount={chosenTotal.total}
              currency={chosenTotal.currency}
              locale={locale}
              variant="subheading"
            />
          ) : null}
        </Row>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ flexShrink: 1 }}
        >
          <DestinationPicker
            key={pickerOpen ? 'open' : 'closed'}
            selection={{ kind: 'none' } as DestinationSelection}
            eyebrow={null}
            // "Unassigned" is not offered: these already sit outside every
            // group, so the row would point at where they already are. "Just
            // me" is — a private personal expense (A48), written through the
            // same shared path the Review screen and the voice review use.
            pinned={['me']}
            createRow={null}
            emptyGroups={t.captures.noGroups}
            labelFor={(group) => groupLabel(group, summary.membersFor(group.id), viewerId)}
            groups={assignableGroups}
            people={peopleChoices}
            t={t}
            onChoose={(choice) => {
              if (choice.kind === 'existing') chooseExistingGroup(choice.groupId);
              else if (choice.kind === 'me') void keepForMyself();
            }}
            onResolvePeople={(names) => void assignToPeople(names)}
          />
        </ScrollView>
      </Sheet>
    </Screen>
  );
}

/** "Spent · 14" — the count beside the word, never instead of it. */
function countLabel(word: string, count: number): string {
  return count === 0 ? word : `${word} ${count}`;
}
