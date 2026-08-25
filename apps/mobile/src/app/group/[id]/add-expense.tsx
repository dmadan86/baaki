import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
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
  carRentalSplit,
  CategoryId,
  computeShares,
  currencySymbol,
  guessCategory,
  MutationKind,
  ridersSplit,
  splitByUnits,
  treatSplit,
  type CategoryMeta,
  type ExpenseLocation,
  type FxRecord,
  type MemberId,
  type PaymentMethod,
  type SplitParams,
} from '@waves/core';
import {
  AmountField,
  Avatar,
  Button,
  Callout,
  Card,
  ChipRow,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@waves/ui';

import { CategoryPicker } from '@/components/Category';
import { TagEditorSheet } from '@/components/TagEditorSheet';
import { PaymentMethodPicker } from '@/components/PaymentMethodPicker';
import { LocationField } from '@/components/LocationField';
import { friendlyError } from '@/lib/errors';
import { COMMON_CURRENCIES, CurrencyRate } from '@/components/CurrencyRate';
import { AmountHeader } from '@/components/expense/AmountHeader';
import { DescriptionField } from '@/components/expense/DescriptionField';
import { ExpenseHeader } from '@/components/expense/ExpenseHeader';
import { ChoiceRow, SheetOverlay } from '@/components/expense/SheetOverlay';
import {
  canAddReceipt,
  expenseReceiptPath,
  expenseReceiptUrl,
  scanReceipt,
  scanReceiptText,
  uploadExpenseReceipt,
} from '@/data/api';
import { receiptCapStatus, receiptTapAction } from '@/lib/receiptCapGate';
import { StorageCapError } from '@/lib/storage';
import { useAssignCapture, useGroup } from '@/data/hooks';
import { displayName, groupLabel, isGhost } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';
import { handoverKey } from '@/lib/handover';
import { resolveDraftCurrency, resolveDraftFx } from '@/lib/expenseDraft';
import { captureReceipt, pickReceiptImage, type PickedImage } from '@/lib/image';
import { recogniseReceipt } from '@/lib/ocr';
import { matchMemberNames, stripMemberNames } from '@/lib/voiceExpense';
import {
  entryValues,
  fillEntries,
  formatEntry,
  parseEntry,
  splitProblem,
  SplitKind,
  type SplitEntries,
} from '@/lib/split';
import { clearDraft, syncEngine, useDraft, useRestoredDraft, useSync } from '@/sync';

interface ExpenseDraft {
  amount: string;
  description: string;
  splitKind: SplitKind;
  payer: MemberId | null;
  /**
   * The currency this expense was paid in, when it differs from the group's.
   * Optional: drafts written before this field existed omit it, which is not
   * the same as an explicit null — see resolveDraftCurrency.
   */
  currency?: string | null;
  /** The stored conversion rate for a foreign-currency expense (ADR-003). */
  fx?: FxRecord | null;
  participants: MemberId[];
  /** Kept apart, because a weight of 1 is not one percent. */
  weights: SplitEntries;
  percents: SplitEntries;
  category: string | null;
  /** The custom tag's display, when `category` is a custom tag (extends TDR §8). */
  categoryMeta: CategoryMeta | null;
  /** Whether the category above was chosen, rather than guessed. */
  categoryChosen: boolean;
  /** Where the spend happened (A43), when the person attached one. */
  location?: ExpenseLocation | null;
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
  const { t, locale } = useStrings();
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
    expenseDate: captureExpenseDate,
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
    expenseDate?: string;
  }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
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
  const [payer, setPayer] = useState<MemberId | null>(null);
  // How it was paid — a free-text tag on the expense. Defaults to cash; the
  // picker offers UPI only where the region settles over it.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [participants, setParticipants] = useState<MemberId[]>([]);
  // What was typed into each member's field, as text. Two maps, not one: the
  // same person is "2 shares" and "40%", and switching between the two must not
  // reinterpret one number as the other.
  const [weights, setWeights] = useState<SplitEntries>({});
  const [percents, setPercents] = useState<SplitEntries>({});
  // Travel split presets (trip groups). Each produces the canonical split params
  // the ledger already understands, so nothing new is stored: nights → shares,
  // this-ride → equal (both drive the normal fields), car rental → an
  // `adjustment` held in `presetParams`, and "my treat" → an `exact` recomputed
  // live from the amount via `treatHost`. Any manual edit clears the preset.
  const [presetParams, setPresetParams] = useState<SplitParams | null>(null);
  const [treatHost, setTreatHost] = useState<MemberId | null>(null);
  const [presetLabel, setPresetLabel] = useState<string | null>(null);
  const [presetEditor, setPresetEditor] = useState<'nights' | 'car' | 'ride' | 'treat' | null>(
    null,
  );
  const [nightCounts, setNightCounts] = useState<Record<MemberId, string>>({});
  const [riderPick, setRiderPick] = useState<MemberId[]>([]);
  const [fuelAmounts, setFuelAmounts] = useState<Record<MemberId, bigint>>({});
  const [exemptDriver, setExemptDriver] = useState<MemberId | null>(null);
  const [treatHostPick, setTreatHostPick] = useState<MemberId | null>(null);
  const clearPreset = (): void => {
    setPresetParams(null);
    setTreatHost(null);
    setPresetLabel(null);
  };
  // Guessed from the description until somebody picks one themselves, at which
  // point the guess must stop moving it — see `categoryChosen`.
  // A built-in id or a custom tag's id; `categoryMeta` carries a custom tag's
  // display so it rides onto the expense for every member (extends TDR §8).
  const [category, setCategory] = useState<string | null>(CategoryId.Food);
  const [categoryMeta, setCategoryMeta] = useState<CategoryMeta | null>(null);
  const [categoryChosen, setCategoryChosen] = useState(false);
  // The create-tag sheet, opened from the picker's "＋ New tag" chip.
  const [editingTag, setEditingTag] = useState(false);
  /**
   * Names to bias the recogniser towards. "You" and "Someone" are placeholders
   * this screen prints, not things anybody says out loud, so they would only
   * teach it to hear the wrong word.
   */
  const nameHints = useMemo(
    () =>
      (members.data ?? [])
        .map((member) => displayName(member, profile?.id))
        .filter((name) => name !== 'You' && name !== 'Someone'),
    [members.data, profile?.id],
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
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
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
                name: displayName(member, profile?.id),
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
                name: displayName(member, profile?.id),
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
      setPayer(myMemberId);
    } else if (draft) {
      // A draft outranks the saved version: it is what the user was in the
      // middle of writing when the app went away.
      setAmount(safeBigInt(draft.amount));
      setDescription(draft.description);
      setSplitKind(draft.splitKind);
      // When editing, the payer is fixed on the saved expense and its picker is
      // hidden — so a stale draft.payer from an earlier edit session must never
      // override it. New expenses still take the draft's chosen payer.
      setPayer(
        editing ? (version?.payers[0]?.member_id ?? myMemberId) : (draft.payer ?? myMemberId),
      );
      setExpenseCurrency(resolveDraftCurrency(draft.currency, version?.currency ?? null));
      setFx(resolveDraftFx(draft.fx));
      setParticipants(draft.participants);
      setWeights(draft.weights ?? {});
      setPercents(draft.percents ?? {});
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
      setPayer(version.payers[0]?.member_id ?? myMemberId);
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
      }
    } else {
      setParticipants((members.data ?? []).map((member) => member.id));
      setPayer(myMemberId);
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

  const entries = splitKind === SplitKind.Shares ? weights : percents;
  const setEntry = (memberId: MemberId, text: string): void => {
    clearPreset();
    const update = (current: SplitEntries): SplitEntries => ({ ...current, [memberId]: text });
    if (splitKind === SplitKind.Shares) setWeights(update);
    else setPercents(update);
  };
  const splitIssue = splitProblem(splitKind, entries, participants);

  /**
   * The split, folded into one sentence until somebody wants to argue with it.
   *
   * Almost every expense is "I paid, split it equally with everyone" — and that
   * case was costing three open sections (how to split, who paid, who is in) and
   * a screenful of scroll between the amount and the save button. Collapsed, the
   * sentence still says exactly what will be saved, which is the part that must
   * never be hidden; expanded, nothing about the controls has changed.
   *
   * It opens itself whenever the configuration is not that default, and stays
   * open while the numbers do not add up — a validation message under a fold is
   * a validation message nobody reads.
   */
  const isDefaultSplit =
    splitKind === SplitKind.Equal &&
    payer !== null &&
    payer === myMemberId &&
    participants.length > 0 &&
    participants.length === (members.data ?? []).length;
  const [splitOpen, setSplitOpen] = useState(false);
  const showSplit = splitOpen || !isDefaultSplit || splitIssue !== null;

  const isTrip = group.data?.type === 'trip';
  const groupCurrency = group.data?.default_currency ?? 'INR';
  // The expense keeps the currency it was paid in; the group's is only the
  // default and what a converted total would be shown in (ADR-003).
  const currency = expenseCurrency ?? groupCurrency;

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
      payer,
      currency: expenseCurrency,
      fx,
      participants,
      weights,
      percents,
      category,
      categoryMeta,
      categoryChosen,
      location,
    },
    { enabled: seededFor !== null },
  );

  const splitParams: SplitParams = useMemo(() => {
    // "My treat" owes the whole current amount to the host — recomputed live so
    // changing the total keeps the exact split valid.
    if (treatHost) {
      try {
        return treatSplit({ host: treatHost, participants, amountMinor: amount });
      } catch {
        // The host fell out of the participants; drop to the manual split below.
      }
    }
    // A car-rental preset is a fixed adjustment, valid at any total.
    if (presetParams) return presetParams;
    if (splitKind === SplitKind.Shares) {
      return { kind: 'shares', weights: entryValues('shares', weights, participants) };
    }
    if (splitKind === SplitKind.Percent) {
      return { kind: 'percent', basisPoints: entryValues('percent', percents, participants) };
    }
    return { kind: 'equal' };
  }, [splitKind, weights, percents, participants, treatHost, presetParams, amount]);

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

  if (group.isLoading || members.isLoading || restored.loading) {
    // Shell first: the back button and title paint instantly on navigation, and
    // only the form body waits on the mirror read (a few ms at launch). A bare
    // full-screen spinner used to leave a headerless blank while it loaded.
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <ExpenseHeader title={editing ? t.expense.edit : t.addExpense} />
          <View style={{ paddingTop: theme.spacing.xxxl, alignItems: 'center' }}>
            <ActivityIndicator color={theme.color.brand} />
          </View>
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
    if (!payer) {
      setError(t.expense.chooseWhoPaid);
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
        // A capture keeps the day it was caught; an ordinary expense is today's.
        expenseDate:
          captureId && captureExpenseDate
            ? captureExpenseDate
            : new Date().toISOString().slice(0, 10),
        currency,
        amount: amount.toString(),
        fx,
        splitParams,
        participants,
        payers: { [payer]: amount.toString() },
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
    clearPreset();
    setParticipants((current) =>
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId],
    );
  };

  // Travel split presets — each seeds the split from a small sheet, then hands
  // the ledger canonical params via the core builders. A SplitError from the
  // builder (nobody stayed a night, host not a rider) surfaces as a friendly
  // message rather than a crash, and nothing is applied.
  const roster = members.data ?? [];

  const openPreset = (kind: 'nights' | 'car' | 'ride' | 'treat'): void => {
    setError(null);
    setRiderPick(participants.length > 0 ? participants : roster.map((member) => member.id));
    setNightCounts({});
    setFuelAmounts({});
    setExemptDriver(null);
    setTreatHostPick(payer ?? myMemberId);
    setPresetEditor(kind);
  };

  const toggleRider = (memberId: MemberId): void => {
    setRiderPick((current) =>
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId],
    );
  };

  const applyNights = (): void => {
    try {
      const units: Record<MemberId, number> = {};
      for (const member of roster) {
        const parsed = Number.parseInt(nightCounts[member.id] ?? '', 10);
        units[member.id] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      }
      splitByUnits(units); // throws unless someone stayed a night
      const chosen = roster.filter((member) => (units[member.id] ?? 0) > 0).map((m) => m.id);
      clearPreset();
      setSplitKind(SplitKind.Shares);
      setParticipants(chosen);
      setWeights(Object.fromEntries(chosen.map((id) => [id, String(units[id])])));
      setPresetLabel(t.expense.presets.nights);
      setPresetEditor(null);
      setSplitOpen(true);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'preset.nights'));
    }
  };

  const applyRide = (): void => {
    try {
      const result = ridersSplit(riderPick);
      clearPreset();
      setSplitKind(SplitKind.Equal);
      setParticipants(result.participants);
      setPresetLabel(t.expense.presets.ride);
      setPresetEditor(null);
      setSplitOpen(true);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'preset.ride'));
    }
  };

  const applyCar = (): void => {
    try {
      const extras: Record<MemberId, bigint> = {};
      for (const id of riderPick) {
        const fuel = fuelAmounts[id] ?? 0n;
        if (fuel > 0n) extras[id] = fuel;
      }
      const result = carRentalSplit({
        participants: riderPick,
        extrasByMember: extras,
        exemptDriver: exemptDriver ?? undefined,
      });
      clearPreset();
      setSplitKind(SplitKind.Equal);
      setParticipants(result.participants);
      setPresetParams(result.params);
      setPresetLabel(t.expense.presets.car);
      setPresetEditor(null);
      setSplitOpen(true);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'preset.car'));
    }
  };

  const applyTreat = (): void => {
    const host = treatHostPick ?? myMemberId;
    if (!host) {
      setError(t.expense.chooseWhoPaid);
      return;
    }
    try {
      const parts = participants.includes(host) ? participants : [...participants, host];
      treatSplit({ host, participants: parts, amountMinor: amount }); // validate
      clearPreset();
      setParticipants(parts);
      setPayer(host);
      setTreatHost(host);
      setPresetLabel(t.expense.presets.treat);
      setPresetEditor(null);
      setSplitOpen(true);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'preset.treat'));
    }
  };

  // Why Save is disabled, in one line, so a greyed-out button is never a dead
  // end the person has to guess their way out of. A broken split already prints
  // its own reason in the split card, so it is not repeated here; `saving` is a
  // transient state, not something to instruct around.
  const saveHint =
    amount === 0n
      ? t.expense.saveNeedsAmount
      : participants.length === 0
        ? t.expense.saveNeedsWho
        : null;
  const canSave = amount > 0n && participants.length > 0 && splitIssue === null;

  return (
    <Screen edges={['top', 'bottom']}>
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
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.xl,
            gap: theme.spacing.xl,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <ExpenseHeader
            title={editing ? t.expense.edit : t.addExpense}
            subtitle={groupLabel(group.data, members.data ?? [], profile?.id)}
            right={
              editing ? undefined : (
                <IconButton
                  label={t.expense.splitByItem}
                  onPress={() => router.replace(`/group/${groupId}/itemize`)}
                >
                  <Ionicons name="list-outline" size={iconSize.lg} color={theme.color.brand} />
                </IconButton>
              )
            }
          />

          {editing ? (
            <Card style={{ backgroundColor: theme.color.buttonPrimary }}>
              <Text variant="caption" tone="onBrand">
                {t.expense.editingKeepsVersion}
              </Text>
            </Card>
          ) : null}

          {/* Amount-forward hero shared with the capture screen: big centred
            number, the currency it is counted in a tap below it. */}
          <AmountHeader
            currency={currency}
            amount={amount}
            onAmountChange={setAmount}
            onPressCurrency={() => setPickingCurrency(true)}
          />

          {/* Below the amount, not above it. Typing a number is the fast path and
            stays the first thing on the screen; the camera is for the bill that
            is easier to point at than to read. Attach sits beside Scan for the
            bill that is already a picture, or the scan that would not read. */}
          <Card style={{ gap: theme.spacing.md }}>
            <View>
              <Text variant="subheading">
                {capLocked ? t.expense.capReachedTitle : t.expense.scanBillTitle}
              </Text>
              <Text variant="caption" tone="muted">
                {capLocked ? t.expense.capReachedBody : t.expense.scanBillBody}
              </Text>
            </View>

            {/* Scan is metered and gives way when the group is capped; Attach is
              not — it keeps a photo on the device and never records a receipt
              server-side, so it is offered even at the cap. */}
            <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
              {!capLocked ? (
                <Button
                  label={scanning ? t.expense.reading : t.expense.scan}
                  variant="secondary"
                  disabled={scanning || saving || capStatus === 'loading'}
                  onPress={() => void scan()}
                  icon={
                    <Ionicons name="camera-outline" size={iconSize.md} color={theme.color.brand} />
                  }
                />
              ) : null}
              <Button
                label={t.expense.attach}
                variant="secondary"
                disabled={scanning || saving}
                onPress={() => void attach()}
                icon={
                  <Ionicons name="image-outline" size={iconSize.md} color={theme.color.brand} />
                }
              />
            </Row>
            {capLocked ? (
              <Row style={{ gap: theme.spacing.sm }}>
                <Button
                  label={t.expense.capUpgrade}
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

            {/* The kept bill (E2): a thumbnail that opens the full-screen viewer.
              A group receipt in R2 is already group-readable, so there is nothing
              to "share" — every member can open it. Hidden until a bill is kept. */}
            {receiptUri ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.expense.viewReceipt}
                onPress={() =>
                  router.push(
                    `/receipt/${targetExpenseId}${
                      receiptPath ? `?path=${encodeURIComponent(receiptPath)}` : ''
                    }`,
                  )
                }
              >
                <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
                  <Image
                    source={{ uri: receiptUri }}
                    style={{ width: 52, height: 52, borderRadius: theme.radius.md }}
                    contentFit="cover"
                    transition={150}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="subheading" numberOfLines={1}>
                      {t.expense.viewReceipt}
                    </Text>
                    <Text variant="micro" tone="muted" numberOfLines={1}>
                      {t.expense.receiptAttached}
                    </Text>
                  </View>
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.md}
                    color={theme.color.textFaint}
                  />
                </Row>
              </Pressable>
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
          </Card>

          {/* Currency is chosen from the header pill; this now collapses to the FX
            rate alone — nothing while the expense is in the group's currency,
            the rate methods once it is foreign (ADR-003). */}
          <CurrencyRate
            groupCurrency={groupCurrency}
            currency={currency}
            onCurrencyChange={setExpenseCurrency}
            amount={amount}
            fx={fx}
            onFxChange={setFx}
            showCurrencyPicker={false}
          />

          {/* Description field shared with capture. Kept multiline here for the
            longer notes a group expense sometimes carries. The member names are
            handed to the recogniser as hints — a general model guesses at Indian
            names and gets them wrong, and the note is where they turn up. */}
          <DescriptionField
            value={description}
            onChange={setDescription}
            placeholder={t.expense.descriptionPlaceholder}
            accessibilityLabel={t.description}
            hints={nameHints}
            multiline
          />

          {/* Pre-picked from the description, because a menu between somebody and
            saving a dinner is how a column ends up empty — and an empty column
            is a spending chart nobody can draw (TDR §8). */}
          <View style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {t.whatFor}
            </Text>
            <CategoryPicker
              value={category}
              onChange={(picked, meta) => {
                setCategory(picked);
                setCategoryMeta(meta);
                setCategoryChosen(true);
              }}
              onCreate={() => setEditingTag(true)}
            />
          </View>

          {/* How it was paid — a tag on the expense, defaulting to cash. */}
          <View style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {t.captures.paidWith}
            </Text>
            <PaymentMethodPicker value={paymentMethod} onChange={setPaymentMethod} />
          </View>

          {/* Where it happened (A43) — optional, opt-in, never a background track. */}
          <LocationField value={location} onChange={setLocation} />

          {/* The one-line answer to "who pays what", tappable to open the three
            controls that decide it. */}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showSplit }}
            accessibilityLabel={t.expense.howToSplit}
            onPress={() => setSplitOpen((open) => !open)}
            // Never fold a broken split away behind its own summary.
            disabled={splitIssue !== null}
          >
            <Card style={{ gap: theme.spacing.xs }}>
              <Row style={{ justifyContent: 'space-between', gap: theme.spacing.md }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="caption" tone="muted">
                    {t.expense.howToSplit}
                  </Text>
                  <Text variant="subheading" numberOfLines={2}>
                    {[
                      presetLabel ??
                        (splitKind === SplitKind.Equal
                          ? t.expense.equally
                          : splitKind === SplitKind.Shares
                            ? t.expense.shares
                            : t.expense.percent),
                      plural(locale, participants.length, t.memberCount),
                    ].join(' · ')}
                  </Text>
                </View>
                <Row style={{ gap: theme.spacing.xs, alignItems: 'center', flexShrink: 0 }}>
                  <Text variant="caption" tone="brand">
                    {showSplit ? t.common.done : t.common.edit}
                  </Text>
                  <Ionicons
                    name={showSplit ? 'chevron-up' : 'chevron-down'}
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                </Row>
              </Row>
            </Card>
          </Pressable>

          {/* Kept mounted and hidden rather than unmounted: the weighted split's
            fields hold text somebody is mid-way through typing, and a fold that
            threw it away would be a worse trade than a taller tree. */}
          <View style={{ gap: theme.spacing.md, display: showSplit ? 'flex' : 'none' }}>
            {isTrip && !editing ? (
              <View style={{ gap: theme.spacing.xs }}>
                <Text variant="micro" tone="muted">
                  {t.expense.presets.title}
                </Text>
                <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
                  {(
                    [
                      ['nights', t.expense.presets.nights],
                      ['car', t.expense.presets.car],
                      ['ride', t.expense.presets.ride],
                      ['treat', t.expense.presets.treat],
                    ] as const
                  ).map(([kind, label]) => (
                    <Button
                      key={kind}
                      label={label}
                      size="sm"
                      variant={presetLabel === label ? 'primary' : 'secondary'}
                      onPress={() => openPreset(kind)}
                    />
                  ))}
                </Row>
              </View>
            ) : null}

            <ChipRow<SplitKind>
              value={splitKind}
              onChange={(next) => {
                clearPreset();
                setSplitKind(next);
              }}
              options={[
                { value: SplitKind.Equal, label: t.expense.equally },
                { value: SplitKind.Shares, label: t.expense.shares },
                { value: SplitKind.Percent, label: t.expense.percent },
              ]}
            />
          </View>

          {!expenseId ? (
            <Card style={{ gap: theme.spacing.md, display: showSplit ? 'flex' : 'none' }}>
              <Text variant="caption" tone="muted">
                {t.paidBy}
              </Text>
              <Row style={{ flexWrap: 'wrap', gap: theme.spacing.md }}>
                {(members.data ?? []).map((member) => (
                  <Pressable
                    key={member.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: payer === member.id }}
                    accessibilityLabel={`${t.paidBy}: ${displayName(member, profile?.id)}`}
                    onPress={() => setPayer(member.id)}
                    style={{
                      alignItems: 'center',
                      gap: 4,
                      opacity: payer === member.id ? 1 : 0.45,
                    }}
                  >
                    <Avatar name={displayName(member)} ghost={isGhost(member)} />
                    <Text variant="micro" tone={payer === member.id ? 'brand' : 'muted'}>
                      {displayName(member, profile?.id)}
                    </Text>
                  </Pressable>
                ))}
              </Row>
            </Card>
          ) : null}

          <Card style={{ gap: theme.spacing.md, display: showSplit ? 'flex' : 'none' }}>
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
              const name = displayName(member, profile?.id);
              return (
                <View
                  key={member.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingVertical: theme.spacing.sm,
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
                    <Row style={{ gap: 2, alignItems: 'center', flexGrow: 0, flexShrink: 0 }}>
                      <TextInput
                        value={entries[member.id] ?? ''}
                        onChangeText={(text) => setEntry(member.id, text)}
                        keyboardType={
                          splitKind === SplitKind.Percent ? 'decimal-pad' : 'number-pad'
                        }
                        selectTextOnFocus
                        placeholder={splitKind === SplitKind.Percent ? '0' : '1'}
                        placeholderTextColor={theme.color.textFaint}
                        accessibilityLabel={
                          splitKind === SplitKind.Percent
                            ? `${name}'s percentage`
                            : `${name}'s shares`
                        }
                        style={{
                          width: 72,
                          // A 44pt floor makes the share/percent field a real tap
                          // target; `textAlignVertical` keeps the digit centred in
                          // the taller box on Android.
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
                        {splitKind === SplitKind.Percent ? '%' : '×'}
                      </Text>
                    </Row>
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

          {/* The way out of splitting. Some spend on a trip is nobody else's —
              a souvenir, a private treat — and forcing it onto the shared ledger
              (even split 1:1 with yourself) is noise in everyone's balances. This
              hands the amount and note already typed to the personal captures
              inbox, which never touches a group balance (plan §5). Only offered
              on a new expense; converting an existing shared row is a different,
              destructive act. `replace` so the abandoned split form is not left
              on the back stack behind the capture. */}
          {!editing ? (
            <View style={{ gap: theme.spacing.xs, alignItems: 'flex-start' }}>
              <Button
                label={t.expense.justForMe}
                variant="ghost"
                onPress={() => {
                  const params: Record<string, string> = { cur: currency };
                  if (amount > 0n) params.amount = amount.toString();
                  const note = description.trim();
                  if (note) params.desc = note;
                  router.replace({ pathname: '/capture', params });
                }}
                icon={
                  <Ionicons
                    name="lock-closed-outline"
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                }
              />
              <Text variant="micro" tone="muted">
                {t.expense.justForMeBody}
              </Text>
            </View>
          ) : null}
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
            paddingBottom: theme.spacing.md,
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
              <Text variant="micro" tone="muted">
                {participants.length > 0
                  ? plural(locale, participants.length, t.memberCount)
                  : t.extras.savedStraightAway}
              </Text>
            </View>
            <Row style={{ gap: theme.spacing.md, flexGrow: 0, flexShrink: 0 }}>
              {saving ? <ActivityIndicator color={theme.color.brand} /> : null}
              <Button
                label={editing ? t.expense.saveChanges : t.save}
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
      {presetEditor ? (
        <SheetOverlay
          title={
            presetEditor === 'nights'
              ? t.expense.presets.nightsTitle
              : presetEditor === 'car'
                ? t.expense.presets.carTitle
                : presetEditor === 'ride'
                  ? t.expense.presets.rideTitle
                  : t.expense.presets.treatTitle
          }
          onClose={() => setPresetEditor(null)}
        >
          <View style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {presetEditor === 'nights'
                ? t.expense.presets.nightsHint
                : presetEditor === 'car'
                  ? t.expense.presets.carRiders
                  : presetEditor === 'ride'
                    ? t.expense.presets.rideHint
                    : t.expense.presets.treatHint}
            </Text>

            {presetEditor === 'nights'
              ? roster.map((member) => (
                  <Row
                    key={member.id}
                    style={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                    }}
                  >
                    <Row
                      style={{ gap: theme.spacing.sm, alignItems: 'center', flex: 1, minWidth: 0 }}
                    >
                      <Avatar name={displayName(member)} ghost={isGhost(member)} size={32} />
                      <Text variant="body" numberOfLines={1}>
                        {displayName(member, profile?.id)}
                      </Text>
                    </Row>
                    <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
                      <TextInput
                        value={nightCounts[member.id] ?? ''}
                        onChangeText={(text) =>
                          setNightCounts((current) => ({
                            ...current,
                            [member.id]: text.replace(/[^0-9]/g, ''),
                          }))
                        }
                        keyboardType="number-pad"
                        placeholder="0"
                        placeholderTextColor={theme.color.textFaint}
                        accessibilityLabel={displayName(member, profile?.id)}
                        style={{
                          width: 56,
                          minHeight: 44,
                          textAlign: 'right',
                          fontSize: 16,
                          fontWeight: '700',
                          color: theme.color.text,
                          backgroundColor: theme.color.bg,
                          borderRadius: theme.radius.sm,
                          paddingHorizontal: theme.spacing.sm,
                        }}
                      />
                      <Text variant="micro" tone="muted">
                        {t.expense.presets.nightUnit}
                      </Text>
                    </Row>
                  </Row>
                ))
              : null}

            {presetEditor === 'ride'
              ? roster.map((member) => (
                  <ChoiceRow
                    key={member.id}
                    label={displayName(member, profile?.id)}
                    selected={riderPick.includes(member.id)}
                    onPress={() => toggleRider(member.id)}
                    leading={
                      <Avatar name={displayName(member)} ghost={isGhost(member)} size={32} />
                    }
                  />
                ))
              : null}

            {presetEditor === 'car'
              ? roster.map((member) => {
                  const isRider = riderPick.includes(member.id);
                  const isDriver = exemptDriver === member.id;
                  return (
                    <View key={member.id} style={{ gap: theme.spacing.xs }}>
                      <Row
                        style={{
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: theme.spacing.md,
                        }}
                      >
                        <Pressable
                          onPress={() => toggleRider(member.id)}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: isRider }}
                          accessibilityLabel={displayName(member, profile?.id)}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: theme.spacing.sm,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <Ionicons
                            name={isRider ? 'checkmark-circle' : 'ellipse-outline'}
                            size={iconSize.lg}
                            color={isRider ? theme.color.brand : theme.color.textFaint}
                          />
                          <Text variant="body" numberOfLines={1}>
                            {displayName(member, profile?.id)}
                          </Text>
                        </Pressable>
                        {isRider ? (
                          <Pressable
                            onPress={() =>
                              setExemptDriver((current) => (isDriver ? null : member.id))
                            }
                            accessibilityRole="radio"
                            accessibilityState={{ selected: isDriver }}
                            accessibilityLabel={t.expense.presets.carDriver}
                            hitSlop={6}
                          >
                            <Text variant="micro" tone={isDriver ? 'brand' : 'faint'}>
                              {t.expense.presets.carDriver}
                            </Text>
                          </Pressable>
                        ) : null}
                      </Row>
                      {isRider && !isDriver ? (
                        <AmountField
                          currency={currency}
                          value={fuelAmounts[member.id] ?? 0n}
                          onChange={(value) =>
                            setFuelAmounts((current) => ({ ...current, [member.id]: value }))
                          }
                        />
                      ) : null}
                    </View>
                  );
                })
              : null}

            {presetEditor === 'car' ? (
              <Text variant="micro" tone="muted">
                {t.expense.presets.carFuel}
              </Text>
            ) : null}

            {presetEditor === 'treat'
              ? roster.map((member) => (
                  <ChoiceRow
                    key={member.id}
                    label={displayName(member, profile?.id)}
                    selected={(treatHostPick ?? myMemberId) === member.id}
                    onPress={() => setTreatHostPick(member.id)}
                    leading={
                      <Avatar name={displayName(member)} ghost={isGhost(member)} size={32} />
                    }
                  />
                ))
              : null}

            <Button
              label={t.expense.presets.apply}
              onPress={() =>
                presetEditor === 'nights'
                  ? applyNights()
                  : presetEditor === 'car'
                    ? applyCar()
                    : presetEditor === 'ride'
                      ? applyRide()
                      : applyTreat()
              }
            />
          </View>
        </SheetOverlay>
      ) : null}

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

      {/* Make a tag on the spot, from the picker's "＋ New tag" chip. */}
      <TagEditorSheet open={editingTag} onClose={() => setEditingTag(false)} />
    </Screen>
  );
}
