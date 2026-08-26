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

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Alert, Modal, Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
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
import { capturePhotoUrl } from '@/data/api';
import { useSignedUrl } from '@/lib/useSignedUrl';
import { dayHeading, groupByDay } from '@/data/activity';
import { useCaptures, useDeleteCapture, useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel, type CaptureRow, type GroupRow } from '@/data/types';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { voiceBatchId } from '@/lib/captureBatch';
import { usePullRefresh } from '@/lib/pullRefresh';

/** A signed URL for a capture's receipt, re-resolved on change and kept fresh
 *  past the signed-URL expiry (see `useSignedUrl`). */
function CaptureThumb({ path, size }: { path: string; size: number }) {
  const theme = useTheme();
  const url = useSignedUrl(path, capturePhotoUrl);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.sm,
        overflow: 'hidden',
        backgroundColor: theme.color.surfaceMuted,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url ? (
        <Image source={{ uri: url }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
      ) : (
        <Ionicons name="receipt-outline" size={size * 0.4} color={theme.color.textFaint} />
      )}
    </View>
  );
}

/**
 * One capture as a flat list row, the WhatsApp/GroupCard grammar the rest of the
 * app speaks: a leading identity glyph (the bill's own thumbnail, or its category
 * colour), the note over a muted date line, and the amount at the trailing edge.
 *
 * The whole row taps to assign — the one thing you do with a capture — so the
 * screen sheds the full-width button it used to stack under every card. Delete
 * is the quiet trailing control, kept out of the tap target by its own hitbox.
 */
function CaptureListRow({
  capture,
  locale,
  t,
  onAssign,
  hideLocation = false,
}: {
  capture: CaptureRow;
  locale: string;
  t: UiStrings;
  onAssign: () => void;
  /** Inside a batch the description IS the line that matters, so the place is
   *  suppressed there — the batch stands for one outing, one location. */
  hideLocation?: boolean;
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
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Row
        style={{ gap: theme.spacing.md, alignItems: 'center', paddingVertical: theme.spacing.md }}
      >
        {capture.photo_path ? (
          <CaptureThumb path={capture.photo_path} size={46} />
        ) : (
          <CategoryBadge category={capture.category} meta={capture.category_meta} size={46} />
        )}

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

        {/* A clean row: identity, what it was, the amount — and nothing else.
            The row taps to open the draft's sheet, where assign / edit / delete
            live, the same one-level-deeper grammar the group expense list uses
            (a row is a target, its actions sit on the screen it opens). A
            trailing chevron marks it as tappable-through. */}
        <MoneyText
          amount={BigInt(capture.amount)}
          currency={capture.currency}
          locale={locale}
          variant="subheading"
        />
        <Ionicons
          name={directionalIcon('chevron-forward')}
          size={iconSize.sm}
          color={theme.color.textFaint}
        />
      </Row>
    </Pressable>
  );
}

/** A day's captures, with same-batch ones folded together in first-seen order. */
type InboxItem =
  { kind: 'single'; capture: CaptureRow } | { kind: 'batch'; id: string; items: CaptureRow[] };

function foldBatches(entries: readonly CaptureRow[]): InboxItem[] {
  const out: InboxItem[] = [];
  const at = new Map<string, number>();
  for (const capture of entries) {
    const id = voiceBatchId(capture);
    if (!id) {
      out.push({ kind: 'single', capture });
      continue;
    }
    const index = at.get(id);
    if (index === undefined) {
      at.set(id, out.length);
      out.push({ kind: 'batch', id, items: [capture] });
    } else {
      (out[index] as { items: CaptureRow[] }).items.push(capture);
    }
  }
  // A batch reduced to one row (the rest deleted, or a day boundary split it) is
  // no longer a batch — show it as the plain capture it now is.
  return out.map((item) =>
    item.kind === 'batch' && item.items.length === 1
      ? { kind: 'single', capture: item.items[0]! }
      : item,
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
  onAssign,
  onDeleteBatch,
}: {
  items: CaptureRow[];
  locale: string;
  t: UiStrings;
  onAssign: (capture: CaptureRow) => void;
  onDeleteBatch: () => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

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
        onPress={() => setOpen((value) => !value)}
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
          {/* Only the expander at the trailing edge — deleting the whole batch
              is a labelled action inside the opened card, not an icon crowding
              the header (the same clean-header rule the rest of the screen now
              follows). */}
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
          {items.map((capture) => (
            <View key={capture.id}>
              <Divider />
              <CaptureListRow
                capture={capture}
                locale={locale}
                t={t}
                onAssign={() => onAssign(capture)}
                hideLocation
              />
            </View>
          ))}
          {/* Delete the whole batch — a labelled, red text action at the foot of
              the opened card rather than an icon in the header. Reads as the
              deliberate "remove all of these" it is. */}
          <Divider />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.captures.deleteBatch}
            onPress={onDeleteBatch}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
              paddingVertical: theme.spacing.md,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
            <Text variant="body" tone="negative">
              {t.captures.deleteBatch}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default function CapturesScreen() {
  const theme = useTheme();
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

  const rows = captures.data ?? [];

  const openAssign = (capture: CaptureRow): void => {
    setQuery('');
    setAssigning(capture);
  };

  // Open the draft in the capture form to fix its fields — the same screen that
  // drafted it, now in edit mode. Every value the row carries rides along as a
  // param so the form opens filled in and saving updates the row in place rather
  // than making a second one; `parsed` (which holds the voice-batch id) is
  // preserved so an edited batch item stays part of its batch.
  const openEdit = (capture: CaptureRow): void => {
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
  };

  // Shared by the standalone rows and the rows inside a batch, so a capture is
  // deleted the same way wherever it is shown.
  const confirmDelete = (capture: CaptureRow): void => {
    Alert.alert(t.captures.delete, t.captures.deleteConfirm, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.captures.delete,
        style: 'destructive',
        onPress: () => void deleteCapture.mutateAsync(capture.id),
      },
    ]);
  };

  // Delete every capture in a spoken batch at once, behind one confirm — the
  // trailing trash on the batch card.
  const confirmDeleteBatch = (items: CaptureRow[]): void => {
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
  };

  const closeAssign = (): void => {
    setAssigning(null);
    setQuery('');
  };

  // Hand the capture's own values to the add-expense form as prefill, and carry
  // its id so that saving there can close the capture (useAssignCapture). The
  // amount travels as the same minor-unit string the row stores.
  const assignTo = (capture: CaptureRow, group: GroupRow): void => {
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
  };

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

      {/* One scroll region for every state, the way `ActivityScreen` does it —
          so pull-to-refresh still works while the mirror is loading or the
          inbox is genuinely empty, not only once cards are on screen. */}
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
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
        {captures.isLoading ? (
          <InboxSkeleton />
        ) : rows.length === 0 ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
              title={t.captures.emptyTitle}
              body={t.captures.emptyBody}
              action={
                <Button label={t.captures.captureCta} onPress={() => router.push('/capture')} />
              }
            />
          </View>
        ) : (
          // Day-grouped, same as the activity feed: an uppercase heading per
          // calendar day, then that day's captures as flat tappable rows — the
          // WhatsApp/GroupCard grammar the rest of the app uses, not the chunky
          // action-cards this screen used to stack. The whole row taps to assign
          // (the primary act on a capture); delete sits as a quiet trailing
          // control, the way the app carries secondary row actions.
          <View style={{ gap: theme.spacing.lg }}>
            {groupByDay(rows).map((section) => (
              <View key={section.key}>
                <Text
                  variant="micro"
                  tone="muted"
                  style={{ textTransform: 'uppercase', marginBottom: theme.spacing.xs }}
                >
                  {dayHeading(locale, section.entries[0]!.created_at)}
                </Text>
                {foldBatches(section.entries).map((item) =>
                  item.kind === 'batch' ? (
                    <BatchGroupCard
                      key={`batch-${item.id}`}
                      items={item.items}
                      locale={locale}
                      t={t}
                      onAssign={openAssign}
                      onDeleteBatch={() => confirmDeleteBatch(item.items)}
                    />
                  ) : (
                    <CaptureListRow
                      key={item.capture.id}
                      capture={item.capture}
                      locale={locale}
                      t={t}
                      onAssign={() => openAssign(item.capture)}
                    />
                  ),
                )}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

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

            {/* The draft's own actions, one level deeper than the list — the
                place edit and delete live now that the rows are clean. Edit is a
                neutral outline pill; delete is red. Both close the sheet first so
                nothing acts on a row that is about to change or vanish. */}
            {assigning ? (
              <Row style={{ gap: theme.spacing.sm }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.captures.edit}
                  onPress={() => {
                    const target = assigning;
                    closeAssign();
                    openEdit(target);
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: theme.spacing.xs,
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: theme.color.border,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Ionicons
                    name="create-outline"
                    size={iconSize.md}
                    color={theme.color.textMuted}
                  />
                  <Text variant="body">{t.captures.edit}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.captures.delete}
                  onPress={() => {
                    const target = assigning;
                    closeAssign();
                    confirmDelete(target);
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: theme.spacing.xs,
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: theme.color.border,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
                  <Text variant="body" tone="negative">
                    {t.captures.delete}
                  </Text>
                </Pressable>
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

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={{ flexShrink: 1 }}
            >
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

              {assignableGroups.length === 0 ? (
                <Text variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.lg }}>
                  {t.captures.noGroups}
                </Text>
              ) : visibleGroups.length === 0 ? (
                <Text variant="caption" tone="muted" style={{ paddingVertical: theme.spacing.lg }}>
                  {t.captures.assignNoMatch}
                </Text>
              ) : (
                visibleGroups.map((group) => {
                  const label = groupLabel(group, summary.membersFor(group.id), profile?.id);
                  return (
                    <Pressable
                      key={group.id}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      onPress={() => {
                        // The Modal stays mounted through its fade-out, so this
                        // can fire a frame after the backdrop cleared `assigning`.
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
                      {/* The group's own avatar and colour carry its identity —
                          the flat-row look the dashboard's GroupCard uses. */}
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
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}
