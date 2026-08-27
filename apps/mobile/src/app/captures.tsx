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
  Modal,
  Pressable,
  RefreshControl,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { buildCaptureFeedItems, type CaptureFeedItem } from '@/lib/captureFeed';
import { usePullRefresh } from '@/lib/pullRefresh';

/**
 * One capture, in the card grammar this screen now speaks (Mobbin: Phantom
 * Recent Activity, Apple Wallet Daily Cash): a leading category glyph — always
 * the category colour, never the bill's thumbnail — the note over a muted place
 * line, and the amount at the trailing edge, all on a soft rounded card.
 *
 * The whole card taps to assign, the one thing you do with a capture. Edit and
 * delete are the quiet trailing controls, each with its own hitbox so the card's
 * tap still assigns. Inside a batch a row is `bare` — no card of its own, since
 * the batch card already frames it — and drops the place (the batch is one
 * outing, one location).
 */
function CaptureListRow({
  capture,
  locale,
  t,
  onAssign,
  onEdit,
  onDelete,
  hideLocation = false,
  bare = false,
}: {
  capture: CaptureRow;
  locale: string;
  t: UiStrings;
  onAssign: () => void;
  onEdit: () => void;
  onDelete: () => void;
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

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="subheading" numberOfLines={1}>
            {title}
          </Text>
          {/* The day is already the section heading, so a per-row date only
              repeats it. The second line earns its place instead: where the spend
              happened, or a note if there is one — and nothing at all when there
              is neither. The unsynced cloud rides here when the row is queued. */}
          {subtitle || capture.pending ? (
            <Row style={{ gap: theme.spacing.xs, alignItems: 'center', marginTop: 2 }}>
              {locationName ? (
                <Ionicons name="location-outline" size={13} color={theme.color.textMuted} />
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

        <MoneyText
          amount={BigInt(capture.amount)}
          currency={capture.currency}
          locale={locale}
          variant="subheading"
        />
        {/* The two row actions kept together as their own group with a tight
            gap, set off from the amount by the parent Row's spacing — so they
            read as a pair of buttons, not two glyphs crowding the number. Edit
            is a neutral muted mark; delete is red before it is tapped (the
            WhatsApp/Vipps convention), so "bin it" never hides among the greys.
            The whole row still taps to assign; both icons keep their own hitbox. */}
        <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
          <IconButton label={t.captures.edit} onPress={onEdit}>
            <Ionicons name="create-outline" size={iconSize.md} color={theme.color.textMuted} />
          </IconButton>
          <IconButton label={t.captures.delete} onPress={onDelete}>
            <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
          </IconButton>
        </Row>
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
  onEdit,
  onDelete,
  onDeleteBatch,
}: {
  items: CaptureRow[];
  locale: string;
  t: UiStrings;
  open: boolean;
  onToggle: () => void;
  onAssign: (capture: CaptureRow) => void;
  onEdit: (capture: CaptureRow) => void;
  onDelete: (capture: CaptureRow) => void;
  onDeleteBatch: () => void;
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
                here. Only the unsynced mark rides the second line. */}
            <Text variant="subheading" numberOfLines={1}>
              {plural(locale, items.length, t.captures.batchExpenses)}
            </Text>
            {anyPending ? (
              <Row style={{ gap: theme.spacing.xs, alignItems: 'center', marginTop: 2 }}>
                <PendingMark />
              </Row>
            ) : null}
          </View>

          {/* Total then the expander, both trailing — the chevron is the standard
              reveal affordance (down closed, up open), sitting just past the
              amount rather than a plus crammed at the edge. */}
          {total !== null ? (
            <MoneyText amount={total} currency={currency} locale={locale} variant="subheading" />
          ) : (
            <Text variant="subheading" tone="muted">
              {plural(locale, items.length, t.captures.batchExpenses)}
            </Text>
          )}
          {/* Delete the whole batch — the trailing control the standalone rows
              carry, here removing every expense in the group at once. A nested
              press, so it deletes rather than toggling the card. */}
          <IconButton label={t.captures.deleteBatch} onPress={onDeleteBatch}>
            <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
          </IconButton>
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={iconSize.md}
            color={theme.color.textMuted}
          />
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
                onEdit={() => onEdit(capture)}
                onDelete={() => onDelete(capture)}
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

/** Capture inbox route backed by FlashList rows and screen-owned batch expansion state. */
export default function CapturesScreen() {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const clearance = useTabBarClearance();
  const insets = useSafeAreaInsets();
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
  // amount travels as the same minor-unit string the row stores.
  const assignTo = useCallback(
    (capture: CaptureRow, group: GroupRow): void => {
      closeAssign();
      router.push({
        pathname: '/group/[id]/add-expense',
        params: {
          id: group.id,
          captureId: capture.id,
          amount: capture.amount,
          description: capture.description,
          category: capture.category ?? '',
          // A custom tag rides along as JSON so the assigned expense keeps it,
          // rather than dropping to a built-in (extends TDR §8).
          ...(capture.category_meta ? { categoryMeta: JSON.stringify(capture.category_meta) } : {}),
          // The place the capture recorded, so the assigned expense keeps it (A43).
          ...(capture.location ? { location: JSON.stringify(capture.location) } : {}),
          expenseDate: capture.expense_date,
        },
      });
    },
    [closeAssign],
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
              onEdit={openEdit}
              onDelete={confirmDelete}
              onDeleteBatch={() => confirmDeleteBatch(item.items)}
            />
          );
        case 'single':
          return (
            <CaptureListRow
              capture={item.capture}
              locale={locale}
              t={t}
              onAssign={() => openAssign(item.capture)}
              onEdit={() => openEdit(item.capture)}
              onDelete={() => confirmDelete(item.capture)}
            />
          );
      }
    },
    [
      confirmDelete,
      confirmDeleteBatch,
      locale,
      openAssign,
      openBatchIds,
      openEdit,
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
      <Modal
        transparent
        visible={assigning !== null}
        animationType="fade"
        onRequestClose={closeAssign}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.common.close}
          onPress={closeAssign}
          style={{
            flex: 1,
            backgroundColor: 'rgba(10, 10, 26, 0.55)',
            justifyContent: 'flex-end',
          }}
        >
          <Pressable
            // Swallow taps on the sheet itself; only the backdrop dismisses.
            onPress={() => {}}
            accessibilityViewIsModal
            style={{
              backgroundColor: theme.color.surface,
              borderTopLeftRadius: theme.radius.xxl,
              borderTopRightRadius: theme.radius.xxl,
              paddingHorizontal: theme.spacing.xl,
              paddingTop: theme.spacing.md,
              // Clear the Android gesture/nav bar so the last group row is not
              // hidden behind it.
              paddingBottom: theme.spacing.md + insets.bottom,
              gap: theme.spacing.md,
              maxHeight: '80%',
              ...theme.shadow.lifted,
            }}
          >
            {/* The grab handle — the visual grammar of a sheet you can pull down,
                the same one every other sheet in the app wears. */}
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.color.border,
                marginBottom: theme.spacing.xs,
              }}
            />

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
                        closeAssign();
                        router.push('/new-group');
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
                  <Text
                    variant="caption"
                    tone="muted"
                    style={{ paddingVertical: theme.spacing.lg }}
                  >
                    {assignableGroups.length === 0 ? t.captures.noGroups : t.captures.assignNoMatch}
                  </Text>
                }
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}
