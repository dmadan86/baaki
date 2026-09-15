import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import {
  CategoryId,
  computeShares,
  currencySymbol,
  format,
  formatMinorInput,
  guessCategory,
  money,
  MutationKind,
  PayerProblemCode,
  rebalancePayers,
  sanitiseMinorInput,
  serialisePayers,
  validatePayers,
  type CategoryMeta,
  type CurrencyCode,
  type ExpenseLocation,
  type FxRecord,
  type MemberId,
  type PaymentMethod,
  type SplitParams,
} from '@waves/core';
import {
  amountKeyboard,
  Avatar,
  Button,
  Callout,
  Card,
  ChipRow,
  EmptyState,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { CategoryRow, CategorySheet } from '@/components/Category';
import { ExpenseReceipts } from '@/components/ExpenseReceipts';
import { TagEditorSheet } from '@/components/TagEditorSheet';
import { PaymentMethodRow, PaymentMethodSheet } from '@/components/PaymentMethodPicker';
import { LocationField } from '@/components/LocationField';
import { captureLocationIfGranted } from '@/lib/location';
import { friendlyError } from '@/lib/errors';
import { CurrencyRate } from '@/components/CurrencyRate';
import { DescriptionField } from '@/components/expense/DescriptionField';
import { COMMON_CURRENCIES } from '@/lib/currencyChoices';
import { ExpenseHero } from '@/components/expense/ExpenseHero';
import { splitIcon } from '@/components/expense/splitIcon';
import { ChoiceRow, SheetOverlay } from '@/components/expense/SheetOverlay';
import { DetailRow, DetailRows } from '@/components/DetailRows';
import {
  canAddReceipt,
  expenseReceiptPath,
  expenseReceiptUrl,
  scanReceipt,
  scanReceiptText,
  uploadExpenseReceipt,
} from '@/data/api';
import { router } from '@/lib/navigation';
import { receiptCapStatus, receiptTapAction } from '@/lib/receiptCapGate';
import { tripRateFor } from '@/lib/tripRates';
import { StorageCapError } from '@/lib/storage';
import { useAssignCapture, useGroup, useGroupFxRates } from '@/data/hooks';
import { displayName, groupLabel, isGhost, isViewer } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
import { useViewerId } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';
import { handoverKey } from '@/lib/handover';
import { resolveDraftCurrency, resolveDraftFx } from '@/lib/expenseDraft';
import { dateFrom, isoDate, showDate } from '@/lib/expenseDay';
import {
  expenseDateFor,
  expenseDetailsVisible,
  planCollapseToOne,
  planEvenly,
  planToggle,
  planTypedAmount,
  todayIso,
  type PayerPlan,
} from '@/lib/expenseForm';
import { captureReceipt, pickReceiptImage, type PickedImage } from '@/lib/image';
import { recogniseReceipt } from '@/lib/ocr';
import { capturePaymentMethod } from '@/lib/captureAssign';
import { matchMemberNames, stripMemberNames } from '@/lib/voiceExpense';
import {
  entryValues,
  fillEntries,
  formatEntry,
  parseEntry,
  exactRemainder,
  exactValues,
  splitProblem,
  SplitKind,
  type SplitEntries,
} from '@/lib/split';
import { clearDraft, syncEngine, useDraft, useRestoredDraft, useSync } from '@/sync';
import { useDialog } from '@/lib/dialog';

/** Shared empty set — a new one per render would defeat every memo below it. */
const EMPTY_LOCKS: ReadonlySet<MemberId> = new Set();

/**
 * The width of one "paid by" tile.
 *
 * Fixed on purpose: the lane must be the same shape in a group of Hethus as in
 * a group of Lokesh Rangasamys. Just wide enough to clear the 44pt avatar it
 * holds and give a long name somewhere to put its ellipsis — 76 left so much
 * slack around each avatar that four people read as four separated islands
 * rather than one row of faces.
 */
const PAYER_TILE_WIDTH = 60;

/**
 * The press area around this form's small text links — "Split by item", "Paid
 * by several", "Split evenly".
 *
 * They are drawn in `micro`, which is 15 points of line: a symmetric slop of 8
 * left them a ~31pt target, well under the 44 both platforms ask for, and
 * they sit on crowded rows where a miss lands on something else. The vertical
 * slop is the half that matters, so it is the half that grows; widening the
 * sides as well would only steal presses from the control next to them. Slop
 * rather than padding because these links share a line with a heading — padding
 * would push the heading's baseline around.
 */
const LINK_HIT_SLOP = { top: 15, bottom: 15, left: 8, right: 8 } as const;

/** Who paid what, in minor units. */
type PayerMap = ReadonlyMap<MemberId, bigint>;

interface ExpenseDraft {
  amount: string;
  description: string;
  splitKind: SplitKind;
  /**
   * Who paid, before a bill could be paid by several people. Drafts written by
   * an older build still carry it and nothing else, so it is read as a
   * single-payer `payers` map rather than dropped.
   */
  payer?: MemberId | null;
  /** Who paid what, in minor units as decimal strings. */
  payers?: Record<string, string>;
  /** The payers whose figure was typed rather than derived (see rebalancePayers). */
  lockedPayers?: string[];
  /**
   * The currency this expense was paid in, when it differs from the group's.
   * Optional: drafts written before this field existed omit it, which is not
   * the same as an explicit null — see resolveDraftCurrency.
   */
  currency?: string | null;
  /** The stored conversion rate for a foreign-currency expense (ADR-003). */
  fx?: FxRecord | null;
  participants: MemberId[];
  /** Kept apart, because a weight of 1 is not one percent — nor is either of
   *  them ₹1. Optional: drafts written before the exact split existed have no
   *  `exacts`, which reads as an empty set of fields, not as a lost one. */
  weights: SplitEntries;
  percents: SplitEntries;
  exacts?: SplitEntries;
  category: string | null;
  /** The custom tag's display, when `category` is a custom tag (extends TDR §8). */
  categoryMeta: CategoryMeta | null;
  /** Whether the category above was chosen, rather than guessed. */
  categoryChosen: boolean;
  /** Where the spend happened (A43), when the person attached one. */
  location?: ExpenseLocation | null;
}

/**
 * The number beside one person in a weighted or exact split.
 *
 * Its own component for two reasons. The obvious one: three kinds of field with
 * three keypads, three suffixes and three spoken labels is a lot of ternaries to
 * read inside a list of people. The load-bearing one: an exact field is *money*,
 * so it has to sanitise each keystroke against the expense's currency — and
 * doing that in the screen's own render meant `currency` was captured by a
 * closure the React Compiler could not prove safe, which cost the split preview
 * and the params their memoisation ("existing memoization could not be
 * preserved"). Held here, the currency is a prop this component reads, and the
 * screen above keeps its memos.
 */
function SplitEntryField({
  kind,
  currency,
  value,
  onChange,
  name,
}: {
  kind: SplitKind;
  currency: string;
  value: string;
  /** Called with the text as it should be stored — already sanitised for money. */
  onChange: (text: string) => void;
  /** Whose figure this is, for the spoken label. */
  name: string;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  const exact = kind === SplitKind.Exact;
  const percent = kind === SplitKind.Percent;

  return (
    <Row style={{ gap: 2, alignItems: 'center', flexGrow: 0, flexShrink: 0 }}>
      <TextInput
        value={value}
        onChangeText={(text) =>
          // Money is cleaned on the way in — the currency decides whether a
          // decimal point is offered at all, and a second one never lands in the
          // field. A weight or a percentage is stored as typed and judged by
          // `splitProblem`, which refuses rather than trims.
          onChange(exact ? sanitiseMinorInput(text, currency as CurrencyCode) : text)
        }
        keyboardType={
          exact ? amountKeyboard(currency as CurrencyCode) : percent ? 'decimal-pad' : 'number-pad'
        }
        selectTextOnFocus
        placeholder={kind === SplitKind.Shares ? '1' : '0'}
        placeholderTextColor={theme.color.textFaint}
        accessibilityLabel={
          exact
            ? fill(t.expense.exactShareLabel, { name })
            : percent
              ? `${name}'s percentage`
              : `${name}'s shares`
        }
        style={{
          // An amount needs more room than a weight: two decimals and a
          // thousands' worth of digits do not fit in 72.
          width: exact ? 104 : 72,
          // A 44pt floor makes the field a real tap target; `textAlignVertical`
          // keeps the digit centred in the taller box on Android.
          minHeight: 44,
          fontSize: 16,
          fontWeight: '700',
          textAlign: 'right',
          textAlignVertical: 'center',
          color: theme.color.text,
          backgroundColor: theme.color.bg,
          borderRadius: theme.radius.sm,
          paddingVertical: theme.spacing.sm,
          paddingHorizontal: theme.spacing.sm,
        }}
      />
      <Text variant="micro" tone="muted">
        {percent ? '%' : exact ? currencySymbol(currency) : '×'}
      </Text>
    </Row>
  );
}

/** A saved split's integers, back as the text somebody would have typed. */
function textEntries(
  values: Readonly<Record<string, number>>,
  kind: 'shares' | 'percent',
): SplitEntries {
  return Object.fromEntries(
    Object.entries(values).map(([memberId, value]) => [memberId, formatEntry(kind, value)]),
  );
}

/**
 * The travel shortcuts a trip group is offered, in the order they are shown.
 *
 * `none` is not one of them: it is the state of the row before any has been
 * applied, which a strip that always has exactly one chip lit has no other way
 * to say. Nothing is stored under it and it is never an option to tap.
 */

// A route param is not a trusted integer string; a throw here is a white screen.
function safeBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * A custom tag's display arrives from the capture hand-off as a JSON route
 * param. Anything that does not parse to a proper {label, icon, tint} is simply
 * no meta — the expense falls back to a built-in rather than crashing the form.
 */
function parseCategoryMetaParam(value: string | undefined): CategoryMeta | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CategoryMeta>;
    if (parsed && typeof parsed.label === 'string' && typeof parsed.icon === 'string') {
      return {
        label: parsed.label,
        icon: parsed.icon,
        tint: (parsed.tint as CategoryMeta['tint']) ?? 'sky',
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * A capture's location arrives as a JSON route param (A43), the same handoff
 * `categoryMeta` uses. A malformed or out-of-range value is simply no location —
 * a prefill is never worth a crash — so the point is validated to Earth's ranges
 * exactly as the server does before it seeds the form.
 */
function parseLocationParam(value: string | undefined): ExpenseLocation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ExpenseLocation>;
    const lat = typeof parsed?.lat === 'number' ? parsed.lat : NaN;
    const lng = typeof parsed?.lng === 'number' ? parsed.lng : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const name = typeof parsed.name === 'string' ? parsed.name : null;
    return { lat, lng, name };
  } catch {
    return null;
  }
}

export default function AddExpenseScreen() {
  const theme = useTheme();
  // The room the pinned action bar leaves under Save for the system navigation
  // bar. Read here rather than in the bar's style so the whole screen agrees on
  // one number, and so the hook is not buried in a `return`.
  const clearance = useScreenClearance(theme.spacing.md);
  const { t, locale } = useStrings();
  const { confirm } = useDialog();
  // The capture params are the inbox handoff (A34): assigning a capture opens
  // this form prefilled and carries the capture id so a successful save can
  // close it. Absent for every ordinary add or edit, which behave unchanged.
  const {
    id,
    expenseId,
    captureId,
    voice,
    people: voicePeople,
    amount: captureAmount,
    description: captureDescription,
    category: captureCategory,
    categoryMeta: captureCategoryMeta,
    location: captureLocation,
    paymentMethod: capturePayment,
    expenseDate: captureExpenseDate,
    focus,
  } = useLocalSearchParams<{
    id: string;
    expenseId?: string;
    captureId?: string;
    /** '1' when opened from the voice quick-add — seeds amount/description like a capture. */
    voice?: string;
    /** The raw spoken sentence, for matching names to members on a voice hand-off. */
    people?: string;
    amount?: string;
    description?: string;
    category?: string;
    /** A custom tag's {label,icon,tint} snapshot, JSON-encoded, when a capture
     *  tagged with one is being assigned (extends TDR §8). */
    categoryMeta?: string;
    /** The capture's {lat,lng,name} place, JSON-encoded, carried onto the
     *  assigned expense (A43). Absent when the capture had no location. */
    location?: string;
    /** How the capture says it was paid, so assigning keeps it. Absent when the
     *  draft never named one, and on a voice hand-off. */
    paymentMethod?: string;
    expenseDate?: string;
    /** 'amount' when the editor was opened by tapping the total on the expense
     *  screen — the amount field takes focus and raises the keyboard on arrival. */
    focus?: string;
  }>();
  const groupId = id ?? '';

  // Identity for "which member am I", from the session rather than the profile:
  // the session is on the device at launch, the profile is a fetch that lands
  // later, and in the gap `profile?.id` is undefined — which `isViewer` refuses
  // to match, but only if it is given the right thing to compare. See
  // `lib/auth.useViewerId`.
  const viewerId = useViewerId();

  const { group, members, expenses } = useGroup(groupId);
  const groupFxRates = useGroupFxRates(groupId);
  const { mutate } = useSync();
  const assignCapture = useAssignCapture();
  const guard = useGuestGuard();

  const editing = expenses.rows.find((expense) => expense.id === expenseId);

  // The id is chosen here, not by the server. It seeds the remainder rotation
  // (ADR-009), so previewing with one id and writing with another would put the
  // extra paisa on a different person and the server would rightly reject the
  // write as a SHARE_MISMATCH. It is also what lets this expense be created
  // with no network at all (ADR-005).
  const [newExpenseId] = useState(() => randomUUID());
  const targetExpenseId = expenseId ?? newExpenseId;

  // ADR-005: a crash mid-entry must not cost the user their typing.
  const draftKey = `expense:${groupId}:${expenseId ?? 'new'}`;
  const restored = useRestoredDraft<ExpenseDraft>(draftKey);

  const [amount, setAmount] = useState<bigint>(0n);
  const [description, setDescription] = useState('');
  const [splitKind, setSplitKind] = useState<SplitKind>(SplitKind.Equal);
  /**
   * Who put the money in, and how much each of them put in (minor units).
   *
   * A map rather than one id, because "she got the taxi, I got the tickets" is
   * one dinner, not two. Almost every bill has a single entry here and the form
   * behaves exactly as it always did; the moment a second person is tapped, the
   * amounts appear and have to add up to the total — the same rule the SQL
   * trigger and both edge functions enforce (`PAYER_MISMATCH`).
   */
  const [payers, setPayers] = useState<PayerMap>(new Map());
  /** Payers whose figure a person typed. Everyone else absorbs what is left. */
  const [lockedPayers, setLockedPayers] = useState<ReadonlySet<MemberId>>(EMPTY_LOCKS);
  /** What is in each payer's field, so a half-typed "12." survives a render. */
  const [paidText, setPaidText] = useState<Record<MemberId, string>>({});
  /** The `amount:currency` the payer figures were last derived for. */
  const [payersFor, setPayersFor] = useState<string | null>(null);
  /**
   * Whether the payer row is asking about one person or several.
   *
   * It matters because the two need opposite gestures. With one payer a tap has
   * to *replace* — "actually she paid" is the single most common correction on
   * this form and it was one tap before this feature existed, so it stays one
   * tap. With several, a tap has to *add*, or you could never build the list.
   * A control cannot be both, so the mode is explicit and the row says which it
   * is in. A bill that already has several payers is in 'many' whatever the
   * flag says — reopening it must not offer to silently drop one.
   */
  const [payerMode, setPayerMode] = useState<'one' | 'many'>('one');
  // How it was paid — a free-text tag on the expense. Defaults to cash; the
  // picker offers UPI only where the region settles over it.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  // The day the expense is filed under. It opens on the answer `expenseDateFor`
  // has always computed — a capture's own day, a saved expense's own day, or
  // today for a new one — and, now that there is a picker, the person can move
  // it. `null` means "nobody has touched it", which is what keeps an edit from
  // re-filing an expense it did not mean to move.
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [editingDate, setEditingDate] = useState(false);
  const [participants, setParticipants] = useState<MemberId[]>([]);
  // What was typed into each member's field, as text. Two maps, not one: the
  // same person is "2 shares" and "40%", and switching between the two must not
  // reinterpret one number as the other.
  const [weights, setWeights] = useState<SplitEntries>({});
  const [percents, setPercents] = useState<SplitEntries>({});
  // The exact split's fields: money as typed, one line per person. Kept apart
  // from the two weighted maps for the same reason those are kept apart from
  // each other — 1 is not one percent, and neither of them is ₹1.
  const [exacts, setExacts] = useState<SplitEntries>({});
  // Guessed from the description until somebody picks one themselves, at which
  // point the guess must stop moving it — see `categoryChosen`.
  // A built-in id or a custom tag's id; `categoryMeta` carries a custom tag's
  // display so it rides onto the expense for every member (extends TDR §8).
  const [category, setCategory] = useState<string | null>(CategoryId.Food);
  const [categoryMeta, setCategoryMeta] = useState<CategoryMeta | null>(null);
  const [categoryChosen, setCategoryChosen] = useState(false);
  // The create-tag sheet, opened from the category sheet's "＋ New tag" row.
  const [editingTag, setEditingTag] = useState(false);
  // The two "more details" rows open their options in sheets, and those sheets
  // are rendered at the screen root rather than beside their rows: the sheet is
  // absolutely positioned against its nearest positioned ancestor, and a row
  // inside the scroll view would anchor it to the scrolled content instead of
  // the screen. The same reason the currency sheet lives down there.
  const [pickingCategory, setPickingCategory] = useState(false);
  const [pickingPayment, setPickingPayment] = useState(false);
  /**
   * Names to bias the recogniser towards. "You" and "Someone" are placeholders
   * this screen prints, not things anybody says out loud, so they would only
   * teach it to hear the wrong word.
   */
  const nameHints = useMemo(
    () =>
      (members.data ?? [])
        .map((member) => displayName(member, viewerId))
        .filter((name) => name !== 'You' && name !== 'Someone'),
    [members.data, viewerId],
  );

  const [expenseCurrency, setExpenseCurrency] = useState<string | null>(null);
  const [fx, setFx] = useState<FxRecord | null>(null);
  // The currency is chosen from the header pill's sheet, the same shortlist the
  // capture screen offers. Picking one clears any rate typed for the old
  // currency, exactly as the old in-card chips did (see CurrencyRate.choose).
  const [pickingCurrency, setPickingCurrency] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  /** Set once a scan has read line items, so the offer to itemize is real. */
  const [scannedItems, setScannedItems] = useState(0);
  // The kept bill for this expense (E2): a URI to show as the thumbnail, and the
  // R2 storage path the viewer resolves from. Both null until a scan or attach
  // uploads one, or the seeding probe below finds one an earlier edit already
  // kept — a group receipt in R2 is group-readable, so it survives a reinstall
  // and shows on any member's device. The thumbnail URI is the local image just
  // after a capture, and the signed R2 URL once reloaded.
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  // The picked bill, held until the expense is saved. Uploading on save (not on
  // pick) means an add that is abandoned never leaves an orphaned object in R2.
  const [pendingReceipt, setPendingReceipt] = useState<PickedImage | null>(null);

  // Where the spend happened (A43). Optional and opt-in: null until the person
  // taps "Add location" and grants the permission. Kept in the draft so a crash
  // mid-entry does not lose it, and seeded from the version when editing.
  const [location, setLocation] = useState<ExpenseLocation | null>(null);
  // Whether the one-shot auto-capture below has run for this screen. A ref, not
  // state: it guards the attempt to a single run without itself forcing a render
  // (and without a synchronous setState inside the effect).
  const autoLocatedRef = useRef(false);

  // The per-group receipt ceiling. A group holds a few receipts for free (the
  // number is an admin knob); past it, scanning is a paid feature. A paid group
  // has no cap. This only draws the affordance — the server enforces the same
  // rule when it records the receipt.
  const receiptCap = useQuery({
    queryKey: ['receiptCap', groupId],
    queryFn: () => canAddReceipt(groupId),
  });
  // A failed fetch must not lock a scan the server would allow: an undefined
  // answer that is no longer loading is treated as allowed, and the server is
  // the real boundary if it turns out the group was capped after all.
  const capStatus = receiptCap.isError
    ? 'allowed'
    : receiptCapStatus(receiptCap.data, receiptCap.isLoading);
  const capLocked = capStatus === 'locked';
  const queryClient = useQueryClient();

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => isViewer(member, viewerId))?.id ?? null,
    [members.data, viewerId],
  );

  // Seed the kept bill from R2 when reopening an expense that already has one
  // (E2). `expenseReceiptUrl` doubles as the existence check — it returns null
  // when nothing was ever kept, so a signed URL here both proves the receipt
  // exists and gives the thumbnail something to show. Runs once per expense.
  useEffect(() => {
    // Only an existing expense can already have a kept bill; a brand-new one's id
    // has never been uploaded to, so there is nothing to probe for.
    if (!expenseId) return;
    let active = true;
    void (async () => {
      const url = await expenseReceiptUrl(groupId, expenseId);
      if (!active || !url) return;
      setReceiptUri(url);
      setReceiptPath(expenseReceiptPath(groupId, expenseId));
    })();
    return () => {
      active = false;
    };
  }, [groupId, expenseId]);

  // Seed the form once the group has loaded: I paid, everyone splits — or the
  // current version's values when editing. Done during render (React's
  // "adjust state when the input changes" pattern) so the form never flashes
  // empty before the data arrives.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  /**
   * Seed the payer side as one person holding the whole bill — the state every
   * new expense starts in, and the state an older draft or a single-payer bill
   * comes back as. Written as a helper because the seeding block below reaches
   * it from four branches, and because the three pieces (who, how much, what the
   * field shows) have to move together or the form opens with a figure that does
   * not match the total.
   */
  const seedSolePayer = (memberId: MemberId | null, total: bigint): void => {
    if (!memberId) {
      setPayers(new Map());
      setLockedPayers(EMPTY_LOCKS);
      setPaidText({});
      return;
    }
    setPayers(new Map([[memberId, total]]));
    setLockedPayers(EMPTY_LOCKS);
    setPaidText({});
  };

  const seedKey =
    members.data && !restored.loading ? (editing?.currentVersion?.id ?? `new:${groupId}`) : null;
  if (seedKey && seedKey !== seededFor) {
    setSeededFor(seedKey);
    const version = editing?.currentVersion;
    const draft = restored.draft;
    if ((captureId || voice) && !editing) {
      // Seeded from a capture (A34) or the voice quick-add: the passed amount and
      // description fill the form ahead of any stale draft, since arriving here
      // that way is an explicit choice to turn what was captured or spoken into
      // this expense.
      setAmount(safeBigInt(captureAmount));
      const memberRows = members.data ?? [];
      // Voice may name who to split with. Match those names to members and keep
      // the payer in; anything else — a capture, or a sentence naming nobody —
      // takes the ordinary default of everyone. The names that became rows are
      // taken out of the description, which is only what was spent on.
      const named =
        voice && voicePeople
          ? matchMemberNames(
              voicePeople,
              memberRows.map((member) => ({
                id: member.id,
                name: displayName(member, viewerId),
              })),
            )
          : [];
      const chosen =
        named.length > 0
          ? myMemberId && !named.includes(myMemberId)
            ? [...named, myMemberId]
            : named
          : memberRows.map((member) => member.id);
      setParticipants(chosen);
      setDescription(
        voice
          ? stripMemberNames(
              captureDescription ?? '',
              memberRows.map((member) => ({
                id: member.id,
                name: displayName(member, viewerId),
              })),
            )
          : (captureDescription ?? ''),
      );
      setCategory(captureCategory || null);
      // A capture tagged with a custom tag carries its display as a JSON param,
      // so the assigned expense keeps the same tag rather than dropping to a
      // built-in. A malformed param is simply no meta (a built-in).
      setCategoryMeta(parseCategoryMetaParam(captureCategoryMeta));
      setCategoryChosen(Boolean(captureCategory));
      // Carry the capture's place onto the expense it becomes (A43).
      setLocation(parseLocationParam(captureLocation));
      // And how the draft says it was paid, so assigning does not quietly turn a
      // card payment into cash. A voice hand-off carries none and keeps the
      // default; anything the ledger does not know falls back to it too.
      setPaymentMethod(capturePaymentMethod(capturePayment));
      seedSolePayer(myMemberId, safeBigInt(captureAmount));
    } else if (draft) {
      // A draft outranks the saved version: it is what the user was in the
      // middle of writing when the app went away.
      setAmount(safeBigInt(draft.amount));
      setDescription(draft.description);
      setSplitKind(draft.splitKind);
      // The payer picker is on the edit form too now, so a draft's payers are a
      // change somebody was in the middle of making rather than stale values to
      // discard. `payers` is the current shape; `payer` is what an older build
      // wrote, and is read as a bill paid entirely by that one person.
      const draftAmount = safeBigInt(draft.amount);
      if (draft.payers && Object.keys(draft.payers).length > 0) {
        setPayers(new Map(Object.entries(draft.payers).map(([id, v]) => [id, safeBigInt(v)])));
        setLockedPayers(new Set(draft.lockedPayers ?? []));
        // `groupCurrency` is derived further down the render; the seeding block
        // runs above it, so the group's default is read straight off the row.
        const draftCurrency = draft.currency ?? group.data?.default_currency ?? 'INR';
        setPaidText(
          Object.fromEntries(
            Object.entries(draft.payers).map(([id, v]) => [
              id,
              formatMinorInput(safeBigInt(v), draftCurrency as CurrencyCode),
            ]),
          ),
        );
        setPayersFor(`${draftAmount}:${draftCurrency}`);
      } else {
        seedSolePayer(draft.payer ?? version?.payers[0]?.member_id ?? myMemberId, draftAmount);
      }
      setExpenseCurrency(resolveDraftCurrency(draft.currency, version?.currency ?? null));
      setFx(resolveDraftFx(draft.fx));
      setParticipants(draft.participants);
      setWeights(draft.weights ?? {});
      setPercents(draft.percents ?? {});
      setExacts(draft.exacts ?? {});
      setCategory(draft.category ?? null);
      setCategoryMeta(draft.categoryMeta ?? null);
      setCategoryChosen(draft.categoryChosen ?? false);
      setLocation(draft.location ?? null);
    } else if (version) {
      setAmount(BigInt(version.amount));
      setDescription(version.description);
      // A saved category is a decision somebody already made. Re-guessing it on
      // open would quietly rewrite their answer.
      setCategory(version.category ?? null);
      setCategoryMeta((version.category_meta as CategoryMeta | null) ?? null);
      setCategoryChosen(version.category !== null);
      // The expense keeps the currency it was paid in — without this, editing a
      // foreign-currency expense reopened on the group currency and quietly
      // rewrote it. The stored rate is not in the read model, so a foreign
      // expense asks for its rate again on save.
      setExpenseCurrency(version.currency);
      setFx(null);
      // Every payer the bill records, not just the first. Flattening a
      // several-payer bill to `payers[0]` on open — and then saving that back —
      // was how an edit silently rewrote who had put money in. They come back
      // locked: those figures are recorded facts, so they survive a change to
      // the total rather than being quietly re-divided.
      if (version.payers.length > 0) {
        setPayers(new Map(version.payers.map((row) => [row.member_id, BigInt(row.amount)])));
        setLockedPayers(
          version.payers.length > 1
            ? new Set(version.payers.map((row) => row.member_id))
            : EMPTY_LOCKS,
        );
        setPaidText(
          Object.fromEntries(
            version.payers.map((row) => [
              row.member_id,
              formatMinorInput(BigInt(row.amount), version.currency as CurrencyCode),
            ]),
          ),
        );
        setPayersFor(`${BigInt(version.amount)}:${version.currency}`);
      } else {
        seedSolePayer(myMemberId, BigInt(version.amount));
      }
      setPaymentMethod((version.payment_method as PaymentMethod | null) ?? 'cash');
      // A saved place is a decision already made; reopen the edit with it intact
      // so a save does not silently drop it.
      setLocation(version.location ?? null);
      setParticipants(version.shares.map((share) => share.member_id));
      setSplitKind(
        version.split_type === 'percent'
          ? SplitKind.Percent
          : version.split_type === 'shares'
            ? SplitKind.Shares
            : version.split_type === 'exact'
              ? SplitKind.Exact
              : SplitKind.Equal,
      );
      // The numbers somebody chose the first time, back in the fields they were
      // typed into — an edit that silently re-divided them equally would be a
      // worse lie than refusing to open.
      const params = version.split_params;
      if (params.kind === 'shares') {
        setWeights(textEntries(params.weights, 'shares'));
      } else if (params.kind === 'percent') {
        setPercents(textEntries(params.basisPoints, 'percent'));
      } else if (params.kind === 'exact') {
        setExacts(
          Object.fromEntries(
            Object.entries(params.amounts).map(([memberId, minor]) => [
              memberId,
              formatMinorInput(BigInt(minor), version.currency as CurrencyCode),
            ]),
          ),
        );
      }
    } else {
      setParticipants((members.data ?? []).map((member) => member.id));
      seedSolePayer(myMemberId, 0n);
    }
  }

  // The guess follows the description while it is being typed, and stops the
  // moment a chip is tapped. Keyed by the text it was made from so it runs once
  // per description rather than once per render.
  const [guessedFrom, setGuessedFrom] = useState<string | null>(null);
  if (seededFor !== null && !categoryChosen && description !== guessedFrom) {
    setGuessedFrom(description);
    // Keep the current category when the text matches no bucket: guessCategory
    // returns null for unrecognised descriptions, and clearing on null would
    // wipe the Food & drink default (or an earlier guess).
    const guess = guessCategory(description);
    if (guess) {
      setCategory(guess);
      // The guess is always a built-in, so it carries no custom snapshot.
      setCategoryMeta(null);
    }
  }

  // Everybody in a weighted split needs a number to start from, and the set
  // changes as people are ticked on and off. `fillEntries` returns null once
  // there is nothing left to fill, which is what stops this looping.
  if (splitKind === SplitKind.Shares) {
    const filled = fillEntries('shares', weights, participants);
    if (filled) setWeights(filled);
  } else if (splitKind === SplitKind.Percent) {
    const filled = fillEntries('percent', percents, participants);
    if (filled) setPercents(filled);
  }

  const entries =
    splitKind === SplitKind.Shares ? weights : splitKind === SplitKind.Exact ? exacts : percents;
  const setEntry = (memberId: MemberId, text: string): void => {
    const update = (current: SplitEntries): SplitEntries => ({ ...current, [memberId]: text });
    if (splitKind === SplitKind.Shares) setWeights(update);
    else if (splitKind === SplitKind.Exact) setExacts(update);
    else setPercents(update);
  };

  // The split used to fold into a one-line summary card, opening itself when the
  // configuration was not the "I paid, split equally" default. The fold is gone:
  // the three controls (how to split, who paid, who is in) stand open under a
  // plain heading, so changing a split is the tap that changes it rather than a
  // tap to open, then a tap to change.

  // "More details" folds category, payment method, location and the FX rate off
  // the common path. It opens itself whenever one of those carries a non-default
  // value, so an edit (or a foreign currency, whose rate must be typed to save)
  // is not hidden behind the fold on arrival.
  //
  // `null` means "nobody has said": follow that rule. A tap replaces it with a
  // decision, in either direction. It used to be a plain boolean OR-ed with the
  // rule, and the header was disabled while the rule said open — so on a bill
  // that carried any detail, "Fewer details" sat there looking tappable and did
  // nothing.
  const [detailsChoice, setDetailsChoice] = useState<boolean | null>(null);

  const groupCurrency = group.data?.default_currency ?? 'INR';
  // The expense keeps the currency it was paid in; the group's is only the
  // default and what a converted total would be shown in (ADR-003).
  const currency = expenseCurrency ?? groupCurrency;
  // The rate the trip has pinned for whatever this bill is in, if it has pinned
  // one (`components/TripRates`). It is a default for the rate field below and
  // nothing more — the bill can still carry its own, and whichever rate is on
  // the expense when it saves is the one it keeps (ADR-003).
  //
  // Only ever on a *new* bill. A saved expense's own rate is not in the read
  // model (see the edit branch above, which is why a foreign expense asks for
  // its rate again), so defaulting one here would put the trip's number on a
  // bill that was written with a different one and re-price it on save —
  // quietly, in the one place this feature promised never to touch. Until the
  // stored rate is readable, an edit asks, exactly as it did before.
  const tripRate = editing ? null : tripRateFor(groupFxRates.data ?? [], currency, groupCurrency);

  // ───────────────────────────────────────────────────────── who paid ──
  //
  // One payer is the whole of the common case and stays a single tap. The
  // moment a second person is added, the figures have to add up to the total —
  // the ledger has always allowed several payer rows, and both edge functions
  // reject a write whose rows do not sum to the amount.
  // The day this expense is filed under, picked or inherited (expenseDateFor).
  const expenseDate = expenseDateFor({
    picked: pickedDate,
    captureDate: captureId ? captureExpenseDate : null,
    savedDate: editing?.currentVersion?.expense_date,
    today: todayIso(),
  });

  const applyDate = (event: DateTimePickerEvent, picked?: Date): void => {
    // Android's dialog dismisses itself; iOS keeps the spinner on the screen.
    if (Platform.OS === 'android') setEditingDate(false);
    if (event.type === 'dismissed' || !picked) return;
    setPickedDate(isoDate(picked));
  };

  const payerIds = [...payers.keys()];
  // With one payer there is nothing to hold constant: that person carries the
  // whole bill by definition, so a lock left over from a moment when there were
  // two must not survive and strand the total.
  const effectiveLocks = payers.size <= 1 ? EMPTY_LOCKS : lockedPayers;
  const payerProblem = validatePayers(amount, payers);
  // A bill that already records several payers is in several-payer mode however
  // the flag was left — an edit must never offer to quietly drop one of them.
  const manyPayers = payerMode === 'many' || payers.size > 1;
  // The chooser's order: whoever is paying, then everybody else, each keeping
  // the group's own order within their half (`sort` is stable). The lane scrolls
  // sideways, so without this a payer picked from the end of a long member list
  // would be the one thing on the screen you cannot see.
  const payerChoices = useMemo(() => {
    const rows = members.data ?? [];
    return [...rows].sort((a, b) => Number(payers.has(b.id)) - Number(payers.has(a.id)));
  }, [members.data, payers]);

  /** Re-derive the figures, then refresh every field except the typed ones. */
  const applyPayers = (
    selected: readonly MemberId[],
    current: PayerMap,
    locked: ReadonlySet<MemberId>,
    total: bigint,
    typed?: { readonly member: MemberId; readonly text: string },
  ): void => {
    const effective = selected.length <= 1 ? EMPTY_LOCKS : locked;
    const next = rebalancePayers({
      amount: total,
      selected,
      current,
      locked: effective,
      // The expense id, so which payer absorbs an odd paisa is stable across
      // devices and across reopening the form (ADR-009).
      seed: targetExpenseId,
    });
    setPayers(next);
    setLockedPayers(effective);
    setPayersFor(`${total}:${currency}`);
    setPaidText(() => {
      const fields: Record<MemberId, string> = {};
      for (const [member, paid] of next) {
        // A typed field keeps the characters that were typed — reformatting
        // "12." to "12.00" mid-keystroke moves the caret out from under a thumb.
        fields[member] =
          typed && typed.member === member
            ? typed.text
            : formatMinorInput(paid, currency as CurrencyCode);
      }
      return fields;
    });
  };

  /**
   * Carry out a plan from `expenseForm` — the pure half of every payer gesture.
   * Null means the gesture is a no-op, which is why each of them can be a
   * single line below.
   */
  const run = (plan: PayerPlan | null): void => {
    if (!plan) return;
    applyPayers(plan.selected, plan.current, plan.locked, amount, plan.typed);
  };

  /**
   * Tap a member. In one-payer mode that replaces whoever was there; in
   * several-payer mode it adds or removes them.
   */
  const togglePayer = (memberId: MemberId): void => {
    // Null is the tap that does nothing — the last payer cannot be removed.
    run(planToggle({ many: manyPayers, payers, locked: effectiveLocks, amount, memberId }));
  };

  /**
   * Switch between the two. Going to several splits the paying evenly between
   * whoever is there so the figures start out adding up; coming back keeps the
   * person who put in the most and hands them the whole bill, because dropping
   * the largest contributor is the one collapse nobody means.
   */
  const setManyPayers = (many: boolean): void => {
    if (many || payers.size <= 1) {
      setPayerMode(many ? 'many' : 'one');
      return;
    }
    const plan = planCollapseToOne({ payers, amount });
    if (!plan) return;
    const keeping = plan.selected[0]!;
    const member = (members.data ?? []).find((row) => row.id === keeping);
    const name = member ? displayName(member, viewerId) : t.misc.someone;
    // Collapsing is not undoable inside the form: going back to several payers
    // re-divides evenly, so the figures somebody typed are gone either way. On
    // a bill that already records several payers those figures are recorded
    // facts, and this is a text link sitting next to an ordinary one — near
    // enough to a save button to be worth a question first.
    void confirm({
      title: t.expense.collapsePayersTitle,
      body: fill(t.expense.collapsePayersBody, { name }),
      confirmLabel: t.expense.collapsePayersConfirm,
      cancelLabel: t.cancel,
      tone: 'danger',
    }).then((ok) => {
      if (!ok) return;
      setPayerMode('one');
      run(plan);
    });
  };

  // Who may add or remove a bill against this expense: a party to it (its author
  // or one of its payers), which is what the attach RPCs enforce. An admin who is
  // not a party may still remove the legacy group-visible bill — the same split
  // of powers the expense screen applies.
  const editingVersion = editing?.currentVersion;
  const isExpenseParty = Boolean(
    myMemberId &&
    editingVersion &&
    (editingVersion.author_member_id === myMemberId ||
      editingVersion.payers.some((row) => row.member_id === myMemberId)),
  );
  const iAmGroupAdmin =
    (members.data ?? []).find((row) => isViewer(row, viewerId))?.role === 'admin';

  /** A figure typed against one payer. Typing locks it; the others absorb. */
  const setPaidEntry = (memberId: MemberId, text: string): void => {
    run(
      planTypedAmount({
        payers,
        locked: effectiveLocks,
        memberId,
        text,
        currency: currency as CurrencyCode,
      }),
    );
  };

  /** Back to an even split of the paying — the way out of any tangle above. */
  const splitPaidEvenly = (): void => {
    run(planEvenly(payers));
  };

  // Keep the figures answering to the total. React's "adjust state when the
  // input changes" pattern — the same one the seeding above uses — rather than
  // an effect, so a scan that fills in ₹1,240 re-splits the paying in the very
  // render that shows the new total, with no frame in between where the payers
  // and the amount disagree. Typed figures survive it: only the unlocked ones
  // move (see rebalancePayers).
  const payersKey = `${amount}:${currency}`;
  if (seededFor !== null && payers.size > 0 && payersKey !== payersFor) {
    applyPayers(payerIds, payers, effectiveLocks, amount);
  }

  // Picking from the header pill: a rate typed for the previous currency would
  // convert the wrong thing (and the server rejects it), so clear it — the same
  // reset the old in-card currency chips did.
  const chooseCurrency = (code: string): void => {
    setExpenseCurrency(code);
    setFx(null);
    setPickingCurrency(false);
  };

  // Every keystroke, debounced just enough to avoid one write per character.
  useDraft<ExpenseDraft>(
    draftKey,
    {
      amount: amount.toString(),
      description,
      splitKind,
      payers: Object.fromEntries([...payers].map(([id, paid]) => [id, paid.toString()])),
      lockedPayers: [...lockedPayers],
      currency: expenseCurrency,
      fx,
      participants,
      weights,
      percents,
      exacts,
      category,
      categoryMeta,
      categoryChosen,
      location,
    },
    { enabled: seededFor !== null },
  );

  // Auto-stamp the current place on a brand-new expense (A43 follow-up), but
  // only ever when the person already granted location on an earlier explicit
  // "Add location" — opening this form must never raise a system prompt (the
  // deferred-permission stance `lib/location` is built around). It runs once,
  // never on an edit (that expense's place is a decision already made, and it
  // may have happened elsewhere), never over a capture/voice/draft that already
  // carried a place, and never over a pin set (or cleared) by hand: the
  // functional set below drops the fix if a value appeared meanwhile. A denied
  // or unavailable fix is simply no location, exactly as before.
  useEffect(() => {
    if (autoLocatedRef.current || seededFor === null) return;
    if (editing || captureId || voice) return;
    // One attempt, whatever the outcome — clearing the pin by hand is never
    // undone, and a draft/seed that already placed it (checked next) is left be.
    autoLocatedRef.current = true;
    if (location) return;
    let active = true;
    void captureLocationIfGranted().then((loc) => {
      // Never override a place set in the meantime — only fill an empty pin.
      if (active && loc) setLocation((current) => current ?? loc);
    });
    return () => {
      active = false;
    };
  }, [seededFor, editing, captureId, voice, location]);

  const splitParams: SplitParams = useMemo(() => {
    if (splitKind === SplitKind.Shares) {
      return { kind: 'shares', weights: entryValues('shares', weights, participants) };
    }
    if (splitKind === SplitKind.Percent) {
      return { kind: 'percent', basisPoints: entryValues('percent', percents, participants) };
    }
    if (splitKind === SplitKind.Exact) {
      return {
        kind: 'exact',
        amounts: exactValues(exacts, participants, currency),
      };
    }
    return { kind: 'equal' };
  }, [splitKind, weights, percents, exacts, currency, participants]);

  // Preview with the same engine the server uses; if they ever disagree the
  // server wins and tells us why (SHARE_MISMATCH).
  const preview = useMemo(() => {
    if (participants.length === 0 || amount === 0n) return null;
    try {
      return computeShares({
        amount,
        currency,
        params: splitParams,
        participants,
        seed: targetExpenseId,
      });
    } catch {
      return null;
    }
  }, [amount, currency, splitParams, participants, targetExpenseId]);

  // What is still unassigned in an exact split, signed like the payer side's
  // delta: positive is left to hand out, negative is more than the bill. Only
  // worth saying once there is a bill to measure against — "₹0 left" over an
  // empty form is noise, not guidance.
  const exactLeft =
    splitKind === SplitKind.Exact && amount > 0n
      ? exactRemainder(exacts, participants, currency, amount)
      : 0n;
  const exactIssue =
    splitKind !== SplitKind.Exact || amount === 0n || participants.length === 0 || exactLeft === 0n
      ? null
      : (exactLeft > 0n ? t.expense.paidLeftToAssign : t.expense.paidOverAssigned).replace(
          '{amount}',
          format(money(exactLeft < 0n ? -exactLeft : exactLeft, currency), { locale }),
        );
  // The exact split's own complaint takes precedence: it is about money, and the
  // weighted check has nothing to say about a set of typed amounts.
  const splitIssue = exactIssue ?? splitProblem(splitKind, entries, participants);

  if (group.isLoading || members.isLoading || restored.loading) {
    // Shell first: the back button and title paint instantly on navigation, and
    // only the form body waits on the mirror read (a few ms at launch). A bare
    // full-screen spinner used to leave a headerless blank while it loaded.
    return (
      <Screen edges={[]}>
        <StatusBar style="light" />
        {/* The same hero the loaded form opens on, so the panel does not repaint
            from a white bar to a purple one once the mirror read lands. */}
        <ExpenseHero
          title={editing ? t.expense.edit : t.addExpense}
          category={category}
          categoryMeta={categoryMeta}
          description={description}
          currency={currency}
          amount={amount}
          onAmountChange={setAmount}
          onPressCurrency={() => setPickingCurrency(true)}
        />
        <View style={{ paddingTop: theme.spacing.xxxl, alignItems: 'center' }}>
          <ActivityIndicator color={theme.color.brand} />
        </View>
      </Screen>
    );
  }

  if (!group.data) {
    return (
      <Screen>
        <EmptyState title={t.group.notFound} body={t.group.notFoundArchived} />
      </Screen>
    );
  }

  const submit = async (): Promise<void> => {
    // Read-only once the guest trial is up (ADR-006 addendum): the group and its
    // history stay visible, but a new or edited expense sends them to sign up.
    if (guard.blockWrite()) return;
    setError(null);
    // The same check the server makes. Catching it here means a bill that does
    // not add up is a sentence under the button rather than a PAYER_MISMATCH
    // that comes back minutes later off a queue.
    if (payerProblem) {
      setError(payerMessage);
      return;
    }
    setSaving(true);
    try {
      // Straight into the durable queue: this returns as soon as the mutation
      // is on disk, so the expense is saved whether or not there is a network.
      // The bill image, if any, was uploaded to R2 the moment it was scanned or
      // attached (persistReceipt) — the ledger write carries only the money.
      await mutate(expenseId ? MutationKind.ExpenseUpdate : MutationKind.ExpenseCreate, groupId, {
        expenseId: targetExpenseId,
        // Blank stays blank. Writing the English word "Expense" here made every
        // undescribed row identical in the list, and put a word nobody typed
        // into an append-only ledger, the CSV export and the notification text —
        // in one language, for an app that speaks four.
        description: description.trim(),
        category,
        categoryMeta,
        // A chosen day wins outright. Untouched, a capture keeps the day it was
        // caught, a saved expense keeps the day it has, and only a new one is
        // today's (expenseDateFor).
        expenseDate: expenseDate,
        currency,
        amount: amount.toString(),
        fx,
        splitParams,
        participants,
        // Every payer, with anybody down for nothing left out (serialisePayers).
        payers: serialisePayers(payers),
        paymentMethod,
        location,
        expectedShares: preview
          ? Object.fromEntries([...preview].map(([id, share]) => [id, share.toString()]))
          : undefined,
        // Lets the server tell a concurrent edit from a normal one (TDR §4.4).
        baseVersionNo: editing?.currentVersion?.version_no ?? null,
      });
      await clearDraft(draftKey);
      // The expense exists now; closing the capture removes it from the inbox
      // and records which expense it became (A34). Done before leaving so a
      // successful save never leaves the capture orphaned in the list.
      if (captureId) {
        await assignCapture.mutateAsync({ captureId, groupId, expenseId: targetExpenseId });
      }

      // Only now — the expense is saved — does the kept bill go to R2, so an
      // abandoned add never orphans an object. The upload is best-effort and
      // never un-saves the money: on failure the person is told why (an over-cap
      // refusal points at the upgrade) and left on the screen, where saving again
      // re-attempts the upload (the money write is idempotent by expense id),
      // rather than being navigated away with the bill silently lost.
      if (pendingReceipt) {
        try {
          await uploadExpenseReceipt({
            groupId,
            expenseId: targetExpenseId,
            base64: pendingReceipt.base64,
            mimeType: pendingReceipt.mimeType,
          });
          setPendingReceipt(null);
        } catch (uploadError) {
          setScanNote(uploadError instanceof StorageCapError ? t.storage.full : t.couldNotSave);
          return;
        }
      }

      router.back();
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'expense.save'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * What this person is down for, in money, as the number beside their name
   * changes.
   *
   * The preview is the ledger's own arithmetic and is what gets saved, so it
   * wins whenever it exists. It does not exist while the percentages are still
   * short of 100 — `computeShares` refuses that, rightly — and staying blank
   * until the last field is right hides the one number somebody is typing
   * towards. So the incomplete case falls back to this line's own share of the
   * total: 20% of ₹300 is ₹60 whatever the other rows say, and the message
   * under the list is what says the column does not add up yet.
   */
  const lineAmount = (memberId: MemberId): bigint => {
    const previewed = preview?.get(memberId);
    if (previewed !== undefined) return previewed;
    if (splitKind !== SplitKind.Percent) return 0n;
    const basisPoints = parseEntry('percent', percents[memberId] ?? '') ?? 0;
    return (amount * BigInt(basisPoints)) / 10000n;
  };

  /**
   * Keep the bill (E2): upload it to the group's R2 storage under the expense id
   * (A44), so any member can open it later and the owner can from any device. A
   * group receipt in R2 is group-readable — the `r2-sign` edge authorises a read
   * by group membership — which is the visibility the old E3 "share" toggle used
   * to arrange by hand. The image counts against the group's storage ceiling
   * (ADR-011); only the money rides the expense sync.
   *
   * The local image is shown as the thumbnail at once; the bytes are held and
   * only uploaded to R2 once the expense is saved ({@link submit}), so an add the
   * person abandons never leaves an orphaned object behind.
   */
  const stageReceipt = (picked: PickedImage): void => {
    setReceiptUri(picked.uri);
    setReceiptPath(expenseReceiptPath(groupId, targetExpenseId));
    setPendingReceipt(picked);
  };

  /**
   * Attach a bill the person already has (E1).
   *
   * The escape hatch for when scanning is the wrong tool: the bill is a
   * screenshot of a delivery order, a PDF photographed earlier, or a scan that
   * failed and they would rather attach the picture in their gallery. Unlike a
   * scan it never hits the metered `receipt-parse` path — nothing is recorded
   * server-side, so it does not count against the group's receipt cap and is
   * offered even when the cap is reached. The image is kept and the amount stays
   * theirs to type.
   */
  const attach = async (): Promise<void> => {
    setError(null);
    setScanNote(null);
    let picked: PickedImage | null = null;
    try {
      picked = await pickReceiptImage();
    } catch {
      picked = null;
    }
    if (!picked) return;
    stageReceipt(picked);
  };

  /**
   * Photograph the bill, fill in the two fields somebody was about to type.
   *
   * This screen deliberately does not become an itemizing screen. Most bills
   * are split some way that has nothing to do with what each line cost, and a
   * scan that dragged everybody into claiming items would be worse than typing
   * a total. What it takes is the grand total and the merchant's name; the
   * lines it read are handed to the itemize screen, which is one tap away for
   * the times that matters.
   *
   * ADR-008 still holds: the model proposes and the person confirms. Nothing
   * saves itself, and the amount lands in the same field, editable.
   */
  const scan = async (): Promise<void> => {
    // The cap decides the button below, but guard here too: a scan is not free
    // to start (the camera, the OCR, the metered call), and the server would
    // refuse to record it anyway.
    if (receiptTapAction(capStatus) !== 'scan') return;
    setError(null);
    setScanNote(null);
    let picked: Awaited<ReturnType<typeof captureReceipt>> = null;
    try {
      picked = await captureReceipt();
    } catch {
      picked = null;
    }
    if (!picked) return;
    setScanning(true);
    try {
      // Read the text on the phone first: the photograph never leaves the
      // device when it works, and it costs about a tenth as much. A dark or
      // blurred bill falls back to sending the image, which reads it better.
      const recognised = await recogniseReceipt(picked.uri);
      const result = recognised
        ? await scanReceiptText({ groupId, rawText: recognised.text, currency, source: 'camera' })
        : await scanReceipt({
            groupId,
            base64: picked.base64,
            mimeType: picked.mimeType,
            currency,
          });

      if (result.parsed.grandTotal > 0) setAmount(BigInt(result.parsed.grandTotal));
      if (result.parsed.merchant && !description.trim()) setDescription(result.parsed.merchant);
      setScannedItems(result.parsed.items.length);

      // Keep the photographed bill too (E2): upload it to the group's R2 storage
      // so the owner and every member can view it later. The scan's own server
      // receipt is a separate thing (the metered parse); this is the kept copy.
      stageReceipt(picked);

      // Kept for the itemize screen in case they want it. Nobody should have to
      // photograph the same bill twice, and a scan is metered (ADR-011).
      void syncEngine.saveDraft(handoverKey(groupId), {
        parsed: result.parsed,
        receiptId: result.receiptId,
        at: Date.now(),
      });

      setScanNote(
        result.check.reconciles && result.check.problems.length === 0
          ? t.expense.scanReconciles
          : (result.check.problems[0]?.message ?? t.expense.scanCheckTotal),
      );

      // The receipt just landed, so the cached cap count is now stale. Refresh
      // the gate before another scan can start from a wrong number.
      await queryClient.invalidateQueries({ queryKey: ['receiptCap', groupId] });
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotScan, 'expense.scan'));
    } finally {
      setScanning(false);
    }
  };

  const toggleParticipant = (memberId: MemberId): void => {
    setParticipants((current) =>
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId],
    );
  };

  // Why Save is disabled, in one line, so a greyed-out button is never a dead
  // end the person has to guess their way out of. A broken split already prints
  // its own reason in the split card, so it is not repeated here; `saving` is a
  // transient state, not something to instruct around.
  // The payer side's complaint, in money the person can read. `delta` is signed:
  // positive is still to hand out, negative is more claimed than the bill.
  const payerMessage =
    payerProblem === null
      ? null
      : payerProblem.code === PayerProblemCode.NoPayers ||
          payerProblem.code === PayerProblemCode.Negative
        ? t.expense.chooseWhoPaid
        : (payerProblem.code === PayerProblemCode.Short
            ? t.expense.paidLeftToAssign
            : t.expense.paidOverAssigned
          ).replace(
            '{amount}',
            format(
              money(payerProblem.delta < 0n ? -payerProblem.delta : payerProblem.delta, currency),
              { locale },
            ),
          );

  const saveHint =
    amount === 0n
      ? t.expense.saveNeedsAmount
      : participants.length === 0
        ? t.expense.saveNeedsWho
        : // Only worth saying once the bill has a total: "₹0 left to assign" on an
          // empty form is noise, not guidance.
          payerMessage;
  const canSave =
    amount > 0n && participants.length > 0 && splitIssue === null && payerProblem === null;

  // The fold starts open, and starts open the same way whether this is a new
  // expense or an edit.
  //
  // It used to derive its default from whether anything inside carried a
  // non-default value — and `categoryChosen` was one of those. Every saved
  // expense has a category, so that flag is true on essentially every edit and
  // false on every new one: the fold stood open on the edit form and shut on the
  // add form, and one screen quietly had two layouts. Worse, it shut in exactly
  // the case where the rows are most use — a new expense, where the day, the
  // rail and the currency have not been set by anybody yet.
  //
  // A foreign currency still forces it open over a collapse: the rate card lives
  // inside the fold and the expense cannot be saved without a rate.
  const showDetails = expenseDetailsVisible({
    choice: detailsChoice,
    currency,
    groupCurrency,
  });

  // The bottom-bar sub-line. When an equal split lands the same amount on every
  // head, say it in money — "3 people owe ₹200 each" — which is the number
  // people actually care about; otherwise the plain headcount.
  const previewValues = preview ? [...preview.values()] : [];
  const evenEach =
    previewValues.length > 0 && previewValues.every((value) => value === previewValues[0])
      ? previewValues[0]
      : null;
  const savePreview =
    participants.length === 0
      ? t.extras.savedStraightAway
      : evenEach !== null && amount > 0n
        ? plural(locale, participants.length, t.expense.oweEach).replace(
            '{amount}',
            format(money(evenEach, currency), { locale }),
          )
        : plural(locale, participants.length, t.memberCount);

  return (
    // No safe-area edges: this screen reserves neither end itself. The hero pads
    // the status bar into its own gradient at the top, and the action bar pads
    // the navigation bar into its own fill at the bottom, so both surfaces run
    // to the screen edge instead of floating on a strip of page colour — the
    // grammar the app's bottom bar already uses.
    //
    // It also settles where a picker sheet lands. `SheetOverlay` is drawn in
    // this tree, absolutely positioned to the bottom, and an absolute child is
    // laid out inside its parent's padding: with a bottom inset on the Screen
    // the sheet stopped short of the screen edge, its scrim left the navigation
    // bar unwashed, and the sheet then reserved the same inset a second time
    // under its own last row.
    <Screen edges={[]}>
      {/* The hero runs dark under the status bar, so its icons must be light —
          the same override the expense screen this form mirrors makes. */}
      <StatusBar style="light" />
      {/* The action bar is pinned to the bottom edge, outside the scroll, and a
          split-share field can be the focused input — on iOS the soft keyboard
          would slide up over both. Lifting the scroll + bar together keeps the
          running total, Save, and the field you are typing in above the
          keyboard. Android resizes the window itself (adjustResize), so it needs
          no behaviour. The currency sheet sits outside this wrapper so it stays
          anchored to the screen, not shoved by the keyboard-avoid. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* The same panel the expense screen wears — category badge, one line of
            identity, the amount — so tapping Edit changes what you can do, not
            where anything is. The amount is editable here and shares its line
            with the currency pill instead of standing alone at 44pt over it.
            "Split by item" moved down beside the split it belongs to. */}
        <ExpenseHero
          title={`${editing ? t.expense.edit : t.addExpense} · ${groupLabel(
            group.data,
            members.data ?? [],
            viewerId,
          )}`}
          category={category}
          categoryMeta={categoryMeta}
          description={description}
          currency={currency}
          amount={amount}
          onAmountChange={setAmount}
          onPressCurrency={() => setPickingCurrency(true)}
          // Opened by tapping the total on the expense screen: land in the amount
          // field with the keyboard already up.
          autoFocusAmount={focus === 'amount'}
        />
        <ScrollView
          style={{ flex: 1 }}
          // The form is long — amount, note, receipts, split, two rosters — and a
          // 20pt gutter between every block plus each card's own padding meant a
          // screenful held about two questions. `lg` between blocks and `md`
          // inside them keeps the grouping legible while fitting the split and
          // who-paid on one screen instead of two.
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.lg,
            gap: theme.spacing.lg,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* The bill, first — the order the expense screen reads in.

            Viewing a bill puts its receipts at the top, above the card of facts
            and above the split; the form used to put them third, after the note
            and the day, so the same expense told its story in two different
            orders depending on whether you were reading it or writing it. The
            bill is also the thing a person is most often holding when they open
            this screen, and scanning it fills in the amount and the note below —
            so it belongs before the fields it populates, not after them.

            The bill is still a shortcut, not the screen: two small actions
            rather than a card that makes this look like a receipt scanner. Scan
            is metered and gives way when the group is capped; Add photo keeps an
            image on the device and never records a receipt server-side, so it
            is offered even at the cap.

            New expenses only. On an edit the gallery below is already the place
            bills are added and removed — it carries its own add tile — so these
            two would be a second door to the same room, one of which (scan)
            would also re-read a bill that has already been entered. */}
          <View style={{ gap: theme.spacing.sm }}>
            {!editing ? (
              <>
                <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                  {!capLocked ? (
                    <Button
                      label={scanning ? t.expense.reading : t.expense.scanReceipt}
                      variant="ghost"
                      size="sm"
                      disabled={scanning || saving || capStatus === 'loading'}
                      onPress={() => void scan()}
                      icon={
                        <Ionicons
                          name="camera-outline"
                          size={iconSize.md}
                          color={theme.color.brand}
                        />
                      }
                    />
                  ) : null}
                  <Button
                    label={t.expense.addPhoto}
                    variant="ghost"
                    size="sm"
                    disabled={scanning || saving}
                    onPress={() => void attach()}
                    icon={
                      <Ionicons name="image-outline" size={iconSize.md} color={theme.color.brand} />
                    }
                  />
                </Row>
                {capLocked ? (
                  <Row style={{ gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Text variant="caption" tone="muted" style={{ flex: 1, minWidth: 0 }}>
                      {t.expense.capReachedBody}
                    </Text>
                    <Button
                      label={t.expense.capUpgrade}
                      size="sm"
                      onPress={() => router.push('/settings/upgrade')}
                    />
                  </Row>
                ) : null}
                {scanning ? <ActivityIndicator color={theme.color.brand} /> : null}
                {scanNote ? (
                  <Text variant="caption" tone="brand">
                    {scanNote}
                  </Text>
                ) : null}
              </>
            ) : null}

            {/* The bills kept against this expense — the same gallery the expense
              screen shows, not a second design for the same thing. A one-line
              thumbnail of the legacy bill used to stand here, which meant an
              expense with four receipts showed one of them on the screen where
              you go to change it.

              Only when editing: attachments are committed against an expense row,
              and a new expense has no row yet. On a new one the scan/photo
              shortcuts above are the whole story, and what they capture is
              uploaded once the save lands. */}
            {editing ? (
              <ExpenseReceipts
                groupId={groupId}
                expenseId={targetExpenseId}
                canManage={isExpenseParty}
                canRemoveLegacy={isExpenseParty || iAmGroupAdmin}
                legacyReceiptPath={receiptUri ? receiptPath : null}
                onLegacyRemoved={() => {
                  setReceiptUri(null);
                  setReceiptPath(null);
                }}
              />
            ) : null}

            {scannedItems > 0 && !editing ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.replace(`/group/${groupId}/itemize`)}
              >
                <Text variant="caption" tone="brand" style={{ fontWeight: '700' }}>
                  {`${plural(locale, scannedItems, t.expense.scanReadItemsCta)} →`}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* "How much" and "what for" are the whole of the common case. The
            amount is in the hero above and the note is here, with only the bill
            between them — and the bill is what fills both in when it is scanned,
            so it is on the way to the note rather than in front of it. The names
            are handed to the recogniser as hints; a general model guesses at
            Indian names and the note is where they turn up. */}
          <DescriptionField
            value={description}
            onChange={setDescription}
            placeholder={t.expense.descriptionPlaceholder}
            accessibilityLabel={t.description}
            hints={nameHints}
            multiline
          />

          {/* The bill's facts, as one labelled card — the same card the expense
            screen shows under its receipts, with the answers editable instead of
            printed.

            These four are all the same kind of question: a short answer, already
            filled in, changed from a sheet. They used to be spread across three
            places — the day in a card of its own here, the category and the rail
            behind the "More details" fold, and the currency only as a pill in
            the header — so a form that could have said what it knew in four
            lines instead made you find three different controls to read it.

            None of them is an advanced setting. An expense filed on the wrong
            day lands in the wrong month, the wrong trip and the wrong place in
            the feed; a bill paid on a card recorded as cash is wrong on the
            statement it is checked against; and a total in the wrong currency is
            simply a different number. Untouched, the day still inherits whatever
            it always had, so editing a note never moves a three-week-old dinner.

            Category is here as well as on the hero badge above: the badge shows
            the guess, which is what you want while typing the note, but it is
            not a control — this row is where the guess is overruled.

            Literally the same card, now: `DetailRows` inside a `Card` with no
            padding of its own is the markup the expense screen uses, down to the
            hairlines it puts in the gaps rather than between siblings. These
            rows used to be drawn the other way up — the question in full weight,
            the answer muted beside it — so a bill you had just filed came back
            reading as a different screen's idea of the same four facts. The
            answers are what somebody scans for on both, so the answers are the
            loud half on both. */}
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            <DetailRows>
              <DetailRow
                icon="calendar-outline"
                label={t.captures.date}
                value={showDate(expenseDate, locale)}
                onPress={() => setEditingDate(true)}
              />
              <CategoryRow
                value={category}
                meta={categoryMeta}
                onPress={() => setPickingCategory(true)}
              />
              <PaymentMethodRow value={paymentMethod} onPress={() => setPickingPayment(true)} />
              {/* What it was paid in, as a named row rather than only as the pill
                in the header. The pill is still there and still works — but it is
                a hairline outline on a gradient beside a large amount, and "there
                is no currency selection" is what somebody looking for one
                reported. This names the field and opens the same sheet.

                Not `cash-outline`: the rail row directly above wears that glyph
                whenever the answer is cash, which is the default — two rows with
                the same mark read as one repeated question. */}
              <DetailRow
                icon="globe-outline"
                label={t.captures.currencyLabel}
                value={`${currencySymbol(currency)} ${currency}`}
                onPress={() => setPickingCurrency(true)}
              />
            </DetailRows>
          </Card>

          {editingDate ? (
            <DateTimePicker
              value={dateFrom(expenseDate)}
              mode="date"
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              onChange={applyDate}
            />
          ) : null}

          {/* "How is this split" as one block instead of three.

            The heading, the row of modes and the itemise button used to be three
            siblings of the scroll view with a 16pt gutter between each, so a
            question with one answer looked like three separate decisions — and
            the last of them was a full-width button, the widest control on the
            screen, for the rarest of the four ways to split. Here the heading
            owns the block, carries the one action that is not a mode (itemising
            leaves for another screen) at the end of its own line, and the
            choices sit directly under it — the shape the payer card's heading
            below already has, so the two read as the same kind of question. */}
          <View style={{ gap: theme.spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                {t.expense.howToSplit}
              </Text>
              {/* Splitting the bill line by line is another answer to "how is
                  this split", so it belongs to this heading rather than to the
                  top bar, where it competed with the title. A link like the
                  payer card's, not a button: it goes somewhere, and the controls
                  that change something on this screen are all chips. New
                  expenses only — an existing one is edited in place, not
                  re-itemised. */}
              {!editing ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.expense.splitByItem}
                  onPress={() => router.replace(`/group/${groupId}/itemize`)}
                  hitSlop={LINK_HIT_SLOP}
                  style={{ flexShrink: 0 }}
                >
                  <Text
                    variant="micro"
                    tone="brand"
                    numberOfLines={1}
                    style={{ fontWeight: '700' }}
                  >
                    {t.expense.splitByItem}
                  </Text>
                </Pressable>
              ) : null}
            </Row>

            {/* Word plus glyph, not four identical word-pills: the icon is what
              carries over to the expense screen, where the same split comes back
              as a marked row rather than a bare word. Four labelled modes do not
              fit one line on a narrow phone in any of the four languages, so the
              lane scrolls rather than wraps: a fourth chip alone on a second row
              is what reads as a broken control, where a chip cut off at the edge
              reads as more to the side. Each chip states its own selected state
              to the screen reader; the fill is not the only thing saying which
              one is on. */}
            <ChipRow<SplitKind>
              value={splitKind}
              onChange={(next) => {
                setSplitKind(next);
              }}
              options={[SplitKind.Equal, SplitKind.Shares, SplitKind.Percent, SplitKind.Exact].map(
                (kind) => ({
                  value: kind,
                  label:
                    kind === SplitKind.Equal
                      ? t.expense.equally
                      : kind === SplitKind.Shares
                        ? t.expense.shares
                        : kind === SplitKind.Percent
                          ? t.expense.percent
                          : t.expense.exactly,
                  icon: (color: string) => (
                    <Ionicons name={splitIcon(kind)} size={iconSize.md} color={color} />
                  ),
                }),
              )}
            />
          </View>

          {/* Who paid — on an edit as much as on a new expense, and now as many
            people as actually put money in.

            Two things used to be wrong here. The picker was hidden the moment
            the form opened on an existing bill, so the correction people most
            often come back to make had no control anywhere on the screen. And it
            was single-select, so "she got the taxi, I got the tickets" had to be
            entered as two expenses — two rows in the feed, two things to edit,
            two things to delete — even though the ledger has always stored
            payers as a table.

            One payer stays exactly one tap: a row of avatars, no figures, no
            arithmetic. The amounts appear only once a second person is on it. */}
          <Card style={{ gap: theme.spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="caption" tone="muted">
                {t.paidBy}
              </Text>
              <Row style={{ gap: theme.spacing.lg, alignItems: 'center', flexShrink: 0 }}>
                {manyPayers && payers.size > 1 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t.expense.splitPaidEvenly}
                    onPress={splitPaidEvenly}
                    hitSlop={LINK_HIT_SLOP}
                  >
                    <Text variant="micro" tone="brand" style={{ fontWeight: '700' }}>
                      {t.expense.splitPaidEvenly}
                    </Text>
                  </Pressable>
                ) : null}
                {/* The way in and out of several-payer mode. A link rather than a
                    hidden long-press: nobody discovers a long-press, and this is
                    the whole feature. */}
                <Pressable
                  accessibilityRole="switch"
                  accessibilityState={{ checked: manyPayers }}
                  accessibilityLabel={manyPayers ? t.expense.paidByOne : t.expense.paidBySeveral}
                  onPress={() => setManyPayers(!manyPayers)}
                  hitSlop={LINK_HIT_SLOP}
                >
                  <Text variant="micro" tone="brand" style={{ fontWeight: '700' }}>
                    {manyPayers ? t.expense.paidByOne : t.expense.paidBySeveral}
                  </Text>
                </Pressable>
              </Row>
            </Row>

            {/* One lane that scrolls, not a grid that reflows. Wrapping made the
              row's height depend on how long the names in this group happen to
              be — one "Lokesh Rangasamy" pushed the whole card taller and shoved
              its neighbours onto a second line, so the same control was a
              different shape in every group. Every tile is now the same width,
              the name gets one line and an ellipsis, and the overflow goes
              sideways where a tap can reach it.

              Whoever is paying leads the lane (`payerChoices`), so on a long
              member list the answer is at the start rather than somewhere off
              the right-hand edge. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              // The lane sits inside a Card, which already pads it — the extra
              // right padding is the "there is more this way" gutter.
              contentContainerStyle={{ gap: theme.spacing.xs, paddingRight: theme.spacing.xl }}
            >
              {payerChoices.map((member) => {
                const isPayer = payers.has(member.id);
                return (
                  <Pressable
                    key={member.id}
                    // The role follows the mode, because the gesture does: one
                    // payer is a radio (tapping replaces), several is a checkbox
                    // (tapping adds). Announcing the wrong one tells somebody
                    // using a screen reader the opposite of what will happen.
                    accessibilityRole={manyPayers ? 'checkbox' : 'radio'}
                    accessibilityState={manyPayers ? { checked: isPayer } : { selected: isPayer }}
                    accessibilityLabel={`${t.paidBy}: ${displayName(member, viewerId)}`}
                    onPress={() => togglePayer(member.id)}
                    style={{
                      width: PAYER_TILE_WIDTH,
                      alignItems: 'center',
                      gap: 4,
                      opacity: isPayer ? 1 : 0.45,
                    }}
                  >
                    <Avatar name={displayName(member)} ghost={isGhost(member)} />
                    <Text
                      variant="micro"
                      tone={isPayer ? 'brand' : 'muted'}
                      numberOfLines={1}
                      style={{ textAlign: 'center' }}
                    >
                      {displayName(member, viewerId)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {manyPayers && payers.size > 1 ? (
              <View style={{ gap: theme.spacing.xs }}>
                {payerIds.map((memberId) => {
                  const member = (members.data ?? []).find((row) => row.id === memberId);
                  const name = member ? displayName(member, viewerId) : t.misc.someone;
                  return (
                    <Row key={memberId} style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                      <Avatar
                        name={member ? displayName(member) : name}
                        ghost={member ? isGhost(member) : false}
                        size={32}
                      />
                      <Text variant="body" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
                        {name}
                      </Text>
                      {/* The figure may be long — a six-figure trip total, a
                          yen amount, a large accessibility font. It gives way
                          to the name rather than clipping, down to a floor
                          wide enough to still read as a field. */}
                      <Row
                        style={{
                          gap: theme.spacing.xs,
                          alignItems: 'center',
                          flexShrink: 1,
                          minWidth: 96,
                          maxWidth: '60%',
                        }}
                      >
                        <Text variant="caption" tone="muted">
                          {currencySymbol(currency)}
                        </Text>
                        <TextInput
                          value={paidText[memberId] ?? ''}
                          onChangeText={(text) => setPaidEntry(memberId, text)}
                          keyboardType={amountKeyboard(currency as CurrencyCode)}
                          selectTextOnFocus
                          placeholder="0"
                          placeholderTextColor={theme.color.textFaint}
                          accessibilityLabel={t.expense.paidByNameAmount
                            .replace('{name}', name)
                            .replace(
                              '{amount}',
                              format(money(payers.get(memberId) ?? 0n, currency), { locale }),
                            )}
                          // What is wrong with the set of figures, on each field
                          // that can put it right. React Native has no invalid
                          // accessibility state, so the message itself is the
                          // hint — otherwise the only announcement of a bill
                          // that does not add up arrives at the save button.
                          accessibilityHint={payerMessage ?? undefined}
                          style={{
                            flexGrow: 1,
                            flexShrink: 1,
                            minWidth: 72,
                            minHeight: 44,
                            fontSize: 16,
                            fontWeight: '700',
                            textAlign: 'right',
                            textAlignVertical: 'center',
                            color: theme.color.text,
                            backgroundColor: theme.color.bg,
                            borderRadius: theme.radius.sm,
                            paddingVertical: theme.spacing.sm,
                            paddingHorizontal: theme.spacing.sm,
                          }}
                        />
                      </Row>
                    </Row>
                  );
                })}
              </View>
            ) : null}

            {/* What is still unaccounted for, or claimed twice over. Only once
              the bill has a total: "₹0 left to assign" on an empty form is noise
              rather than guidance. A single payer always holds the whole bill, so
              there is nothing to report — that row gets the hint instead. */}
            {payerMessage && amount > 0n ? (
              <Text
                variant="micro"
                tone="negative"
                // Announced as it changes, rather than only when the field it
                // belongs to happens to be focused.
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                {payerMessage}
              </Text>
            ) : null}
          </Card>

          <Card style={{ gap: theme.spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="caption" tone="muted">
                {t.expense.splitBetween}
              </Text>
              <Text variant="micro" tone="muted">
                {t.expense.ofCount
                  .replace('{chosen}', String(participants.length))
                  .replace('{total}', String(members.data?.length ?? 0))}
              </Text>
            </Row>

            {(members.data ?? []).map((member) => {
              const selected = participants.includes(member.id);
              const name = displayName(member, viewerId);
              return (
                <View
                  key={member.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    // The avatar is 38pt and the share field has a 44pt floor, so
                    // the row is tall enough to tap without padding stretching it.
                    paddingVertical: theme.spacing.xs,
                  }}
                >
                  {/* The name toggles; the field beside it must not, or nobody
                    could tap into it without dropping the person. */}
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={name}
                    onPress={() => toggleParticipant(member.id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                      flex: 1,
                    }}
                  >
                    <Avatar name={displayName(member)} ghost={isGhost(member)} size={38} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text variant="subheading" numberOfLines={1}>
                        {name}
                      </Text>
                      {selected && amount > 0n ? (
                        <MoneyText
                          amount={lineAmount(member.id)}
                          currency={currency}
                          locale={locale}
                          variant="caption"
                          // This person's share = money owed toward the bill, so it
                          // wears the owe colour, matching the who-owes-what list and
                          // the balances elsewhere. Forced red: a positive share
                          // would read as "owed to you" under sign-derived colour.
                          tone="negative"
                        />
                      ) : null}
                    </View>
                  </Pressable>

                  {splitKind !== SplitKind.Equal && selected ? (
                    <SplitEntryField
                      kind={splitKind}
                      currency={currency}
                      value={entries[member.id] ?? ''}
                      onChange={(text) => setEntry(member.id, text)}
                      name={name}
                    />
                  ) : null}

                  <Pressable
                    accessible={false}
                    onPress={() => toggleParticipant(member.id)}
                    hitSlop={8}
                  >
                    <Ionicons
                      name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                      size={iconSize.xl}
                      color={selected ? theme.color.brand : theme.color.textFaint}
                    />
                  </Pressable>
                </View>
              );
            })}

            {splitIssue ? (
              <Text variant="micro" tone="negative">
                {splitIssue}
              </Text>
            ) : null}

            {/* Someone missing from the roster is added on the group's own members
              screen, then they appear here to be split with. */}
            <Button
              label={t.people.addSomeone}
              variant="secondary"
              size="sm"
              onPress={() => router.push(`/group/${groupId}/members`)}
              icon={
                <Ionicons name="person-add-outline" size={iconSize.md} color={theme.color.brand} />
              }
            />
          </Card>

          {/* What is genuinely optional: where it happened, and — once the
            currency is not the group's — the rate that converts it.

            The category and the rail used to live down here too. They are not
            optional in the same sense: both are always set (the category is
            guessed from the note, the rail defaults to cash), so the fold was
            hiding two answers the form had already given rather than two
            questions nobody had asked. They are up in the facts card now, beside
            the day and the currency, and this keeps the two that really can be
            left empty. */}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDetails }}
            accessibilityLabel={t.expense.moreDetails}
            onPress={() => setDetailsChoice(!showDetails)}
          >
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="caption" tone="brand" style={{ fontWeight: '700' }}>
                {showDetails ? t.expense.fewerDetails : t.expense.moreDetails}
              </Text>
              <Ionicons
                name={showDetails ? 'chevron-up' : 'chevron-down'}
                size={iconSize.md}
                color={theme.color.brand}
              />
            </Row>
          </Pressable>

          <View style={{ gap: theme.spacing.xl, display: showDetails ? 'flex' : 'none' }}>
            {/* Where it happened (A43) — optional, opt-in, never a background track. */}
            <LocationField value={location} onChange={setLocation} />

            {/* Currency is chosen from the facts card above (and from the header
              pill); this collapses to the FX rate alone — nothing while the
              expense is in the group's currency, the rate methods once it is
              foreign (ADR-003). */}
            <CurrencyRate
              groupCurrency={groupCurrency}
              currency={currency}
              onCurrencyChange={setExpenseCurrency}
              amount={amount}
              fx={fx}
              onFxChange={setFx}
              tripRate={tripRate}
              showCurrencyPicker={false}
            />
          </View>
        </ScrollView>

        {/* The one action, pinned. The screen is tall — keypad, scan, currency,
          description, category, split, two rosters — and Save used to sit at the
          bottom of all of it, a scroll away from wherever you were. Here it
          rides the bottom edge with the running total and headcount beside it,
          so what you are about to save is always in view, and so is the button
          that saves it. A submit error surfaces here too, next to the button
          that raised it, rather than lost up the scroll. */}
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            // The bar is the last thing on the screen, so it is the one that
            // owes the navigation bar its room — and it pays it as padding, not
            // as a gap: the fill and the hairline run all the way to the bottom
            // edge behind the gesture pill or the three buttons, and Save sits a
            // clear breath above them. A bare `spacing.md` left the button
            // pressed against the system bar on any phone whose bar is drawn
            // over the app.
            paddingBottom: clearance,
            gap: theme.spacing.sm,
            borderTopWidth: 1,
            borderTopColor: theme.color.border,
            backgroundColor: theme.color.surface,
          }}
        >
          {error ? <Callout tone="negative">{error}</Callout> : null}
          <Row style={{ justifyContent: 'space-between', gap: theme.spacing.lg }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <MoneyText amount={amount} currency={currency} locale={locale} variant="heading" />
              <Text variant="micro" tone="muted" numberOfLines={1}>
                {savePreview}
              </Text>
            </View>
            <Row style={{ gap: theme.spacing.md, flexGrow: 0, flexShrink: 0 }}>
              {saving ? <ActivityIndicator color={theme.color.brand} /> : null}
              <Button
                label={editing ? t.expense.saveChanges : t.expense.saveExpense}
                size="lg"
                disabled={!canSave || saving}
                onPress={() => void submit()}
              />
            </Row>
          </Row>
          {/* The one reason Save cannot be tapped yet, spelled out under it —
            shown only while the button is actually blocked and no save is in
            flight. */}
          {saveHint && !saving ? (
            <Text variant="micro" tone="muted">
              {saveHint}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>

      {/* Travel split presets, as a sheet over the form (trip groups). Each
          gathers just its inputs, then applies canonical split params through
          the core builders — nothing new is stored. */}
      {/* Currency picker, as a sheet over the form — the same shortlist and the
          same sheet the capture screen uses, so a person meets the same
          currencies in both places. Picking a foreign one reveals the rate card
          below the amount (CurrencyRate). */}
      {pickingCurrency ? (
        <SheetOverlay
          title={t.captures.currencyPickerTitle}
          onClose={() => setPickingCurrency(false)}
        >
          <View style={{ gap: theme.spacing.xs }}>
            {COMMON_CURRENCIES.map((code) => (
              <ChoiceRow
                key={code}
                leading={
                  <Text
                    variant="subheading"
                    tone="muted"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    style={{ width: 36, textAlign: 'center' }}
                  >
                    {currencySymbol(code)}
                  </Text>
                }
                label={code}
                selected={currency === code}
                onPress={() => chooseCurrency(code)}
              />
            ))}
          </View>
        </SheetOverlay>
      ) : null}

      {/* What kind of expense, from the "more details" list. Picking one closes
          the sheet — one tap, one answer, which is the whole point of moving
          this off a lane of chips. "＋ New tag" swaps this sheet for the tag
          editor rather than stacking one over the other. */}
      {pickingCategory ? (
        <CategorySheet
          value={category}
          onChange={(picked, meta) => {
            setCategory(picked);
            setCategoryMeta(meta);
            // A tap of their own, so the description guess stops moving it.
            setCategoryChosen(true);
            setPickingCategory(false);
          }}
          onCreate={() => {
            setPickingCategory(false);
            setEditingTag(true);
          }}
          onClose={() => setPickingCategory(false)}
        />
      ) : null}

      {/* How it was paid — a tag on the expense, defaulting to cash. */}
      {pickingPayment ? (
        <PaymentMethodSheet
          value={paymentMethod}
          onChange={(picked) => {
            setPaymentMethod(picked);
            setPickingPayment(false);
          }}
          onClose={() => setPickingPayment(false)}
        />
      ) : null}

      {/* Make a tag on the spot, from the category sheet's "＋ New tag" row —
          and then wear it. Somebody who breaks off from tagging an expense to
          invent a tag wanted that tag on this expense; the editor used to close
          onto a row still showing the old category, with the thing they had
          just made nowhere on screen and only findable by opening the sheet
          again. Selecting it here is the rest of that one gesture. */}
      <TagEditorSheet
        open={editingTag}
        onClose={() => setEditingTag(false)}
        onCreated={(tagId, meta) => {
          setCategory(tagId);
          setCategoryMeta(meta);
          setCategoryChosen(true);
        }}
      />
    </Screen>
  );
}
