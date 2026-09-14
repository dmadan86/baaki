/**
 * Review: what the app already found, never a field to fill.
 *
 * This is the bar's "Review" tab and the one true drafts hub (A34,
 * `docs/plan-drafts-and-rules.md`) — every spend caught before it had a group,
 * whatever brought it in: typed, spoken, photographed, or read out of the
 * phone's own bank messages. It used to open on a list under day headings with
 * a chat glyph in the corner leading to a paste box. On a phone that has
 * already granted permission to read those messages, sending somebody to
 * Messages to select, copy, come back and paste is the app refusing to do its
 * job — so the paste box is no longer the shape of this screen. It is the
 * fallback it always was, reachable through a quiet "Add another way", and the
 * primary path only where there is no other: iPhone, where no reading API
 * exists at any tier.
 *
 * FOUR THINGS CHANGED, AND EACH ANSWERS A COMPLAINT.
 *
 * 1. **A status, not an instruction.** The top of the screen used to explain
 *    what to do. An instruction is what you show somebody you are about to make
 *    work; when the app is doing the work, the honest object is a *state*. So:
 *    a dot and "Watching your bank messages · 2 min ago", read in two seconds,
 *    tappable to look again. It is shown only while something really is
 *    watching (`useSmsAutoRead`), because a line claiming to watch when nothing
 *    does would be worse than no line at all. Where nothing watches — every
 *    iPhone, and any Android build without the reader — the line is the count
 *    of what is waiting, exactly as before.
 *
 * 2. **Two sections, not two tabs.** One list cut into **Ready** and **Worth a
 *    look** — a split by what the app is *sure of*, which is the only
 *    distinction a person feels. `lib/reviewFeed.ts` carries the rule and the
 *    reasoning. Sections need no navigation, carry their own counts, and
 *    disappear when empty, so a screen with one section looks like a screen
 *    with one section rather than a tab bar with a dead half.
 *
 * 3. **One gesture, not one screen.** Most rows should need a single swipe.
 *    Toward the leading edge files the draft where that shop's money went last
 *    time — and the row's chip already *says* where that is, so the gesture
 *    confirms something visible rather than doing something hidden. The other
 *    way means **not an expense**: a credit-card bill, a transfer to yourself,
 *    rent nobody splits. That second one is what earns the feature its keep; an
 *    inbox you can only add from fills with noise and gets abandoned. Tapping
 *    still opens the full editor, and both gestures are also plain rows in the
 *    ⋯ sheet — a swipe is never the only way through (`components/SwipeRow`).
 *
 * 4. **The zero state is the point.** Review is trying to reach zero: it is the
 *    app's list of questions, and a good week is one where it has none. So the
 *    empty screen says "Nothing needs you" and then says how much went through
 *    anyway (`data/reviewSources.ts`), rather than apologising for being empty.
 *
 * WHAT DID NOT CHANGE. Expenses spoken in one breath still fold into one
 * collapsible card whose ⋯ can place the whole cluster at once — a batch is one
 * outing and gets one answer, which is why it keeps the sheet rather than a
 * swipe of its own. Everything is still personal and offline-first: a row still
 * queued wears a faint cloud glyph rather than hiding until the server has seen
 * it (ADR-005), and the destination chip is derived from the local ledger
 * mirror, so it is right with no network. A draft made from a message the app
 * *read* still carries no message body at all; that rule lives in
 * `lib/smsDrafts.ts` and this screen never goes near a body.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import { randomUUID } from 'expo-crypto';
import { Pressable, RefreshControl, ScrollView, useWindowDimensions, View } from 'react-native';

import { MutationKind, peopleSignatureKey } from '@waves/core';
import {
  Badge,
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
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { CategoryBadge } from '@/components/Category';
import {
  DestinationPicker,
  type DestinationSelection,
  type PersonChoice,
} from '@/components/DestinationPicker';
import { PendingMark } from '@/components/PendingMark';
import { InboxSkeleton } from '@/components/Skeletons';
import { SwipeRow, type SwipeAction } from '@/components/SwipeRow';
import { WatchingLine } from '@/components/WatchingLine';
import { dayHeading } from '@/data/activity';
import { useFiledThisWeek, useMerchantDestinations } from '@/data/reviewSources';
import {
  useAddGhostMember,
  useAssignCapture,
  useCaptures,
  useCreateGroup,
  useDeleteCapture,
  useGroupPeopleSignatures,
  useGroups,
  useHomeSummary,
  useOneToOneGroupIds,
  usePeopleBalances,
} from '@/data/hooks';
import { groupLabel, GroupType, isViewer, type CaptureRow } from '@/data/types';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { assignCaptureHref } from '@/lib/captureAssign';
import { planCaptureAssign, stillWaiting, type AssignMember } from '@/lib/captureBulkAssign';
import { friendlyError } from '@/lib/errors';
import { useGuestGuard } from '@/lib/guestGuard';
import { destinationFor, type RowDestination } from '@/lib/merchantDestination';
import { router } from '@/lib/navigation';
import { usePullRefresh } from '@/lib/pullRefresh';
import {
  buildReviewFeed,
  doubtsAbout,
  reviewItemKey,
  type ReviewFeedItem,
  type ReviewSectionId,
} from '@/lib/reviewFeed';
import { useSmsAutoRead } from '@/lib/smsAutoRead';
import { useSmsInboxReader } from '@/lib/smsFeature';
import { useSmsMessages } from '@/lib/smsMessages';
import { totalWaiting } from '@/lib/smsInbox';
import { useDialog } from '@/lib/dialog';
import { useToast } from '@/lib/toast';
import { usePlaceInPersonal } from '@/lib/usePlaceInPersonal';
import { useSync } from '@/sync';

/**
 * What the ⋯ overflow sheet is open on: a single capture (file it, add to group,
 * edit, take it off the list) or a whole spoken batch (add them all to one
 * group / delete them all). Null when nothing is open.
 */
type CaptureMenu =
  { kind: 'capture'; capture: CaptureRow } | { kind: 'batch'; items: CaptureRow[] } | null;

/**
 * What the destination sheet is placing: one draft, or a whole spoken batch at
 * once. One picker serves both, so "where does this go?" is the same control and
 * the same list of groups however many drafts are riding on the answer.
 *
 * The two differ only in what happens after the tap. A single draft opens the
 * add-expense form prefilled — the unchanged path, where a person says who split
 * what. A batch is written straight onto the queue with the form's own defaults,
 * which is the whole point of asking once for several.
 */
type AssignTarget =
  { kind: 'capture'; capture: CaptureRow } | { kind: 'batch'; items: CaptureRow[] };

/** How often the "· 2 min ago" on the status line is allowed to go stale. */
const CLOCK_TICK = 60_000;

/**
 * Did the app make this draft, or did a person?
 *
 * It decides how gently the draft is taken off the list. Something the app
 * found in a bank message costs nothing to dismiss — the message is still in
 * the phone's Messages app, and nobody typed a word of the draft — so "not an
 * expense" fires outright. Something a person captured themselves carries their
 * own words and possibly a photograph of the bill, so it keeps the confirm it
 * has always had.
 */
function wasFound(capture: CaptureRow): boolean {
  const parsed = capture.parsed;
  return (
    !!parsed && typeof parsed === 'object' && (parsed as { source?: unknown }).source === 'sms'
  );
}

/**
 * A pile's heading: what it is, and how many are in it.
 *
 * The count rides in a pill beside the words rather than in them, so the two
 * headings line up whatever the language does to their length. "Worth a look"
 * wears the warning hue; the words are the difference, the colour only agrees
 * with them.
 */
function SectionHeading({
  section,
  count,
  locale,
  t,
}: {
  section: ReviewSectionId;
  count: number;
  locale: string;
  t: UiStrings;
}): React.JSX.Element {
  const theme = useTheme();
  const warn = section === 'look';
  const label = warn ? t.captures.sectionLook : t.captures.sectionReady;
  const spoken = plural(locale, count, warn ? t.captures.lookCount : t.captures.readyCount);
  return (
    <Row
      accessibilityRole="header"
      accessibilityLabel={spoken}
      style={{
        gap: theme.spacing.sm,
        alignItems: 'center',
        marginTop: theme.spacing.lg,
        marginBottom: theme.spacing.xs,
      }}
    >
      <Text
        variant="micro"
        style={{
          textTransform: 'uppercase',
          color: warn ? theme.color.warning : theme.color.textMuted,
        }}
      >
        {label}
      </Text>
      <View
        style={{
          minWidth: 20,
          paddingHorizontal: 6,
          paddingVertical: 1,
          borderRadius: theme.radius.pill,
          alignItems: 'center',
          backgroundColor: warn ? theme.color.warningSoft : theme.color.surfaceMuted,
        }}
      >
        <Text variant="micro" style={{ color: warn ? theme.color.warning : theme.color.textMuted }}>
          {String(count)}
        </Text>
      </View>
    </Row>
  );
}

/**
 * Where this row is about to go, said before the gesture that confirms it.
 *
 * Two shapes, and they are different in glyph, in wording and in hue — never in
 * colour alone (#191). A known destination is a brand chip wearing the group's
 * name and a forward arrow (mirrored in RTL, because an arrow is content). No
 * known destination is an amber chip that asks "Which group?", which is the
 * honest version of a chip that would otherwise have to guess.
 */
function DestinationChip({ name, t }: { name: string | null; t: UiStrings }): React.JSX.Element {
  const theme = useTheme();
  const known = name !== null;
  return (
    <Row
      style={{
        gap: 3,
        alignItems: 'center',
        alignSelf: 'flex-start',
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: 2,
        borderRadius: theme.radius.pill,
        backgroundColor: known ? theme.color.brandSoft : theme.color.warningSoft,
        maxWidth: '100%',
      }}
    >
      <Ionicons
        name={known ? directionalIcon('arrow-forward') : 'help-circle-outline'}
        size={iconSize.xs}
        color={known ? theme.color.brand : theme.color.warning}
      />
      <Text
        variant="micro"
        numberOfLines={1}
        style={{ color: known ? theme.color.brand : theme.color.warning, flexShrink: 1 }}
      >
        {known ? name : t.captures.whichGroup}
      </Text>
    </Row>
  );
}

/**
 * One draft, in the card grammar this screen speaks (Mobbin: Phantom Recent
 * Activity, Apple Wallet Daily Cash): a leading category glyph — always the
 * category colour, never the bill's thumbnail — the merchant over the
 * destination chip, and the amount at the trailing edge, all on a soft rounded
 * card.
 *
 * The whole card taps to assign; the ⋯ at the trailing edge opens everything
 * else. What the row gained is the second line: where it is about to go. That
 * line used to carry the place the spend happened, which was true and rarely
 * useful; the destination is the question this screen exists to ask, and
 * showing it is what lets a swipe answer it without opening anything.
 *
 * A row the app was unsure of says *what* it was unsure of, in a sentence, with
 * a warning glyph beside it — "check this" with nothing to check against is not
 * a warning, it is a worry.
 *
 * Inside a batch a row is `bare` — no card of its own, since the batch card
 * already frames it — and carries no chip: a batch is one outing with one
 * destination, answered once on the batch's own ⋯.
 */
function CaptureListRow({
  capture,
  locale,
  t,
  destinationName,
  onAssign,
  onMore,
  onFile,
  onDismiss,
  bare = false,
}: {
  capture: CaptureRow;
  locale: string;
  t: UiStrings;
  /** The group this row would be filed into, or null when nothing is known. */
  destinationName: string | null;
  onAssign: () => void;
  /** Open the row's overflow sheet (file, add to group, edit, take it off). */
  onMore: () => void;
  /** File it where the chip says, without opening anything. Null when nowhere. */
  onFile: (() => void) | null;
  /** Take it off the list: it was never an expense. */
  onDismiss: () => void;
  /** A row nested in a batch card: no card frame of its own, and no chip. */
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
  const doubts = bare ? [] : doubtsAbout(capture);
  const dismissLabel = wasFound(capture) ? t.captures.notAnExpense : t.captures.delete;

  // Both swipe actions, offered to a screen reader as custom actions on the row
  // itself. A gesture is no good to somebody who does not make one, and a
  // control nested inside an accessible row can be unreachable — so the row
  // says what it can do, and the ⋯ sheet says it again in full.
  const actions = [
    ...(onFile && destinationName
      ? [{ name: 'file', label: t.captures.fileTo.replace('{name}', destinationName) }]
      : []),
    { name: 'dismiss', label: dismissLabel },
    { name: 'more', label: t.captures.moreActions },
  ];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        destinationName
          ? `${title}, ${t.captures.fileTo.replace('{name}', destinationName)}`
          : `${title}, ${t.captures.assign}`
      }
      accessibilityActions={actions}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === 'more') onMore();
        else if (name === 'dismiss') onDismiss();
        else if (name === 'file') onFile?.();
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
          {/* Line two is the answer this screen wants: where it goes. A row
              inside a batch keeps it clear — the batch is answered whole. */}
          {bare ? null : <DestinationChip name={destinationName} t={t} />}
          {/* An icon as well as the words, so the uncertainty is not carried by
              colour (#191) — and the words themselves, so "check this" names
              something a person can actually go and check. */}
          {doubts.map((doubt) => (
            <Row key={doubt} gap={theme.spacing.xs} style={{ alignItems: 'flex-start' }}>
              <Ionicons
                name="alert-circle-outline"
                size={iconSize.sm}
                color={theme.color.warning}
                style={{ marginTop: 2 }}
              />
              <Text variant="micro" tone="muted" style={{ flex: 1 }}>
                {doubt === 'date-inferred' ? t.smsImport.dateNotInMessage : t.smsImport.hardToRead}
              </Text>
            </Row>
          ))}
          {capture.pending ? (
            <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
              <PendingMark />
            </Row>
          ) : null}
        </View>

        {/* The amount and the ⋯ never shrink (RN's flexShrink is 0 by default),
            so every row's amount ends at the same point. */}
        <View style={{ alignItems: 'flex-end' }}>
          <MoneyText
            amount={BigInt(capture.amount)}
            currency={capture.currency}
            locale={locale}
            variant="subheading"
          />
        </View>
        {/* One quiet ⋯: everything that is not the card's own tap lives behind
            it. Its own hitbox for a sighted tap, but hidden from the a11y tree —
            a focusable nested in the accessible row can be unreachable, so
            screen readers reach it through the row's "more" action instead. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <IconButton label={t.captures.moreActions} onPress={onMore}>
            <Ionicons name="ellipsis-horizontal" size={iconSize.md} color={theme.color.textMuted} />
          </IconButton>
        </View>
      </Row>
    </Pressable>
  );
}

/**
 * Several expenses spoken in one breath, folded into one collapsible row: a
 * layered glyph, an "N expenses" title over a preview of what they were, and the
 * running total at the trailing edge with a chevron to open. Expanding reveals
 * each as a full capture row — still individually assignable and deletable — so
 * the total is the headline and the breakdown is one tap away.
 *
 * No swipe of its own, deliberately: a batch is one outing that wants one
 * destination, and that is exactly what its ⋯ already offers. A gesture that
 * filed four expenses at once on a flick would be a lot of money moved by an
 * accident of the thumb.
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
                here. Vertical chevrons carry no handedness, so nothing to mirror
                in RTL. */}
            <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
              <Text variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
                {plural(locale, items.length, t.captures.batchExpenses)}
              </Text>
              <Ionicons
                name={open ? 'chevron-up' : 'chevron-down'}
                size={iconSize.md}
                color={theme.color.textMuted}
              />
            </Row>
            <Row style={{ gap: theme.spacing.xs, alignItems: 'center', marginTop: 2 }}>
              <Text variant="micro" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {t.captures.batchHint}
              </Text>
              {anyPending ? <PendingMark /> : null}
            </Row>
          </View>

          <View style={{ alignItems: 'flex-end' }}>
            {total !== null ? (
              <MoneyText amount={total} currency={currency} locale={locale} variant="subheading" />
            ) : (
              <Text variant="subheading" tone="muted">
                {plural(locale, items.length, t.captures.batchExpenses)}
              </Text>
            )}
          </View>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <IconButton label={t.captures.moreActions} onPress={onMoreBatch}>
              <Ionicons
                name="ellipsis-horizontal"
                size={iconSize.md}
                color={theme.color.textMuted}
              />
            </IconButton>
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
                destinationName={null}
                onAssign={() => onAssign(capture)}
                onMore={() => onMore(capture)}
                onFile={null}
                onDismiss={() => onMore(capture)}
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

/** The Review tab: what was found, in two piles, one gesture each. */
export default function CapturesScreen() {
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const pull = usePullRefresh();
  const { session } = useAuth();

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
  const captures = useCaptures();
  const deleteCapture = useDeleteCapture();
  // Closing a draft against the expense it became. The single-draft form path
  // reaches this from inside add-expense; the swipe and batch paths call it here,
  // right after queueing each expense.
  const assignCapture = useAssignCapture();
  // The swipe and batch paths write the expenses themselves rather than opening a
  // form per draft, so they queue them the way the form does (ADR-005).
  const { mutate } = useSync();
  const toast = useToast();
  // "Just me" on the destination sheet: the shared path to the private ledger,
  // the same one the voice review files through.
  const placeInPersonal = usePlaceInPersonal();
  const { confirm, notify } = useDialog();
  // A guest past their trial may read but not write. The single-draft form path
  // is stopped by the same guard inside add-expense; a swipe or batch write never
  // reaches that screen, so it asks here.
  const guard = useGuestGuard();
  const groups = useGroups();
  const summary = useHomeSummary(viewerId);
  // The people the picker can point a draft at, and the raw material for
  // deciding whether a chosen set of them already share a group. All read from
  // the mirror, so the picker works with no network (ADR-005).
  const people = usePeopleBalances(viewerId);
  const oneToOne = useOneToOneGroupIds();
  const signatures = useGroupPeopleSignatures(viewerId);
  const createGroup = useCreateGroup();
  // Where each shop's money has been going — the whole basis of the chip and
  // therefore of the swipe. Local mirror only, so it is right offline.
  const merchants = useMerchantDestinations();
  // Is anything actually reading the inbox? The one thing that decides whether
  // this screen opens on a status or on an instruction, and whether pasting is
  // the main path or the other way.
  const auto = useSmsAutoRead();
  // Whether this build and this phone have a reader at all — the same gate the
  // Bank messages screen asks itself, so the door is never shown to a screen
  // that would render nothing.
  const smsReader = useSmsInboxReader();

  // One slow clock for the whole screen: the status line's "2 min ago" and the
  // empty state's "this week" both read it, and neither may call Date.now()
  // while rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!auto.enabled) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK);
    return () => clearInterval(timer);
  }, [auto.enabled]);
  const filedThisWeek = useFiledThisWeek(now);

  // What is being assigned, if anything — drives the destination sheet: one
  // draft, or a whole spoken batch.
  const [assigning, setAssigning] = useState<AssignTarget | null>(null);
  // The one draft under the picker, when it is a single one. The batch case has
  // no single capture to preview or pre-aim from.
  const assigningCapture = assigning?.kind === 'capture' ? assigning.capture : null;
  // Writing a draft into a group is several queue writes behind one gesture, and
  // a swipe is easy to repeat by accident. The lock is per target rather than a
  // single flag, so filing one row never swallows the swipe on the next.
  const placing = useRef<Set<string>>(new Set());
  // The id a group made from picked people will take, minted before the create
  // so the ghosts and the expense behind it can already name it — the
  // offline-first pattern the voice review and "add a person" both use.
  const [newGroupId, setNewGroupId] = useState(() => randomUUID());
  const [newMemberId, setNewMemberId] = useState(() => randomUUID());
  const addGhost = useAddGhostMember(newGroupId);
  // FlashList recycles row components, so batch expansion lives with the screen
  // and is keyed by batch id rather than inside the recycled row instance.
  const [openBatchIds, setOpenBatchIds] = useState<ReadonlySet<string>>(() => new Set());
  // The row's ⋯ overflow: which capture (or which spoken batch) has its actions
  // sheet open, if any. Null when nothing is open.
  const [menu, setMenu] = useState<CaptureMenu>(null);

  // Only groups the viewer still belongs to belong in the picker — or on a chip.
  // Leaving a group sets `left_at`; it does not remove the group row, so a left
  // (or owner-removed) group lingers in the local mirror and `useGroups` still
  // returns it.
  const assignableGroups = useMemo(
    () =>
      (groups.data ?? []).filter((group) =>
        summary.membersFor(group.id).some((member) => isViewer(member, viewerId)),
      ),
    [groups.data, summary, viewerId],
  );
  const assignableIds = useMemo(
    () => new Set(assignableGroups.map((group) => group.id)),
    [assignableGroups],
  );
  const nameOfGroup = useCallback(
    (groupId: string): string | null => {
      const group = assignableGroups.find((row) => row.id === groupId);
      return group ? groupLabel(group, summary.membersFor(groupId), viewerId) : null;
    },
    [assignableGroups, viewerId, summary],
  );

  // The people the picker offers, by name. A contact is somebody whose balance
  // with the viewer is explained by a single group (`only_group_id`) that is a
  // true 1:1 — you and them and nobody else. A whole trip is never a person,
  // even when it happens to be the only group you share with someone.
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

  // A set of people → the group they already share, if any. First match wins;
  // it only ever answers "these exact people already have a group together".
  const groupBySignature = useMemo(() => {
    const map = new Map<string, string>();
    for (const sig of signatures.data) {
      const key = peopleSignatureKey(sig.names);
      if (!map.has(key)) map.set(key, sig.groupId);
    }
    return map;
  }, [signatures.data]);

  // Which row the picker opens with ticked: the group the capture was tagged
  // for at capture time, when it is still one the viewer can assign into.
  const pickerSelection: DestinationSelection = useMemo(() => {
    const targetId = assigningCapture?.target_group_id;
    return targetId && assignableIds.has(targetId)
      ? { kind: 'existing', groupId: targetId }
      : { kind: 'none' };
  }, [assigningCapture?.target_group_id, assignableIds]);
  // How tall the picker sheet is ever allowed to get. A ceiling, not a height.
  const pickerMaxHeight = height * 0.8;

  // What the picker says it is placing when a whole batch is riding on the
  // answer: the running total (absent when the drafts are not one currency) and
  // how many drafts it stands for.
  const batchPreview = useMemo(() => {
    if (assigning?.kind !== 'batch') return null;
    const items = assigning.items;
    const currency = items[0]!.currency;
    const sameCurrency = items.every((item) => item.currency === currency);
    return {
      count: items.length,
      currency,
      total: sameCurrency ? items.reduce((sum, item) => sum + BigInt(item.amount), 0n) : null,
    };
  }, [assigning]);

  const rows = useMemo(() => captures.data ?? [], [captures.data]);
  const { items: feedItems, counts } = useMemo(() => buildReviewFeed(rows), [rows]);
  const waitingCount = counts.ready + counts.look;

  // Every row's destination, worked out once per render of the list rather than
  // per recycled row: the group the draft was tagged for, else the group this
  // shop's money went to last time, else nothing and the chip asks.
  const destinations = useMemo(() => {
    const byCapture = new Map<string, RowDestination>();
    for (const row of rows) {
      const found = destinationFor(row, merchants, assignableIds);
      if (found) byCapture.set(row.id, found);
    }
    return byCapture;
  }, [rows, merchants, assignableIds]);

  const openAssign = useCallback((capture: CaptureRow): void => {
    setAssigning({ kind: 'capture', capture });
  }, []);

  // The batch card's ⋯ → "Add these to a group": the same picker, opened on the
  // whole cluster instead of one row of it.
  const openAssignBatch = useCallback((items: CaptureRow[]): void => {
    setAssigning({ kind: 'batch', items });
  }, []);

  // Open the draft in the capture form to fix its fields — the same screen that
  // drafted it, now in edit mode. Every value the row carries rides along as a
  // param so the form opens filled in and saving updates the row in place rather
  // than making a second one; `parsed` (which holds the voice-batch id and the
  // message provenance) is preserved.
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

  /**
   * Take a draft off the list.
   *
   * Two behaviours, one write (`capture.delete`, which the sync protocol has
   * carried since A34 — no migration, and captures already soft-delete). A draft
   * the app *found* goes without a question: nobody typed it, and the message it
   * was made from is still in the phone's own Messages app, so there is nothing
   * to lose and nothing to confirm. A draft a person *made* keeps the confirm it
   * has always had, because their words and possibly a photograph of the bill go
   * with it.
   */
  const dismiss = useCallback(
    async (capture: CaptureRow): Promise<void> => {
      if (guard.blockWrite()) return;
      if (!wasFound(capture)) {
        const ok = await confirm({
          title: t.captures.delete,
          body: t.captures.deleteConfirm,
          confirmLabel: t.captures.delete,
          tone: 'danger',
        });
        if (!ok) return;
      }
      try {
        await deleteCapture.mutateAsync(capture.id);
        if (wasFound(capture)) toast.show(t.captures.notAnExpenseDone);
      } catch (caught) {
        toast.show(friendlyError(caught, t.captures.couldNotSave, 'captures.dismiss'), 'negative');
      }
    },
    [
      confirm,
      deleteCapture,
      guard,
      t.captures.couldNotSave,
      t.captures.delete,
      t.captures.deleteConfirm,
      t.captures.notAnExpenseDone,
      toast,
    ],
  );

  // Delete every capture in a spoken batch at once, behind one confirm.
  const confirmDeleteBatch = useCallback(
    async (items: CaptureRow[]): Promise<void> => {
      const ok = await confirm({
        title: t.captures.deleteBatch,
        body: plural(locale, items.length, t.captures.deleteBatchConfirm),
        confirmLabel: t.captures.delete,
        tone: 'danger',
      });
      if (ok) {
        for (const item of items) void deleteCapture.mutateAsync(item.id);
      }
    },
    [
      confirm,
      deleteCapture,
      locale,
      t.captures.delete,
      t.captures.deleteBatch,
      t.captures.deleteBatchConfirm,
    ],
  );

  const closeAssign = useCallback((): void => setAssigning(null), []);

  /**
   * Drafts into one group, in one go — one row swiped, or a whole spoken batch.
   *
   * This is the answer to the same question the form asks, and it ends
   * differently on purpose: opening add-expense to accept its defaults is
   * exactly the work the gesture exists to remove. So the expenses are written
   * here, with the form's own defaults — everyone in the group, split equally,
   * the person filing down as having paid — and each draft is closed against the
   * expense it became.
   *
   * Both writes ride the ordinary offline queue (ADR-005), so this works with no
   * network and survives being killed mid-run. Each draft is its own attempt:
   * one that refuses does not take the others down, and it is left in Review
   * (nothing closes it) rather than vanishing into a success message that would
   * be a lie.
   */
  const placeInGroup = useCallback(
    async (input: {
      /** What the per-target lock is taken on: the row, or the batch's first row. */
      lockKey: string;
      items: readonly CaptureRow[];
      groupId: string;
      /** What to call the group in the confirmation. */
      label: string;
      members: readonly AssignMember[];
      /** Who the viewer is in that group — the payer. Resolved by the caller. */
      myMemberId: string | null;
      currency: string;
    }): Promise<void> => {
      if (placing.current.has(input.lockKey)) return;
      if (guard.blockWrite()) return;
      placing.current.add(input.lockKey);
      try {
        // Another device may have placed one of these while the sheet was open;
        // the inbox read already knows, and writing it again would file the same
        // dinner twice.
        const waiting = stillWaiting(input.items, rows);
        if (waiting.length === 0) {
          toast.show(t.captures.assignBatchAlreadyDone);
          return;
        }
        const plan = planCaptureAssign({
          captures: waiting,
          members: input.members,
          myMemberId: input.myMemberId,
          currency: input.currency,
        });

        let placed = 0;
        // A draft whose amount the ledger cannot take never had a write to try.
        let failed = plan.unusable.length;
        for (const write of plan.writes) {
          try {
            await mutate(MutationKind.ExpenseCreate, input.groupId, write.payload);
            // Only once the expense is on the queue: a draft closed before its
            // expense exists is a spend that quietly disappeared.
            await assignCapture.mutateAsync({
              captureId: write.captureId,
              groupId: input.groupId,
              expenseId: write.expenseId,
            });
            placed += 1;
          } catch {
            failed += 1;
          }
        }

        if (failed === 0) {
          if (placed > 0) {
            toast.show(
              plural(locale, placed, t.captures.assignedBatch).replaceAll('{name}', input.label),
            );
          }
          return;
        }
        // Something did not land, so this is said in a dialog rather than a
        // toast that fades: it names how many are still waiting, and (when some
        // did land) how many did, so neither half of a partial run is implied.
        const lines: string[] = [];
        if (placed > 0) {
          lines.push(
            plural(locale, placed, t.captures.assignedBatch).replaceAll('{name}', input.label),
          );
        }
        lines.push(plural(locale, failed, t.captures.assignBatchSomeFailed));
        await notify({ title: t.captures.title, body: lines.join('\n\n') });
      } catch (caught) {
        // The callers fire this without awaiting it, so anything the planning
        // step throws would otherwise leave with no word to the person whose
        // drafts are still sitting there. A toast rather than a dialog: the
        // drafts are exactly where they were, so there is nothing to answer.
        toast.show(
          friendlyError(caught, t.captures.couldNotSave, 'captures.assignBatch'),
          'negative',
        );
      } finally {
        placing.current.delete(input.lockKey);
      }
    },
    [
      assignCapture,
      guard,
      locale,
      mutate,
      notify,
      rows,
      t.captures.assignBatchAlreadyDone,
      t.captures.assignBatchSomeFailed,
      t.captures.assignedBatch,
      t.captures.couldNotSave,
      t.captures.title,
      toast,
    ],
  );

  /** The whole of the swipe: this draft, into the group the chip already named. */
  const fileWhereItSays = useCallback(
    (capture: CaptureRow): void => {
      const destination = destinations.get(capture.id);
      if (!destination) return;
      const groupId = destination.groupId;
      const members = summary.membersFor(groupId);
      const group = assignableGroups.find((row) => row.id === groupId);
      void placeInGroup({
        lockKey: capture.id,
        items: [capture],
        groupId,
        label: group ? groupLabel(group, members, viewerId) : '',
        members,
        // `isViewer`, never a bare comparison: this decides who the ledger
        // records as having paid, and a ghost answering to an unloaded profile
        // would put somebody else's name on the expense.
        myMemberId: members.find((member) => isViewer(member, viewerId))?.id ?? null,
        currency: group?.default_currency ?? capture.currency,
      });
    },
    [assignableGroups, destinations, placeInGroup, viewerId, summary],
  );

  /**
   * A chosen existing group, for whichever the picker is open on.
   *
   * One draft is unchanged: its own values are handed to the add-expense form as
   * prefill, carrying its id so that saving there closes the capture
   * (`useAssignCapture`). A batch skips the form — that is the whole point.
   */
  const chooseExistingGroup = useCallback(
    (target: AssignTarget, groupId: string): void => {
      closeAssign();
      if (target.kind === 'capture') {
        router.push(assignCaptureHref(target.capture, groupId));
        return;
      }
      const members = summary.membersFor(groupId);
      const group = assignableGroups.find((row) => row.id === groupId);
      void placeInGroup({
        lockKey: target.items[0]!.id,
        items: target.items,
        groupId,
        label: group ? groupLabel(group, members, viewerId) : '',
        members,
        myMemberId: members.find((member) => isViewer(member, viewerId))?.id ?? null,
        // A draft assigned through the form takes the group's currency too
        // (the href carries no currency of its own), so the batch does the same.
        currency: group?.default_currency ?? target.items[0]!.currency,
      });
    },
    [assignableGroups, closeAssign, placeInGroup, viewerId, summary],
  );

  // The People tab, confirmed: this draft is with these people. If they already
  // share a group it is that group's expense. If they do not, the group is made
  // here and the draft assigned into it: a lone name is the 1:1 "add a person"
  // case, several is a real group, and both are named after whoever is in them
  // the way WhatsApp does.
  const assignToPeople = useCallback(
    async (names: string[]): Promise<void> => {
      const target = assigning;
      if (!target) return;
      const clean = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
      if (clean.length === 0) return;

      const shared = groupBySignature.get(peopleSignatureKey(clean));
      if (shared) {
        chooseExistingGroup(target, shared);
        return;
      }

      const groupId = newGroupId;
      const currency =
        target.kind === 'capture' ? target.capture.currency : target.items[0]!.currency;
      closeAssign();
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
        // With no group to assign into there is nowhere to push, so say why and
        // leave the draft exactly where it was.
        toast.show(
          friendlyError(caught, t.captures.couldNotSave, 'captures.newPeopleGroup'),
          'negative',
        );
        return;
      }
      // Spent — the next new group needs its own pair of ids.
      setNewGroupId(randomUUID());
      setNewMemberId(randomUUID());
      if (target.kind === 'capture') {
        router.push(assignCaptureHref(target.capture, groupId));
        return;
      }
      // The group and its people exist only on the queue so far, so the mirror
      // cannot list its members yet. Their ids were minted here, so the batch
      // names them itself rather than waiting for a read that has not happened.
      void placeInGroup({
        lockKey: target.items[0]!.id,
        items: target.items,
        groupId,
        label: clean.join(', '),
        members: [{ id: newMemberId }, ...ghostIds.map((id) => ({ id }))],
        myMemberId: newMemberId,
        currency,
      });
    },
    [
      addGhost,
      assigning,
      chooseExistingGroup,
      closeAssign,
      createGroup,
      groupBySignature,
      newGroupId,
      newMemberId,
      placeInGroup,
      t.captures.couldNotSave,
      toast,
    ],
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

  const toggleBatch = useCallback((batchId: string): void => {
    setOpenBatchIds((current) => {
      const next = new Set(current);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ReviewFeedItem }) => {
      switch (item.kind) {
        case 'section':
          return <SectionHeading section={item.section} count={item.count} locale={locale} t={t} />;
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
            <View style={{ marginVertical: theme.spacing.xs }}>
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
            </View>
          );
        case 'single': {
          const capture = item.capture;
          const destination = destinations.get(capture.id) ?? null;
          const destinationName = destination ? nameOfGroup(destination.groupId) : null;
          // Leading: file it where the chip says — offered only when the chip
          // actually says somewhere, so the gesture can never do something the
          // row did not first state. Trailing: take it off the list.
          const leading: SwipeAction | null =
            destination && destinationName
              ? {
                  label: destinationName,
                  icon: 'checkmark-circle-outline',
                  tone: 'brand',
                  onAction: () => fileWhereItSays(capture),
                }
              : null;
          const trailing: SwipeAction = {
            label: wasFound(capture) ? t.captures.notAnExpense : t.captures.delete,
            icon: wasFound(capture) ? 'close-circle-outline' : 'trash-outline',
            tone: 'muted',
            onAction: () => void dismiss(capture),
          };
          return (
            <View style={{ marginVertical: theme.spacing.xs }}>
              {/* Keyed by the draft: FlashList recycles this cell, and a fresh
                  SwipeRow per draft is what stops one arriving half-open. */}
              <SwipeRow key={capture.id} leading={leading} trailing={trailing}>
                <CaptureListRow
                  capture={capture}
                  locale={locale}
                  t={t}
                  destinationName={destinationName}
                  onAssign={() => openAssign(capture)}
                  onMore={() => openCaptureMenu(capture)}
                  onFile={leading ? () => fileWhereItSays(capture) : null}
                  onDismiss={() => void dismiss(capture)}
                />
              </SwipeRow>
            </View>
          );
        }
      }
    },
    [
      destinations,
      dismiss,
      fileWhereItSays,
      locale,
      nameOfGroup,
      openAssign,
      openBatchIds,
      openBatchMenu,
      openCaptureMenu,
      t,
      theme.spacing.md,
      theme.spacing.xs,
      toggleBatch,
    ],
  );

  // One object so a chip, a fold or a swipe re-renders a row FlashList would
  // otherwise recycle unchanged.
  const listState = useMemo(() => ({ openBatchIds, destinations }), [openBatchIds, destinations]);

  const menuCapture = menu?.kind === 'capture' ? menu.capture : null;
  const menuDestination = menuCapture ? (destinations.get(menuCapture.id) ?? null) : null;
  const menuDestinationName = menuDestination ? nameOfGroup(menuDestination.groupId) : null;

  // ── The way through to the bank messages ──────────────────────────────
  //
  // Bank messages used to be poured into this list. They should not have been:
  // Review is the short list of things genuinely waiting on a person, and a
  // stream of a hundred rows nobody has looked at makes the four that need an
  // answer unfindable. They have their own screen now, and this is the door to
  // it — one row, carrying the one number that decides whether it is worth
  // opening.
  //
  // The confident expenses are still *here* as well, by design: a message the
  // app read cleanly is an answer, not a question, and it belongs in the list of
  // things to file. Everything it was unsure of waits behind this row.
  const bankMessages = useSmsMessages(smsReader);
  const bankWaiting = useMemo(() => totalWaiting(bankMessages.rows), [bankMessages.rows]);
  const bankMessagesRow = smsReader ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t.smsInbox.entryTitle}. ${
        bankWaiting > 0
          ? plural(locale, bankWaiting, t.smsInbox.entryWaiting)
          : t.smsInbox.entryNothing
      }`}
      onPress={() => router.push('/captures/sms')}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.color.brandSoft,
        }}
      >
        <Ionicons name="chatbubbles" size={iconSize.md} color={theme.color.brand} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body">{t.smsInbox.entryTitle}</Text>
        <Text variant="micro" tone="muted">
          {t.smsInbox.onDevice}
        </Text>
      </View>
      {bankWaiting > 0 ? (
        <Badge label={plural(locale, bankWaiting, t.smsInbox.entryWaiting)} tone="brand" />
      ) : null}
      <Ionicons
        name={directionalIcon('chevron-forward')}
        size={iconSize.md}
        color={theme.color.textMuted}
      />
    </Pressable>
  ) : null;

  // Where pasting lives now. With a reader running it is one quiet line at the
  // foot of the list — a fallback, labelled as an alternative rather than as the
  // way in. With nothing reading (every iPhone) it is a real, labelled button,
  // because it is the only path there is and a consolation prize is not what a
  // person on an iPhone should be handed.
  const anotherWay = (
    <View style={{ alignItems: 'center', paddingTop: theme.spacing.lg }}>
      <Button
        label={auto.enabled ? t.captures.addAnotherWay : t.captures.fromMessage}
        variant={auto.enabled ? 'ghost' : 'secondary'}
        onPress={() => router.push('/captures/paste')}
      />
    </View>
  );

  return (
    <Screen edges={['top']}>
      {/* Review is a bar destination, so it wears no back chevron: there is
          nowhere "back" from a tab. `edges` drops `'bottom'` — the FlashList's
          `paddingBottom: clearance` already reserves the room the tab bar
          needs. */}
      <Row
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Ionicons name="file-tray-full-outline" size={iconSize.xl} color={theme.color.brand} />
        <View style={{ flex: 1 }}>
          <Text variant="title" numberOfLines={1}>
            {t.captures.title}
          </Text>
          {/* The line under the title is a *state*, not an instruction. With
              something reading, it says so and when it last looked. With nothing
              reading, it falls back to how many are waiting — and says nothing
              at all at zero, where the empty state already speaks. */}
          {auto.enabled ? (
            <WatchingLine
              checking={auto.checking}
              lastCheckedAt={auto.lastCheckedAt}
              now={now}
              locale={locale}
              t={t}
              onRefresh={() => void auto.refresh()}
            />
          ) : waitingCount > 0 ? (
            <Text variant="micro" tone="muted" numberOfLines={1}>
              {plural(locale, waitingCount, t.captures.unassignedBody)}
            </Text>
          ) : null}
        </View>
        {/* With nothing reading, the message path keeps its glyph in the header:
            it is the main way a spend arrives on an iPhone and must not be
            buried. With a reader running, the header holds nothing — pasting has
            moved to "Add another way" at the foot of the list. */}
        {auto.enabled ? null : (
          <IconButton label={t.captures.fromMessage} onPress={() => router.push('/captures/paste')}>
            <Ionicons
              name="chatbubble-ellipses-outline"
              size={iconSize.md}
              color={theme.color.text}
            />
          </IconButton>
        )}
      </Row>

      {/* One virtualized scroll region for every state — pull-to-refresh still
          works while loading or empty, but a pasted month only mounts the rows
          near the viewport. */}
      <FlashList
        data={captures.isLoading || rows.length === 0 ? [] : feedItems}
        keyExtractor={reviewItemKey}
        renderItem={renderItem}
        getItemType={(item) => item.kind}
        // The group-ledger settings: `extraData` because a chip or a fold changes
        // a row FlashList would otherwise recycle unchanged, and the draw
        // distance so a pasted month scrolls without blanking.
        extraData={listState}
        drawDistance={1500}
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
        ListHeaderComponent={bankMessagesRow}
        ListFooterComponent={rows.length > 0 ? anotherWay : null}
        ListEmptyComponent={
          captures.isLoading ? (
            <InboxSkeleton />
          ) : (
            /* The zero state, designed as carefully as the full one. Review is
               trying to reach *this*: it is the app's list of questions, and a
               good week is one where it has none. So it never apologises for
               being empty — it says nothing needs you, and then says how much
               went through anyway. */
            <View style={{ flex: 1, justifyContent: 'center' }}>
              <EmptyState
                icon={
                  <Ionicons
                    name="checkmark-done-outline"
                    size={iconSize.huge}
                    color={theme.color.brand}
                  />
                }
                title={t.captures.nothingNeedsYou}
                body={
                  filedThisWeek > 0
                    ? plural(locale, filedThisWeek, t.captures.filedThisWeek)
                    : auto.enabled
                      ? t.captures.watchingNothingYet
                      : t.captures.emptyBody
                }
                action={
                  <View style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
                    <Button label={t.captures.captureCta} onPress={() => router.push('/capture')} />
                    <Button
                      label={auto.enabled ? t.captures.addAnotherWay : t.captures.fromMessage}
                      variant="ghost"
                      onPress={() => router.push('/captures/paste')}
                    />
                  </View>
                }
              />
            </View>
          )
        }
      />

      {/* The group picker, as a sheet over the list rather than a screen away —
          assigning is one tap and one choice.

          A real Modal, not an absolute overlay: the one bottom bar (`AppTabBar`)
          is rendered at the root over the whole stack, so an in-tree overlay
          paints *under* it and the sheet's lower rows hide behind the nav bar. */}
      <Sheet
        visible={assigning !== null}
        onClose={closeAssign}
        padded={false}
        closeLabel={t.common.close}
        style={{
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.md,
          maxHeight: pickerMaxHeight,
        }}
      >
        <Text variant="heading">{t.captures.assignTitle}</Text>

        {/* What is being placed, so the sheet stands on its own over the list it
            hides: the amount and its note beside the capture's own glyph. */}
        {assigningCapture ? (
          <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <CategoryBadge
              category={assigningCapture.category}
              meta={assigningCapture.category_meta}
              description={assigningCapture.description}
              size={38}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <MoneyText
                amount={BigInt(assigningCapture.amount)}
                currency={assigningCapture.currency}
                locale={locale}
                variant="subheading"
              />
              {assigningCapture.description ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {assigningCapture.description}
                </Text>
              ) : null}
            </View>
          </Row>
        ) : batchPreview ? (
          <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.color.brandSoft,
              }}
            >
              <Ionicons name="layers-outline" size={iconSize.md} color={theme.color.brand} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              {batchPreview.total !== null ? (
                <MoneyText
                  amount={batchPreview.total}
                  currency={batchPreview.currency}
                  locale={locale}
                  variant="subheading"
                />
              ) : null}
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {plural(locale, batchPreview.count, t.captures.batchExpenses)}
              </Text>
            </View>
          </Row>
        ) : null}

        {/* The same picker the voice review opens, so "where does this go?" is
            one control in the app rather than two that drifted apart.

            A plain ScrollView, not the FlashList this screen uses everywhere
            else: FlashList's container is `flex: 1` by construction, so it
            cannot size itself to its rows, and a fixed fraction of the window
            left a person with two groups staring at a half-screen of white. */}
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ flexShrink: 1 }}
        >
          <DestinationPicker
            // Remount per draft (or per batch), so the tab and any half-made
            // people selection start fresh on each open.
            key={
              assigning
                ? assigning.kind === 'capture'
                  ? assigning.capture.id
                  : assigning.items[0]!.id
                : 'closed'
            }
            selection={pickerSelection}
            eyebrow={null}
            // "Unassigned" is not offered: a draft already *is* unassigned, so
            // the row would point at where it already sits. "Just me" is — it
            // files the draft as a private personal expense (A48), through the
            // same path the voice review uses (`usePlaceInPersonal`).
            pinned={['me']}
            createRow={assigning?.kind === 'batch' ? null : { label: t.captures.assignNew }}
            emptyGroups={t.captures.noGroups}
            labelFor={(group) => groupLabel(group, summary.membersFor(group.id), viewerId)}
            groups={assignableGroups}
            people={peopleChoices}
            t={t}
            onChoose={(choice) => {
              // The Sheet stays mounted through its fade-out, so this can fire a
              // frame after the backdrop cleared `assigning`.
              const target = assigning;
              if (!target) return;
              if (choice.kind === 'existing') {
                chooseExistingGroup(target, choice.groupId);
              } else if (choice.kind === 'me') {
                closeAssign();
                void placeInPersonal({
                  lockKey: target.kind === 'capture' ? target.capture.id : target.items[0]!.id,
                  items: target.kind === 'capture' ? [target.capture] : target.items,
                });
              } else if (choice.kind === 'create' && target.kind === 'capture') {
                closeAssign();
                router.push({
                  pathname: '/new-group',
                  params: { assignCaptureId: target.capture.id },
                });
              }
            }}
            onResolvePeople={(names) => void assignToPeople(names)}
          />
        </ScrollView>
      </Sheet>

      {/* The row's ⋯ overflow, as a small sheet. Every gesture this screen has
          is also a plain row in here: filing it where the chip says, and taking
          it off the list. A swipe is a shortcut, never the only way through. */}
      <Sheet
        visible={menu !== null}
        onClose={closeMenu}
        padded={false}
        closeLabel={t.common.close}
        style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.xs }}
      >
        {menuCapture ? (
          <>
            <Text variant="heading" numberOfLines={1} style={{ marginBottom: theme.spacing.xs }}>
              {menuCapture.description?.trim() ||
                (menuCapture.category
                  ? (t.categories as Record<string, string>)[menuCapture.category]
                  : undefined) ||
                t.captures.unassigned}
            </Text>
            {menuDestinationName ? (
              <>
                <ActionSheetRow
                  icon="checkmark-circle-outline"
                  label={t.captures.fileTo.replace('{name}', menuDestinationName)}
                  tone="brand"
                  onPress={() => {
                    const capture = menuCapture;
                    setMenu(null);
                    fileWhereItSays(capture);
                  }}
                />
                <Divider />
              </>
            ) : null}
            <ActionSheetRow
              icon="people-outline"
              label={t.captures.assign}
              tone={menuDestinationName ? 'default' : 'brand'}
              onPress={() => {
                const capture = menuCapture;
                setMenu(null);
                openAssign(capture);
              }}
            />
            <Divider />
            <ActionSheetRow
              icon="create-outline"
              label={t.captures.edit}
              onPress={() => {
                const capture = menuCapture;
                setMenu(null);
                openEdit(capture);
              }}
            />
            <Divider />
            <ActionSheetRow
              icon={wasFound(menuCapture) ? 'close-circle-outline' : 'trash-outline'}
              label={wasFound(menuCapture) ? t.captures.notAnExpense : t.captures.delete}
              tone="negative"
              onPress={() => {
                const capture = menuCapture;
                setMenu(null);
                void dismiss(capture);
              }}
            />
          </>
        ) : menu?.kind === 'batch' ? (
          <>
            <Text variant="heading" numberOfLines={1} style={{ marginBottom: theme.spacing.xs }}>
              {plural(locale, menu.items.length, t.captures.batchExpenses)}
            </Text>
            {/* The whole cluster into one group, in one tap — the alternative to
                expanding it and answering the same question once per row. */}
            <ActionSheetRow
              icon="people-outline"
              label={t.captures.assignBatch}
              tone="brand"
              onPress={() => {
                const items = menu.items;
                setMenu(null);
                openAssignBatch(items);
              }}
            />
            <Divider />
            <ActionSheetRow
              icon="trash-outline"
              label={t.captures.deleteBatch}
              tone="negative"
              onPress={() => {
                const items = menu.items;
                setMenu(null);
                void confirmDeleteBatch(items);
              }}
            />
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}
