/**
 * The capture inbox: expenses caught before they had a group (A34).
 *
 * Each row is a spend the user pinned for later — an amount, maybe a note and a
 * photo of the bill — waiting to be assigned to a group. Assigning opens the
 * ordinary add-expense form prefilled; saving there turns the capture into a
 * real group expense and drops it from this list. Everything here is personal
 * and offline-first: a row still queued wears a faint cloud glyph rather than
 * hiding until the server has seen it (ADR-005). Expenses spoken in one breath
 * fold into a single collapsible "N expenses" row with the running total.
 */

import { useCallback, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import {
  Alert,
  Pressable,
  RefreshControl,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  Avatar,
  Button,
  directionalIcon,
  Divider,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Sheet,
  Text,
  tintForKey,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import { PendingMark } from '@/components/PendingMark';
import { InboxSkeleton } from '@/components/Skeletons';
import { dayHeading } from '@/data/activity';
import { useCaptures, useDeleteCapture, useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel, type CaptureRow, type GroupRow } from '@/data/types';
import { fill, plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { assignCaptureHref } from '@/lib/captureAssign';
import { foldedCaptureCount } from '@/lib/captureBatch';
import { buildCaptureFeedItems, type CaptureFeedItem } from '@/lib/captureFeed';
import { usePullRefresh } from '@/lib/pullRefresh';

/** Minimum width of the right-aligned amount column, so short (₹300) and long
 *  (₹80,580) amounts share a right edge and read as one column down the list. */
const AMOUNT_COLUMN = 76;

/**
 * What the ⋯ overflow sheet is open on: a single capture (add to group / edit /
 * delete) or a whole spoken batch (delete them all). Null when nothing is open.
 */
type CaptureMenu =
  { kind: 'capture'; capture: CaptureRow } | { kind: 'batch'; items: CaptureRow[] } | null;

/**
 * The pill on a row's second line that names its one action: "Add to a group"
 * when the capture is loose, or "Add to Goa Trip" when it was pre-aimed at one.
 * Brand-soft and filled when aimed (a real destination to confirm), a quiet
 * dashed outline when still open — so a labelled affordance replaces the old
 * invisible "the whole card is secretly tappable". The chip is a label, not its
 * own button: the card's tap is what assigns.
 */
function AssignChip({ label, aimed }: { label: string; aimed: boolean }): React.JSX.Element {
  const theme = useTheme();
  const ink = aimed ? theme.color.brand : theme.color.textMuted;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingVertical: 3,
        // Logical, not left/right, so the plus-then-label pill mirrors in RTL.
        paddingStart: 6,
        paddingEnd: 9,
        borderRadius: theme.radius.pill,
        backgroundColor: aimed ? theme.color.brandSoft : theme.color.surfaceMuted,
        borderWidth: aimed ? 0 : 1,
        borderColor: theme.color.border,
        borderStyle: 'dashed',
        flexShrink: 1,
      }}
    >
      <Ionicons name="add" size={13} color={ink} />
      <Text
        variant="micro"
        numberOfLines={1}
        style={{ color: ink, fontWeight: '600', flexShrink: 1 }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * One capture, in the card grammar this screen now speaks (Mobbin: Phantom
 * Recent Activity, Apple Wallet Daily Cash): a leading category glyph — always
 * the category colour, never the bill's thumbnail — the note over a muted place
 * line, and the amount at the trailing edge, all on a soft rounded card.
 *
 * The whole card taps to assign — adding it to a group is the one thing you do
 * with a capture, so it is the card's own gesture, not a control to hunt for.
 * The quieter things (edit, delete) fold behind a single ⋯ at the trailing edge,
 * which opens the actions sheet; the two used to sit on the row as a pencil and
 * an always-red trash, which crowded the amount and put "delete" a mis-tap from
 * the assign gesture. The ⋯ keeps its own hitbox so the card's tap still
 * assigns. Inside a batch a row is `bare` — no card of its own, since the batch
 * card already frames it — and drops the place (the batch is one outing, one
 * location).
 */
function CaptureListRow({
  capture,
  locale,
  t,
  onAssign,
  onMore,
  targetGroupName = null,
  hideLocation = false,
  bare = false,
}: {
  capture: CaptureRow;
  locale: string;
  t: UiStrings;
  onAssign: () => void;
  /** Open the row's overflow sheet (add to group, edit, delete). */
  onMore: () => void;
  /** The group this capture was tagged for, resolved to its display name — so the
   *  assign chip reads "Add to Goa Trip". Null when it was not pre-aimed (or the
   *  aimed group is one the viewer can no longer assign into). */
  targetGroupName?: string | null;
  /** Inside a batch the description IS the line that matters, so the place is
   *  suppressed there — the batch stands for one outing, one location. */
  hideLocation?: boolean;
  /** A row nested in a batch card: no card frame of its own. */
  bare?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  // The note names the spend; with none, its category does; with neither, it is
  // simply still unassigned. The amount always sits at the trailing edge, so the
  // title never has to carry it.
  const categoryLabel = capture.category
    ? (t.categories as Record<string, string>)[capture.category]
    : undefined;
  const title = capture.description?.trim() || categoryLabel || t.captures.unassigned;
  // Second line: the place it happened, else a note, else nothing. Never the
  // date — the section heading already carries the day. A row inside a batch
  // drops the place; there the description on the title line is the whole point.
  const locationName = hideLocation ? '' : capture.location?.name?.trim() || '';
  const subtitle = locationName || capture.notes?.trim() || '';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${t.captures.assign}`}
      // The overflow lives on a control nested inside this row; a nested focusable
      // can hide from a screen reader, so the row exposes it as a custom action
      // instead and the ⋯ itself is taken out of the a11y tree below. Assign stays
      // the row's default activate.
      accessibilityActions={[{ name: 'more', label: t.captures.moreActions }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'more') onMore();
      }}
      onPress={onAssign}
      style={({ pressed }) =>
        bare
          ? { opacity: pressed ? 0.6 : 1 }
          : {
              opacity: pressed ? 0.85 : 1,
              backgroundColor: theme.color.surface,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.color.border,
              paddingHorizontal: theme.spacing.md,
              marginVertical: theme.spacing.xs,
            }
      }
    >
      <Row
        style={{ gap: theme.spacing.md, alignItems: 'center', paddingVertical: theme.spacing.md }}
      >
        <CategoryBadge
          category={capture.category}
          meta={capture.category_meta}
          description={capture.description}
          size={46}
        />

        <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
          <Text variant="subheading" numberOfLines={1}>
            {title}
          </Text>
          {/* Line two spells the one thing you do with a capture — add it to a
              group — and names the group when the capture was pre-aimed at one, so
              the action is labelled rather than hidden in the card's tap. The
              place and the unsynced mark trail it, muted. Inside a batch the chip
              is dropped: the batch's own line already says how its items assign. */}
          {!bare || subtitle || capture.pending ? (
            <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
              {!bare ? (
                <AssignChip
                  label={
                    targetGroupName
                      ? fill(t.captures.addTo, { name: targetGroupName })
                      : t.captures.assign
                  }
                  aimed={Boolean(targetGroupName)}
                />
              ) : null}
              {locationName ? (
                <Ionicons name="location-outline" size={13} color={theme.color.textFaint} />
              ) : null}
              {subtitle ? (
                <Text variant="micro" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {subtitle}
                </Text>
              ) : null}
              {capture.pending ? <PendingMark /> : null}
            </Row>
          ) : null}
        </View>

        {/* The amount sits in a right-aligned column so the numbers line up down
            the list rather than each ending wherever its own width happens to
            land — a ledger reads by its right edge. */}
        <View style={{ minWidth: AMOUNT_COLUMN, alignItems: 'flex-end' }}>
          <MoneyText
            amount={BigInt(capture.amount)}
            currency={capture.currency}
            locale={locale}
            variant="subheading"
          />
        </View>
        {/* One quiet ⋯ instead of the old pencil-and-red-trash pair: the actions
            that are not "add to group" live behind it, so the row carries the
            amount and a single neutral control rather than three competing marks.
            Its own hitbox for a sighted tap, but hidden from the a11y tree — a
            focusable nested in the accessible row can be unreachable, so screen
            readers reach it through the row's "more" action instead.

            The trailing slot mirrors the batch card's ⋯-plus-chevron exactly
            (same order, same gap) so a standalone amount shares its right edge
            with a batch total — the empty slot stands in for the batch's expand
            chevron. */}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
        >
          <IconButton label={t.captures.moreActions} onPress={onMore}>
            <Ionicons name="ellipsis-horizontal" size={iconSize.md} color={theme.color.textMuted} />
          </IconButton>
          <View style={{ width: iconSize.md }} />
        </View>
      </Row>
    </Pressable>
  );
}

/**
 * Several expenses spoken in one breath, folded into one collapsible row: a
 * layered glyph, an "N expenses" title over a preview of what they were, and the
 * running total at the trailing edge with a plus to open. Expanding reveals each
 * as a full capture row — still individually assignable and deletable — so the
 * total is the headline and the breakdown is one tap away.
 */
function BatchGroupCard({
  items,
  locale,
  t,
  open,
  onToggle,
  onAssign,
  onMore,
  onMoreBatch,
}: {
  items: CaptureRow[];
  locale: string;
  t: UiStrings;
  open: boolean;
  onToggle: () => void;
  onAssign: (capture: CaptureRow) => void;
  onMore: (capture: CaptureRow) => void;
  onMoreBatch: () => void;
}) {
  const theme = useTheme();

  const currency = items[0]!.currency;
  const sameCurrency = items.every((item) => item.currency === currency);
  const total = sameCurrency ? items.reduce((sum, item) => sum + BigInt(item.amount), 0n) : null;
  const anyPending = items.some((item) => item.pending);
  // A spoken batch is one outing in one place, so the location belongs to the
  // group, not repeated on every item. Take the first place any item carries.
  const batchLocation = items.map((item) => item.location?.name?.trim()).find((name) => name) ?? '';

  return (
    // One rounded, bordered card so the header and its items read as a single
    // grouped unit, set apart from the flush standalone rows around it — the
    // grouped-transactions grammar (Monarch, PayPal, Commons).
    <View
      style={{
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.color.border,
        backgroundColor: theme.color.surface,
        overflow: 'hidden',
        marginVertical: theme.spacing.xs,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? t.captures.collapseBatch : t.captures.expandBatch}
        // The ⋯ (delete-the-batch) is nested inside this expander; a nested
        // focusable can hide from a screen reader, so it rides here as a custom
        // action and is dropped from the a11y tree below.
        accessibilityActions={[{ name: 'more', label: t.captures.moreActions }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'more') onMoreBatch();
        }}
        onPress={onToggle}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Row
          style={{
            gap: theme.spacing.md,
            alignItems: 'center',
            paddingVertical: theme.spacing.md,
            paddingHorizontal: theme.spacing.md,
          }}
        >
          <View
            style={{
              width: 46,
              height: 46,
              borderRadius: 14,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.brandSoft,
            }}
          >
            <Ionicons name="layers-outline" size={iconSize.lg} color={theme.color.brand} />
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            {/* The count is the whole headline — a batch stands for one outing,
                so the individual descriptions belong to the expanded rows, not
                here. The second line says what the folded row can do, so a person
                is not left guessing whether it assigns whole or item by item. */}
            <Text variant="subheading" numberOfLines={1}>
              {plural(locale, items.length, t.captures.batchExpenses)}
            </Text>
            <Row style={{ gap: theme.spacing.xs, alignItems: 'center', marginTop: 2 }}>
              <Text variant="micro" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {t.captures.batchHint}
              </Text>
              {anyPending ? <PendingMark /> : null}
            </Row>
          </View>

          {/* Total then the expander, both trailing — the chevron is the standard
              reveal affordance (down closed, up open), sitting just past the
              amount rather than a plus crammed at the edge. */}
          {/* Same right-aligned amount column as the standalone rows, so a
              batch total lines up under the single amounts above and below it. */}
          <View style={{ minWidth: AMOUNT_COLUMN, alignItems: 'flex-end' }}>
            {total !== null ? (
              <MoneyText amount={total} currency={currency} locale={locale} variant="subheading" />
            ) : (
              <Text variant="subheading" tone="muted">
                {plural(locale, items.length, t.captures.batchExpenses)}
              </Text>
            )}
          </View>
          {/* The batch's own ⋯, matching the standalone rows: it opens the sheet
              that can delete the whole batch at once, rather than a standing red
              trash on the card. A nested press for a sighted tap, but hidden from
              the a11y tree (reached through the row's "more" action); the chevron
              beside it is decorative — the expanded state is already announced. */}
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
          >
            <IconButton label={t.captures.moreActions} onPress={onMoreBatch}>
              <Ionicons
                name="ellipsis-horizontal"
                size={iconSize.md}
                color={theme.color.textMuted}
              />
            </IconButton>
            <Ionicons
              name={open ? 'chevron-up' : 'chevron-down'}
              size={iconSize.md}
              color={theme.color.textMuted}
            />
          </View>
        </Row>
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: theme.spacing.md }}>
          {/* The outing's place, shown once for the whole group — the item rows
              below carry only their descriptions, not the place repeated. */}
          {batchLocation ? (
            <Row
              style={{
                gap: theme.spacing.xs,
                alignItems: 'center',
                paddingTop: theme.spacing.sm,
              }}
            >
              <Ionicons name="location-outline" size={13} color={theme.color.textMuted} />
              <Text variant="micro" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {batchLocation}
              </Text>
            </Row>
          ) : null}
          {items.map((capture, index) => (
            <View key={capture.id}>
              <Divider />
              <CaptureListRow
                capture={capture}
                locale={locale}
                t={t}
                onAssign={() => onAssign(capture)}
                onMore={() => onMore(capture)}
                hideLocation
                bare
              />
              {index === items.length - 1 ? <View style={{ height: theme.spacing.xs }} /> : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One action in the ⋯ overflow sheet: a leading glyph and a label, tinted by
 * role — brand for the primary "add to group", the ink default for edit, red for
 * a delete. The whole row is the hitbox, the grammar the picker sheets use.
 */
function ActionSheetRow({
  icon,
  label,
  tone = 'default',
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tone?: 'default' | 'brand' | 'negative';
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const color =
    tone === 'negative'
      ? theme.color.negative
      : tone === 'brand'
        ? theme.color.brand
        : theme.color.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.md} color={color} />
      <Text variant="body" style={{ flex: 1, color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Capture inbox route backed by FlashList rows and screen-owned batch expansion state. */
export default function CapturesScreen() {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const pull = usePullRefresh();
  const { profile } = useAuth();

  const captures = useCaptures();
  const deleteCapture = useDeleteCapture();
  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);

  // Which capture is being assigned, if any — drives the group-picker sheet.
  const [assigning, setAssigning] = useState<CaptureRow | null>(null);
  // The picker's own search text, so a long group list stays one tap from any
  // group. Cleared whenever the sheet opens on a fresh capture.
  const [query, setQuery] = useState('');
  // FlashList recycles row components, so batch expansion lives with the screen
  // and is keyed by batch id rather than inside the recycled row instance.
  const [openBatchIds, setOpenBatchIds] = useState<ReadonlySet<string>>(() => new Set());
  // The row's ⋯ overflow: which capture (or which spoken batch) has its actions
  // sheet open, if any. Null when nothing is open.
  const [menu, setMenu] = useState<CaptureMenu>(null);

  // Only groups the viewer still belongs to belong in the picker. Leaving a
  // group sets `left_at`; it does not remove the group row, so a left (or
  // owner-removed) group lingers in the local mirror and `useGroups` still
  // returns it. `membersFor` lists active members only, so a group where the
  // viewer is no longer among them is one they left — never an assignment
  // target for a new expense.
  const assignableGroups = useMemo(
    () =>
      (groups.data ?? []).filter((group) =>
        summary.membersFor(group.id).some((member) => member.profile_id === profile?.id),
      ),
    [groups.data, summary, profile?.id],
  );

  // Group rows matching the picker's search text, by name. Only worth showing a
  // search field once the list is long enough to scroll (below); until then the
  // memo just passes every group through.
  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return assignableGroups;
    return assignableGroups.filter((group) =>
      groupLabel(group, summary.membersFor(group.id), profile?.id).toLowerCase().includes(needle),
    );
  }, [assignableGroups, query, summary, profile?.id]);

  // Past this many groups the picker earns a search field; a short list is
  // faster to eyeball than to type through.
  const showSearch = assignableGroups.length > 6;
  const pickerListHeight = Math.max(180, height * (showSearch ? 0.34 : 0.42));

  const rows = useMemo(() => captures.data ?? [], [captures.data]);
  const feedItems = useMemo(() => buildCaptureFeedItems(rows), [rows]);
  // A spoken batch is one thing waiting, not one per item — fold before counting,
  // so the header total matches the rows on screen.
  const waitingCount = useMemo(() => foldedCaptureCount(rows), [rows]);

  const openAssign = useCallback((capture: CaptureRow): void => {
    setQuery('');
    setAssigning(capture);
  }, []);

  // Open the draft in the capture form to fix its fields — the same screen that
  // drafted it, now in edit mode. Every value the row carries rides along as a
  // param so the form opens filled in and saving updates the row in place rather
  // than making a second one; `parsed` (which holds the voice-batch id) is
  // preserved so an edited batch item stays part of its batch.
  const openEdit = useCallback((capture: CaptureRow): void => {
    router.push({
      pathname: '/capture',
      params: {
        editId: capture.id,
        amount: capture.amount,
        desc: capture.description ?? '',
        cur: capture.currency,
        category: capture.category ?? '',
        ...(capture.category_meta ? { categoryMeta: JSON.stringify(capture.category_meta) } : {}),
        date: capture.expense_date,
        ...(capture.payment_method ? { payment: capture.payment_method } : {}),
        ...(capture.target_group_id ? { targetGroupId: capture.target_group_id } : {}),
        ...(capture.location ? { location: JSON.stringify(capture.location) } : {}),
        ...(capture.notes ? { note: capture.notes } : {}),
        ...(capture.photo_path ? { photoPath: capture.photo_path } : {}),
        ...(capture.raw_text ? { rawText: capture.raw_text } : {}),
        ...(capture.parsed ? { parsed: JSON.stringify(capture.parsed) } : {}),
      },
    });
  }, []);

  // Shared by the standalone rows and the rows inside a batch, so a capture is
  // deleted the same way wherever it is shown.
  const confirmDelete = useCallback(
    (capture: CaptureRow): void => {
      Alert.alert(t.captures.delete, t.captures.deleteConfirm, [
        { text: t.common.cancel, style: 'cancel' },
        {
          text: t.captures.delete,
          style: 'destructive',
          onPress: () => void deleteCapture.mutateAsync(capture.id),
        },
      ]);
    },
    [deleteCapture, t.captures.delete, t.captures.deleteConfirm, t.common.cancel],
  );

  // Delete every capture in a spoken batch at once, behind one confirm — the
  // trailing trash on the batch card.
  const confirmDeleteBatch = useCallback(
    (items: CaptureRow[]): void => {
      Alert.alert(
        t.captures.deleteBatch,
        plural(locale, items.length, t.captures.deleteBatchConfirm),
        [
          { text: t.common.cancel, style: 'cancel' },
          {
            text: t.captures.delete,
            style: 'destructive',
            onPress: () => {
              for (const item of items) void deleteCapture.mutateAsync(item.id);
            },
          },
        ],
      );
    },
    [
      deleteCapture,
      locale,
      t.captures.delete,
      t.captures.deleteBatch,
      t.captures.deleteBatchConfirm,
      t.common.cancel,
    ],
  );

  const closeAssign = useCallback((): void => {
    setAssigning(null);
    setQuery('');
  }, []);

  // Hand the capture's own values to the add-expense form as prefill, and carry
  // its id so that saving there can close the capture (useAssignCapture). The
  // href is built by the shared helper so the "New group" flow, which routes to
  // the very same form, hands it identical params.
  const assignTo = useCallback(
    (capture: CaptureRow, group: GroupRow): void => {
      closeAssign();
      router.push(assignCaptureHref(capture, group.id));
    },
    [closeAssign],
  );

  const closeMenu = useCallback((): void => setMenu(null), []);
  const openCaptureMenu = useCallback(
    (capture: CaptureRow): void => setMenu({ kind: 'capture', capture }),
    [],
  );
  const openBatchMenu = useCallback(
    (items: CaptureRow[]): void => setMenu({ kind: 'batch', items }),
    [],
  );

  const keyCaptureItem = useCallback((item: CaptureFeedItem): string => {
    switch (item.kind) {
      case 'day':
        return item.key;
      case 'batch':
        return `batch-${item.id}`;
      case 'single':
        return item.capture.id;
    }
  }, []);

  const toggleBatch = useCallback((batchId: string): void => {
    setOpenBatchIds((current) => {
      const next = new Set(current);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }, []);

  const renderCaptureItem = useCallback(
    ({ item }: { item: CaptureFeedItem }) => {
      switch (item.kind) {
        case 'day':
          return (
            <Text
              variant="micro"
              tone="muted"
              style={{
                textTransform: 'uppercase',
                marginTop: theme.spacing.md,
                marginBottom: theme.spacing.xs,
              }}
            >
              {dayHeading(locale, item.createdAt)}
            </Text>
          );
        case 'batch':
          return (
            <BatchGroupCard
              items={item.items}
              locale={locale}
              t={t}
              open={openBatchIds.has(item.id)}
              onToggle={() => toggleBatch(item.id)}
              onAssign={openAssign}
              onMore={openCaptureMenu}
              onMoreBatch={() => openBatchMenu(item.items)}
            />
          );
        case 'single': {
          const capture = item.capture;
          // The group this capture was pre-aimed at, if it is still one the viewer
          // can assign into — the chip names it and the tap goes straight there.
          const targetGroup = capture.target_group_id
            ? (assignableGroups.find((group) => group.id === capture.target_group_id) ?? null)
            : null;
          const targetGroupName = targetGroup
            ? groupLabel(targetGroup, summary.membersFor(targetGroup.id), profile?.id)
            : null;
          return (
            <CaptureListRow
              capture={capture}
              locale={locale}
              t={t}
              targetGroupName={targetGroupName}
              // A pre-aimed capture skips the picker — the chip said where it is
              // going, so tapping should not ask again; a loose one opens it.
              onAssign={
                targetGroup ? () => assignTo(capture, targetGroup) : () => openAssign(capture)
              }
              onMore={() => openCaptureMenu(capture)}
            />
          );
        }
      }
    },
    [
      assignTo,
      assignableGroups,
      locale,
      openAssign,
      openBatchIds,
      openBatchMenu,
      openCaptureMenu,
      profile?.id,
      summary,
      t,
      theme.spacing.md,
      theme.spacing.xs,
      toggleBatch,
    ],
  );

  const renderGroupPickerItem = useCallback(
    ({ item: group }: { item: GroupRow }) => {
      const label = groupLabel(group, summary.membersFor(group.id), profile?.id);
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => {
            // The Modal stays mounted through its fade-out, so this can fire a
            // frame after the backdrop cleared `assigning`.
            if (assigning) assignTo(assigning, group);
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingVertical: theme.spacing.md,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          {/* The group's own avatar and colour carry its identity — the flat-row
              look the dashboard's GroupCard uses. */}
          <Avatar
            name={label}
            emoji={group.cover_emoji ?? undefined}
            size={44}
            tint={tintForKey(group.id)}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="subheading" numberOfLines={1}>
              {label}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {plural(locale, summary.memberCountFor(group.id), t.memberCount)}
            </Text>
          </View>
          <Ionicons
            name={directionalIcon('chevron-forward')}
            size={iconSize.md}
            color={theme.color.textFaint}
          />
        </Pressable>
      );
    },
    [
      assignTo,
      assigning,
      locale,
      profile?.id,
      summary,
      t.memberCount,
      theme.color.textFaint,
      theme.spacing.md,
    ],
  );

  return (
    <Screen edges={['top', 'bottom']}>
      {/* The plain back-plus-centred-title bar every pushed screen wears
          (Friends person, Merge, …), so Drafts reads as one of the family
          rather than its own thing: a back chevron on the left, the title
          optically centred, and a 44pt spacer on the right to balance the back
          button. No leading glyph and no trailing add — starting a capture
          lives on the dashboard, not here. */}
      <Row
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          alignItems: 'center',
        }}
      >
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading" numberOfLines={1}>
            {t.captures.title}
          </Text>
          {/* How many are waiting, right under the title — so the screen answers
              "what is this and how much is here?" before a person reads a row.
              Hidden at zero, where the empty state already says it. */}
          {waitingCount > 0 ? (
            <Text variant="micro" tone="muted" numberOfLines={1}>
              {plural(locale, waitingCount, t.captures.unassignedBody)}
            </Text>
          ) : null}
        </View>
        <View style={{ width: 44 }} />
      </Row>

      {/* One virtualized scroll region for every state, the way `ActivityScreen`
          does it — pull-to-refresh still works while loading or empty, but a
          large draft inbox only mounts the rows near the viewport. */}
      <FlashList
        data={captures.isLoading || rows.length === 0 ? [] : feedItems}
        keyExtractor={keyCaptureItem}
        renderItem={renderCaptureItem}
        getItemType={(item) => item.kind}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
        }}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.color.brand}
          />
        }
        ListEmptyComponent={
          captures.isLoading ? (
            <InboxSkeleton />
          ) : (
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <EmptyState
                title={t.captures.emptyTitle}
                body={t.captures.emptyBody}
                action={
                  <Button label={t.captures.captureCta} onPress={() => router.push('/capture')} />
                }
              />
            </View>
          )
        }
      />

      {/* The group picker, as a sheet over the list rather than a screen away —
          assigning is one tap and one choice, and a whole route for it would be
          a scroll and a back button around a short list.

          A real Modal, not an absolute overlay: the one bottom bar (`AppTabBar`)
          is rendered at the root over the whole stack, so an in-tree overlay
          paints *under* it and the sheet's lower rows hide behind the nav bar.
          A Modal floats above everything, the way the other sheets do. */}
      <Sheet
        visible={assigning !== null}
        onClose={closeAssign}
        padded={false}
        closeLabel={t.common.close}
        style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.md, maxHeight: '80%' }}
      >
        <Text variant="heading">{t.captures.assignTitle}</Text>

        {/* What is being placed, so the sheet stands on its own over the
                list it hides: the amount and its note beside the capture's own
                glyph. */}
        {assigning ? (
          <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <CategoryBadge
              category={assigning.category}
              meta={assigning.category_meta}
              description={assigning.description}
              size={38}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <MoneyText
                amount={BigInt(assigning.amount)}
                currency={assigning.currency}
                locale={locale}
                variant="subheading"
              />
              {assigning.description ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {assigning.description}
                </Text>
              ) : null}
            </View>
          </Row>
        ) : null}

        <Text variant="caption" tone="muted">
          {t.captures.assignBody}
        </Text>

        {/* Search only earns its place on a long list (see `showSearch`);
                a rounded field with a leading glyph, the picker grammar Mobbin
                shows across Starling/Swarm/Canva. */}
        {showSearch ? (
          <Row
            style={{
              gap: theme.spacing.sm,
              alignItems: 'center',
              backgroundColor: theme.color.surfaceMuted,
              borderRadius: theme.radius.md,
              paddingHorizontal: theme.spacing.md,
            }}
          >
            <Ionicons name="search" size={iconSize.md} color={theme.color.textFaint} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t.captures.assignSearch}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.captures.assignSearch}
              autoCorrect={false}
              style={{
                flex: 1,
                fontSize: 16,
                color: theme.color.text,
                paddingVertical: theme.spacing.md,
              }}
            />
          </Row>
        ) : null}

        <View style={{ height: pickerListHeight }}>
          <FlashList
            data={assignableGroups.length === 0 ? [] : visibleGroups}
            keyExtractor={(group) => group.id}
            renderItem={renderGroupPickerItem}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <>
                {/* Start a group and drop this into it — so a capture with no
                        fitting group is no longer a dead end (it used to only say
                        "make one first"). Mirrors the "Create group" affordance the
                        Wise/Starling pickers lead with. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.captures.assignNew}
                  onPress={() => {
                    // Carry the capture through group creation so new-group
                    // can hand it back and finish the assignment — read the id
                    // before closeAssign clears `assigning`.
                    const captureId = assigning?.id;
                    closeAssign();
                    router.push(
                      captureId
                        ? { pathname: '/new-group', params: { assignCaptureId: captureId } }
                        : '/new-group',
                    );
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingVertical: theme.spacing.md,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.color.surfaceMuted,
                      borderWidth: 1,
                      borderColor: theme.color.border,
                      borderStyle: 'dashed',
                    }}
                  >
                    <Ionicons name="add" size={iconSize.lg} color={theme.color.brand} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="subheading" numberOfLines={1}>
                      {t.captures.assignNew}
                    </Text>
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {t.captures.assignNewBody}
                    </Text>
                  </View>
                </Pressable>

                <View style={{ height: 1, backgroundColor: theme.color.border }} />
              </>
            }
            ListEmptyComponent={
              <Text variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.lg }}>
                {assignableGroups.length === 0 ? t.captures.noGroups : t.captures.assignNoMatch}
              </Text>
            }
          />
        </View>
      </Sheet>

      {/* The row's ⋯ overflow, as a small sheet: the actions that are not "add to
          group" (the card's own tap) plus a labelled way to reach it, so the one
          thing a person does with a capture is spelled out and delete no longer
          rides on every row. A real Modal for the same reason the assign sheet is
          one — an in-tree overlay would paint under the root tab bar. */}
      <Sheet
        visible={menu !== null}
        onClose={closeMenu}
        padded={false}
        closeLabel={t.common.close}
        style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.xs }}
      >
        {menu?.kind === 'capture' ? (
          <>
            <Text variant="heading" numberOfLines={1} style={{ marginBottom: theme.spacing.xs }}>
              {menu.capture.description?.trim() ||
                (menu.capture.category
                  ? (t.categories as Record<string, string>)[menu.capture.category]
                  : undefined) ||
                t.captures.unassigned}
            </Text>
            <ActionSheetRow
              icon="people-outline"
              label={t.captures.assign}
              tone="brand"
              onPress={() => {
                const capture = menu.capture;
                setMenu(null);
                openAssign(capture);
              }}
            />
            <Divider />
            <ActionSheetRow
              icon="create-outline"
              label={t.captures.edit}
              onPress={() => {
                const capture = menu.capture;
                setMenu(null);
                openEdit(capture);
              }}
            />
            <Divider />
            <ActionSheetRow
              icon="trash-outline"
              label={t.captures.delete}
              tone="negative"
              onPress={() => {
                const capture = menu.capture;
                setMenu(null);
                confirmDelete(capture);
              }}
            />
          </>
        ) : menu?.kind === 'batch' ? (
          <>
            <Text variant="heading" numberOfLines={1} style={{ marginBottom: theme.spacing.xs }}>
              {plural(locale, menu.items.length, t.captures.batchExpenses)}
            </Text>
            <ActionSheetRow
              icon="trash-outline"
              label={t.captures.deleteBatch}
              tone="negative"
              onPress={() => {
                const items = menu.items;
                setMenu(null);
                confirmDeleteBatch(items);
              }}
            />
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}
