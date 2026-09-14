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
 * fallback it always was, reachable from the header glyph on a phone that
 * cannot read, and from the zero state — and the primary path only where there
 * is no other: iPhone, where no reading API exists at any tier. It has no
 * footer under the list: a button sitting below a hundred and forty drafts is
 * one nobody scrolls to, and on a phone that *does* read, an alternative way in
 * is not something to advertise at all.
 *
 * FOUR THINGS CHANGED, AND EACH ANSWERS A COMPLAINT.
 *
 * 1. **A status, not an instruction.** The top of the screen used to explain
 *    what to do. An instruction is what you show somebody you are about to make
 *    work; when the app is doing the work, the honest object is a *state*. So:
 *    a dot and "Watching your bank messages · 2 min ago", read in two seconds,
 *    tappable to look again. It is shown only while something really is
 *    watching (`useSmsAutoRead`), because a line claiming to watch when nothing
 *    does would be worse than no line at all. It now rides on the same gradient
 *    hero a group opens with (`components/ScreenHero`) — one of the three
 *    screens in the bottom bar should not announce itself with the small-glyph
 *    row of a settings page — over the count of what is still waiting and the
 *    button that adds to it.
 *
 * 2. **Two errands in tabs, two confidences in sections.** The tabs are *where
 *    a draft came from*: **SMS** — read off the phone's inbox, or pasted in on
 *    an iPhone, which is still a bank message — and what this person added on
 *    purpose. Inside whichever tab is open, the list is cut again into
 *    **Ready** and **Worth a look** — a split by what the parser is *sure of*.
 *    Two questions, asked at different moments, and `lib/reviewFeed.ts` carries
 *    both rules and the reasoning; the sections stay sections because they need
 *    no navigation, carry their own counts, and disappear when empty. The
 *    screen opens on the tab that can reach zero, which is the added one.
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
 *    And "Select" turns on tick boxes so that second answer can be given once
 *    about many: a morning's bank messages is thirty rows and most of them are
 *    a card bill or a transfer to yourself, so saying "not an expense" thirty
 *    times is not answering, it is data entry.
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  SegmentedTabs,
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
import { HeroActionCircle, ScreenHero, useHeroStatusBar } from '@/components/ScreenHero';
import { InboxSkeleton } from '@/components/Skeletons';
import { WatchingLine } from '@/components/WatchingLine';
import { dayHeading } from '@/data/activity';
import { useFiledThisWeek, useSuggestionIndex } from '@/data/reviewSources';
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
import { useGuestGuard, usePersonalOffered } from '@/lib/guestGuard';
import { suggestGroup, tripWindowsOf, type GroupSuggestion } from '@/lib/groupSuggestion';
import { router } from '@/lib/navigation';
import { usePullRefresh } from '@/lib/pullRefresh';
import { suppressTabBar } from '@/lib/tabBarSuppress';
import {
  buildReviewFeed,
  openingTab,
  splitByTab,
  type ReviewTabId,
  doubtsAbout,
  reviewItemKey,
  type ReviewFeedItem,
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
/** "Found for you · 14" — the count beside the word, never instead of it. */
function countLabel(word: string, count: number): string {
  return count === 0 ? word : `${word} ${count}`;
}

function wasFound(capture: CaptureRow): boolean {
  const parsed = capture.parsed;
  return (
    !!parsed && typeof parsed === 'object' && (parsed as { source?: unknown }).source === 'sms'
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
  ticking = false,
  selected = false,
  onToggleSelected,
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
  /**
   * Whether this row offers a tick box at all.
   *
   * True on the SMS tab, where the pile is a hundred deep and answering it one
   * row at a time is data entry. False on the drafts a person added themselves:
   * there are a handful, each one is a spend they remember making, and each
   * wants its own answer — so a press there opens the picker, as it always did.
   */
  ticking?: boolean;
  /** Whether this row's tick box is filled. Never set on a `bare` row. */
  selected?: boolean;
  /** Tick or untick. Absent on a `bare` row — a batch is ticked as one card. */
  onToggleSelected?: () => void;
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
      // A checkbox, because that is what a press now does. It read as a button
      // labelled "file this to Goa" while actually ticking the row — an
      // announcement of one action and the performance of another, which is the
      // one accessibility bug a sighted test can never catch. The destination
      // still rides on the label, because knowing where a draft is headed is
      // most of what the row says; it is just no longer claimed as the action.
      accessibilityRole={ticking && !bare ? 'checkbox' : 'button'}
      accessibilityLabel={
        destinationName
          ? `${title}, ${t.captures.fileTo.replace('{name}', destinationName)}`
          : title
      }
      accessibilityActions={actions}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        if (name === 'more') onMore();
        else if (name === 'dismiss') onDismiss();
        else if (name === 'file') onFile?.();
      }}
      // A row on the ticking tab ticks. Everything else opens the picker: the
      // drafts a person added themselves, and any row inside an opened batch,
      // which has no tick of its own to give.
      onPress={ticking && !bare ? onToggleSelected : onAssign}
      accessibilityState={ticking && !bare ? { checked: selected } : undefined}
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
        {/* Always drawn — except inside an opened batch. Ticking is Review's
            main verb now: the list is a hundred rows deep on a phone whose
            messages the app reads, and answering it row by row is not
            answering, it is data entry. Behind a "Select" button that was a
            gesture most people never found; in front of them it is the one the
            screen is for. Same rule, same reasoning, as Bank messages.

            A `bare` row is a member of an expanded spoken batch. It gets no
            `onToggleSelected` and is not in `selectableIds` — the batch is
            ticked as one card — so a box here would be a control that looks
            live, never fills, and leaves "select all" apparently incomplete. */}
        {ticking && !bare ? (
          <Ionicons
            name={selected ? 'checkbox' : 'square-outline'}
            size={iconSize.lg}
            color={selected ? theme.color.brand : theme.color.textMuted}
          />
        ) : null}
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
  const insets = useSafeAreaInsets();
  // The hero runs dark under the status bar, so the clock and the battery go
  // white — but only while this tab is the one you are looking at. See
  // `useHeroStatusBar`: a tab does not unmount when you leave it.
  useHeroStatusBar();
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
  const personalOffered = usePersonalOffered();
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
  const suggestions = useSuggestionIndex();
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
  // Two errands, two tabs: what the app found in the phone's bank messages,
  // and what its user added on purpose and has not filed yet. The rule and the
  // reasoning are in `lib/reviewFeed.ts`.
  const byTab = useMemo(() => splitByTab(rows), [rows]);
  const [tab, setTab] = useState<ReviewTabId | null>(null);
  // Decided once, from the first load that actually carries rows, and then
  // left alone. Re-deriving it every render would move the tab under somebody
  // as drafts arrive — an hourly read landing while they are mid-list would
  // walk them to the other half.
  //
  // Seeded during render rather than in an effect: this is a value, and
  // computing a value in an effect means rendering once with the wrong one and
  // again with the right one. React's own escape hatch for deriving state from
  // changing input, guarded so it runs exactly once — on the first load that
  // carries anything.
  const [seeded, setSeeded] = useState(false);
  if (!seeded && rows.length > 0) {
    setSeeded(true);
    setTab(openingTab(rows));
  }
  // Matches `openingTab`'s own answer for an empty list, so the tab that is
  // live before the first load carries rows is the tab seeding will choose.
  const activeTab: ReviewTabId = tab ?? 'added';
  const tabRows = byTab[activeTab];
  // Ticking belongs to the SMS tab only. That pile is a stream the app fills on
  // its own — a hundred and forty rows, most of them a card bill or a transfer
  // to yourself — and it is answered in handfuls. The drafts somebody added
  // themselves are a handful to begin with, each one a spend they remember
  // making and each wanting its own destination, so a tick box there would be
  // furniture on every row for a gesture that half of them never fits.
  const ticking = activeTab === 'found';
  const feedItems = useMemo(() => buildReviewFeed(tabRows), [tabRows]);

  // Ticking several drafts and placing them together. Held as ids rather than
  // rows so a refresh that replaces the row objects does not silently drop a
  // selection, and pruned against what is actually on screen so "place 6" can
  // never act on a draft the person can no longer see.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Exactly the rows that draw a tick box — which is not every draft in the
  // tab. A spoken batch folds several into one card with no box of its own and
  // its own "place the lot" gesture, so taking its ids here would make "select
  // all" tick rows nobody can see ticked and leave the toggle unable to reach
  // "all". Read off the built feed rather than the raw rows, so the two can
  // never drift: what is selectable is, by construction, what is rendered
  // selectable.
  const selectableIds = useMemo(
    () => feedItems.filter((item) => item.kind === 'single').map((item) => item.capture.id),
    [feedItems],
  );
  const selectableSet = useMemo(() => new Set(selectableIds), [selectableIds]);
  const chosenRows = useMemo(
    () => tabRows.filter((row) => selected.has(row.id) && selectableSet.has(row.id)),
    [tabRows, selected, selectableSet],
  );
  const everythingTicked = selectableIds.length > 0 && chosenRows.length === selectableIds.length;

  /**
   * While anything is ticked, the bottom bar stands down.
   *
   * The action bar is an in-tree view and the navigation is rendered at the root
   * over the whole stack, so the two used to sit on top of one another — a band
   * of buttons with the bar beneath it, and the raised mic landing squarely on
   * "Add 2 to a group". Nothing about the route has changed, so neither could
   * move out of the other's way by the usual rule; the bar takes a second input
   * instead (`lib/tabBarSuppress`).
   *
   * An effect rather than a render-time call, because it is exactly what an
   * effect is for: a subscription to something outside React, released on the
   * way out. The cleanup matters — walking away mid-selection must put the
   * navigation back, or a person is left on another tab with no way to leave it.
   */
  const bottomBarStandsDown = ticking && chosenRows.length > 0;
  useEffect(() => {
    if (!bottomBarStandsDown) return;
    return suppressTabBar();
  }, [bottomBarStandsDown]);
  const toggleSelected = useCallback((id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The trips that were actually running, from the groups this viewer can still
  // write to. Dateless trips are not windows and are left out — see
  // `tripWindowsOf`.
  const trips = useMemo(() => tripWindowsOf(assignableGroups), [assignableGroups]);

  // Every row's suggestion, worked out once per render of the list rather than
  // per recycled row: what the person tagged, else what the trip, the shop and
  // the kind of spend agree on, else nothing and the chip asks. The weighing —
  // and the two bars a winner has to clear before it is said out loud — is in
  // `lib/groupSuggestion.ts`, where a test can reach it.
  const destinations = useMemo(() => {
    const byCapture = new Map<string, GroupSuggestion>();
    for (const row of rows) {
      const found = suggestGroup({
        capture: row,
        index: suggestions,
        trips,
        assignable: assignableIds,
      });
      if (found) byCapture.set(row.id, found);
    }
    return byCapture;
  }, [rows, suggestions, trips, assignableIds]);

  // Which row the picker opens with ticked: the group the capture was tagged
  // for at capture time, else the group the row chip already suggested. Both
  // still have to be assignable; stale suggestions are not choices.
  const pickerSelection: DestinationSelection = useMemo(() => {
    if (!assigningCapture) return { kind: 'none' };
    const targetId = assigningCapture.target_group_id;
    if (targetId && assignableIds.has(targetId)) return { kind: 'existing', groupId: targetId };
    const suggestedId = destinations.get(assigningCapture.id)?.groupId;
    return suggestedId && assignableIds.has(suggestedId)
      ? { kind: 'existing', groupId: suggestedId }
      : { kind: 'none' };
  }, [assigningCapture, assignableIds, destinations]);

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

  /**
   * Take a whole ticked pile off the list at once.
   *
   * The reason this exists is the complaint that produced it: a morning's bank
   * messages is thirty rows, most of them a credit-card bill or a transfer to
   * oneself, and answering "not an expense" thirty times is not answering — it
   * is data entry. One swipe was already the cheapest single gesture the screen
   * could offer; the missing thing was a way to say it once about many.
   *
   * It follows `dismiss`'s rule rather than inventing a second one. Drafts the
   * app *found* go without a question: nobody typed a word of them and the
   * messages are still in the phone's own Messages app, so there is nothing to
   * lose and a dialog in front of a loss-free action is a dialog people learn
   * to dismiss unread. The moment one draft in the pile was made by a person —
   * their words, possibly a photograph of the bill — the confirm comes back,
   * for the whole pile, once.
   *
   * Each draft is its own attempt, like every other batch on this screen: one
   * that refuses does not take the others down, and it stays on the list rather
   * than vanishing into a success message that would be a lie.
   */
  const dismissMany = useCallback(
    async (items: readonly CaptureRow[]): Promise<void> => {
      if (items.length === 0) return;
      if (guard.blockWrite()) return;
      const allFound = items.every(wasFound);
      if (!allFound) {
        const ok = await confirm({
          title: t.captures.delete,
          body: plural(locale, items.length, t.captures.dismissManyConfirm),
          confirmLabel: t.captures.delete,
          tone: 'danger',
        });
        if (!ok) return;
      }
      setSelected(new Set());
      let failed = 0;
      let firstError: unknown = undefined;
      for (const item of items) {
        try {
          await deleteCapture.mutateAsync(item.id);
        } catch (caught) {
          failed += 1;
          if (firstError === undefined) firstError = caught;
        }
      }
      if (failed === 0) toast.show(t.captures.notAnExpenseDone);
      // The reason, not a guess at it — and reported, so a failure here is
      // something that can be looked at rather than only described.
      else
        toast.show(
          friendlyError(firstError, t.captures.couldNotSave, 'captures.dismissMany'),
          'negative',
        );
    },
    [
      confirm,
      deleteCapture,
      guard,
      locale,
      t.captures.couldNotSave,
      t.captures.delete,
      t.captures.dismissManyConfirm,
      t.captures.notAnExpenseDone,
      toast,
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
        // Kept rather than dropped. A bare `catch {}` here counted the refusal
        // and threw away the only thing that could explain it, so every failure
        // read alike and none of them reached Sentry.
        let firstError: unknown = undefined;
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
          } catch (caught) {
            failed += 1;
            if (firstError === undefined) firstError = caught;
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
        // And why, in words a person can act on. "Try again in a moment" is a
        // guess, and a wrong one whenever the cause is not going to pass on its
        // own; `friendlyError` reports the exception as it renders it.
        if (firstError !== undefined) {
          lines.push(friendlyError(firstError, t.captures.couldNotSave, 'captures.assignBatch'));
        }
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
      // Only a batch ends the selection, because only a batch can *be* the
      // selection. Filing one row from its own ⋯ while several are ticked is a
      // different errand, and wiping the ticks would punish somebody for using
      // the sheet mid-selection. Cancelling never comes through here at all,
      // which is right: a selection somebody backed out of is one they still
      // have.
      if (target.kind === 'batch') {
        setSelected(new Set());
      }
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
      setSelected(new Set());
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
        case 'day':
          return (
            <Text
              variant="micro"
              tone="muted"
              style={{
                textTransform: 'uppercase',
                // Padding, for the same reason as the section heading above:
                // a margin on a cell root is height FlashList cannot see.
                paddingTop: theme.spacing.md,
                paddingBottom: theme.spacing.xs,
              }}
            >
              {dayHeading(locale, item.createdAt)}
            </Text>
          );
        case 'batch':
          return (
            <View style={{ paddingVertical: theme.spacing.xs }}>
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
          // "File it where the chip says" is offered only when the chip
          // actually names somewhere, so it can never do something the row did
          // not first state. That condition used to ride on the swipe's leading
          // action; the swipe has gone and the condition has not.
          const row = (
            <CaptureListRow
              capture={capture}
              locale={locale}
              t={t}
              destinationName={destinationName}
              onAssign={() => openAssign(capture)}
              onMore={() => openCaptureMenu(capture)}
              onFile={destinationName ? () => fileWhereItSays(capture) : null}
              onDismiss={() => void dismiss(capture)}
              ticking={ticking}
              selected={selected.has(capture.id)}
              onToggleSelected={() => toggleSelected(capture.id)}
            />
          );
          return (
            /* No swipe. A drag that both ticks a row and files it somewhere is
               two answers to one gesture, and the one it would win is whichever
               way the finger moved further — so with the tick boxes always out,
               the swipe had to go. Both of its answers survive as plain rows in
               the ⋯ sheet, and "not an expense" now also answers a whole ticked
               pile at once, which is what the gesture was really for. */
            <View style={{ paddingVertical: theme.spacing.xs }}>{row}</View>
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
      selected,
      ticking,
      toggleSelected,
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

  return (
    <Screen edges={[]}>
      {/* Review opens on the same panel a group does — the gradient running up
          under the status bar, the name of the thing, one number that is the
          point of the screen, and the action that number invites. It used to
          open on a white row with a small glyph, which is the layout of a
          settings page; on one of the three screens in the bottom bar that read
          as somewhere you had wandered into rather than somewhere you meant to
          go. `ScreenHero` is the group hero's own shell, so the two cannot
          drift.

          No back chevron: this is a bar destination and there is nowhere "back"
          from a tab. `edges={[]}` lets the panel run under the status bar the
          way the dashboard's does; the FlashList's `paddingBottom: clearance`
          still reserves the room the tab bar needs at the other end. */}
      <ScreenHero
        icon="file-tray-full-outline"
        title={t.captures.title}
        // The line under the name is a *state*, not an instruction: with
        // something reading, it says so and when it last looked. With nothing
        // reading there is no state to report, and the hero's own count below
        // already says how much is waiting.
        subtitle={
          auto.enabled ? (
            <WatchingLine
              onBrand
              checking={auto.checking}
              lastCheckedAt={auto.lastCheckedAt}
              now={now}
              locale={locale}
              t={t}
              onRefresh={() => void auto.refresh()}
            />
          ) : undefined
        }
        // With nothing reading, the message path keeps its glyph up here: it
        // is the main way a spend arrives on an iPhone and must not be buried.
        // With a reader running there is no glyph at all — the app is already
        // doing the thing the glyph would offer to do by hand.
        actions={
          auto.enabled
            ? []
            : [
                {
                  icon: 'chatbubble-ellipses-outline',
                  label: t.captures.fromMessage,
                  onPress: () => router.push('/captures/paste'),
                },
              ]
        }
      >
        <View style={{ gap: theme.spacing.md }}>
          {chosenRows.length > 0 ? (
            /* While rows are ticked the panel stops reporting the pile and
               reports the selection instead — the shape every list with a
               selection mode converges on (Todoist, Matter, GitHub, Quo all
               put the count in the header and nothing but actions at the
               bottom). Two things are won by moving it up here. The count is
               a *state*, and a state belongs where this screen already says
               what it is rather than in the band a thumb is aiming at. And
               "select all" stops sitting a few pixels from "not an expense":
               one is a scope control and the other destroys work, and putting
               them in the same row was a mis-tap waiting to be made. */
            <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
              <Text variant="title" tone="onBrand" numberOfLines={1} style={{ flex: 1 }}>
                {plural(locale, chosenRows.length, t.smsInbox.selected)}
              </Text>
              <Button
                label={everythingTicked ? t.smsInbox.selectNone : t.smsInbox.selectAll}
                variant="onBrandOutline"
                size="sm"
                onPress={() => setSelected(everythingTicked ? new Set() : new Set(selectableIds))}
              />
            </Row>
          ) : rows.length > 0 ? (
            <>
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
                {t.captures.heroWaiting}
              </Text>
              {/* The whole screen's figure, not the open tab's: a hero number
                  that changed every time you touched a tab would be part of the
                  tab rather than the screen. Counted the way the tabs count —
                  one per draft, a spoken batch of two counting twice — so the
                  three numbers on this screen agree. And short enough to stay
                  on one line, which "N expenses waiting to be added" was not:
                  at 140 it wrapped and took the panel with it. */}
              <Text variant="title" tone="onBrand" numberOfLines={1}>
                {plural(locale, rows.length, t.captures.batchExpenses)}
              </Text>
            </>
          ) : (
            /* Review is trying to reach this, so the hero says it plainly
               rather than showing a nought. */
            <Text variant="heading" tone="onBrand">
              {t.captures.nothingNeedsYou}
            </Text>
          )}
          {/* No "Save an expense" pill. The raised mic in the bottom bar opens
              a capture from anywhere in the app, and a second door to it was
              standing in the room the panel needed for its number. Bank
              messages keeps its circle: that is a screen nothing else on here
              reaches, and the row in the list below carries the count a circle
              has nowhere to put. */}
          {smsReader ? (
            <Row style={{ alignItems: 'center' }}>
              <HeroActionCircle
                icon="chatbubbles"
                label={t.smsInbox.entryTitle}
                onPress={() => router.push('/captures/sms')}
              />
            </Row>
          ) : null}
        </View>
      </ScreenHero>

      {/* The two errands, pinned between the header and the list exactly as the
          group ledger pins its three — fixed here rather than riding in
          `ListHeaderComponent`, so scrolling never carries the tab bar off the
          top and switching tabs feels instant rather than like a new page.

          Drawn only once there is something to sort: a tab bar over an empty
          screen is two doors to the same nothing. */}
      {rows.length > 0 ? (
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            gap: theme.spacing.sm,
          }}
        >
          <SegmentedTabs
            value={activeTab}
            onChange={(next: ReviewTabId) => {
              setTab(next);
              // A selection belongs to the tab it was made in. Carrying it across
              // would leave rows ticked that are no longer on screen, and "place
              // 6" would act on drafts the person can no longer see.
              setSelected(new Set());
            }}
            tabs={[
              {
                // First, because it is the one this screen opens on: the finite
                // half, the spends this person caught on purpose.
                value: 'added' as ReviewTabId,
                label: countLabel(t.captures.tabAdded, byTab.added.length),
                icon: (color) => (
                  <Ionicons name="create-outline" size={iconSize.md} color={color} />
                ),
              },
              {
                value: 'found' as ReviewTabId,
                // "SMS", on every phone. Everything in this pile carries
                // `source: 'sms'`, which only the message paths write — read off
                // the inbox on an Android that may, pasted in on an iPhone,
                // which cannot at any tier. Either way the thing it was made
                // from was a bank message, so the source is a true name on both
                // and a more useful one than the favour: it says at a glance
                // which half of Review fills itself.
                label: countLabel(t.captures.tabSms, byTab.found.length),
                icon: (color) => (
                  <Ionicons name="chatbubbles-outline" size={iconSize.md} color={color} />
                ),
              },
            ]}
          />
        </View>
      ) : null}

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
        // The group ledger's number, which is the one that has actually been
        // tuned: 1500 was still being outrun by a hard fling down a long list,
        // and blank rows flashing past is the failure people report. ~2500px is
        // three dozen rows ahead, cheap when each row is light to draw.
        drawDistance={2500}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          // Room for whatever is at the foot. With nothing ticked that is the
          // navigation; with something ticked the navigation has stood down and
          // the action bar is there instead, which is two lines taller than the
          // bar it replaced — so the reserve grows rather than swapping.
          paddingBottom: bottomBarStandsDown ? insets.bottom + 176 : clearance,
        }}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.color.brand}
          />
        }
        ListHeaderComponent={bankMessagesRow}
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
                // Only the drafts that actually landed lose their tick. The
                // personal path reports which those are for exactly this
                // reason: clearing the lot up front tells somebody six went
                // when five did, and leaves the sixth on the list with nothing
                // pointing at it. What refused stays ticked, ready to retry.
                void placeInPersonal({
                  lockKey: target.kind === 'capture' ? target.capture.id : target.items[0]!.id,
                  items: target.kind === 'capture' ? [target.capture] : target.items,
                }).then((done) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const id of done) next.delete(id);
                    return next;
                  }),
                );
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

      {/* What a selection can do, in the same bar and the same words the Bank
          messages screen uses — the two screens ask the same question of the
          same kind of pile, and answering it differently in each would make a
          person learn it twice.

          Both buttons hand the ticked rows to machinery that already existed
          for a spoken batch: one destination for several drafts, everybody in,
          split equally. Nothing new decides anything here. */}
      {ticking && chosenRows.length > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            // The navigation is gone while this is up (`suppressTabBar` below),
            // so the bar clears the system's own gesture pill and nothing else.
            // Using the tab-bar clearance here would reserve room for a bar
            // that is not there and leave a band of empty surface.
            paddingBottom: insets.bottom + theme.spacing.md,
            gap: theme.spacing.sm,
            backgroundColor: theme.color.surface,
            borderTopWidth: 1,
            borderTopColor: theme.color.border,
          }}
        >
          {/* One row, and everything in it is an *action*. The count and
              "select all" moved into the panel above, which is what the rest
              of this pattern does everywhere it is done well, and what is left
              down here is the three answers a selection can be given: take
              these off the list, keep them to myself, or put them in a group.

              They are ordered by how much they commit to — the destructive one
              first and smallest, the two placements after it, the likeliest
              last and widest, under the thumb. */}
          <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
            {/* Most of what the app finds is not an expense at all — a card
                bill, a transfer to yourself, rent nobody splits — and that
                answer needs to be one tap for a pile as it is for a row. It
                keeps the words in its accessibility label and in the row's own
                ⋯ sheet, and shows as a glyph here: three labelled buttons on
                one line is a truncation in Tamil and Arabic, and the glyph a
                selection is dismissed with is the one control on this bar a
                person should not be able to hit while reaching for another. */}
            <IconButton
              label={chosenRows.every(wasFound) ? t.captures.notAnExpense : t.captures.delete}
              onPress={() => {
                const items = chosenRows;
                void dismissMany(items);
              }}
            >
              <Ionicons
                name={chosenRows.every(wasFound) ? 'close-circle-outline' : 'trash-outline'}
                size={iconSize.lg}
                color={theme.color.negative}
              />
            </IconButton>
            {/* Only where the private ledger is a place these can go: a guest
                account may not hold one, and a button whose write would be
                refused is worse than no button. */}
            {personalOffered ? (
              <Button
                label={t.voice.justMe}
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() => {
                  const items = chosenRows;
                  // Same rule as the sheet's own "Just me": untick what landed,
                  // leave what refused where a person can see and retry it.
                  void placeInPersonal({ lockKey: items[0]!.id, items }).then((done) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      for (const id of done) next.delete(id);
                      return next;
                    }),
                  );
                }}
              />
            ) : null}
            <Button
              label={plural(locale, chosenRows.length, t.smsInbox.addToGroup)}
              style={{ flex: 1.4 }}
              onPress={() => openAssignBatch(chosenRows)}
            />
          </Row>
        </View>
      ) : null}

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
