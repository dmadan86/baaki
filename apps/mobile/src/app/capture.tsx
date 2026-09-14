import { useEffect, useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  currencySymbol,
  dayNumber,
  guessCategory,
  parseReceiptText,
  CategoryId,
  type CategoryMeta,
  type ExpenseLocation,
  type HeuristicReceipt,
  type PaymentMethod,
  byNewest,
} from '@waves/core';
import {
  Button,
  Callout,
  Card,
  Divider,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { GroupMark } from '@/components/GroupMark';
import { CategoryRow, CategorySheet } from '@/components/Category';
import { TagEditorSheet } from '@/components/TagEditorSheet';
import { PaymentMethodRow, PaymentMethodSheet } from '@/components/PaymentMethodPicker';
import { LocationField } from '@/components/LocationField';
import { ZoomableImage } from '@/components/ZoomableImage';
import { COMMON_CURRENCIES } from '@/components/CurrencyRate';
import { AmountHeader } from '@/components/expense/AmountHeader';
import { DescriptionField } from '@/components/expense/DescriptionField';
import { ExpenseHeader } from '@/components/expense/ExpenseHeader';
import { ChoiceRow, SheetOverlay } from '@/components/expense/SheetOverlay';
import { DetailRow, DetailRows } from '@/components/DetailRows';
import {
  useCreateCapture,
  useDeleteCapture,
  useGroups,
  useHomeSummary,
  useUpdateCapture,
} from '@/data/hooks';
import { useUpsertPersonalRecord } from '@/data/personal';
import {
  groupLabel,
  GroupType,
  type CaptureRow,
  type GroupRow,
  type MemberRow,
} from '@/data/types';
import { useAuth } from '@/lib/auth';
import { useDefaultCurrency } from '@/lib/currency';
import { usePersonalOffered } from '@/lib/guestGuard';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { assignCaptureHref, captureDraftFields } from '@/lib/captureAssign';
import { planPersonalPlacement } from '@/lib/personalPlacement';
import { dateFrom, isoDate, showDate } from '@/lib/expenseDay';
import { captureReceipt, type PickedImage } from '@/lib/image';
import { router } from '@/lib/navigation';
import { recogniseReceipt } from '@/lib/ocr';
import { uploadCapturePhoto } from '@/data/api';
import { StorageCapError } from '@/lib/storage';
import { friendlyError } from '@/lib/errors';

/**
 * An OCR-derived number turned into a safe minor-unit bigint.
 *
 * The values here come off a photograph through a heuristic parser, so they are
 * never fully trusted: a stray `NaN`, an `Infinity`, or a non-integer would make
 * `BigInt()` throw — and a throw during render is a white screen, not a bad
 * total. Anything that is not a finite number collapses to zero, which the UI
 * already knows how to show (an amount the person types themselves).
 */
function safeMinor(value: number): bigint {
  return Number.isFinite(value) ? BigInt(Math.round(value)) : 0n;
}

/**
 * A minor-unit amount carried in as a query param, made safe. It is a string
 * from the URL, so only a run of digits is trusted; anything else (empty, a
 * sign, a decimal, junk) becomes zero — the same "type it yourself" fallback the
 * OCR path uses. No `BigInt()` on unvalidated text, which would throw.
 */
function amountFromParam(value: string | undefined): bigint {
  if (!value || !/^\d+$/.test(value)) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * A JSON blob carried in as a query param, parsed back to an object. Params are
 * strings from the URL, so a malformed or absent value is simply `null` — the
 * same "nothing carried" the edit path treats as a fresh field, never a throw.
 */
function jsonParam<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Today as `YYYY-MM-DD` in the phone's own zone — never midnight UTC. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Today as `YYYY-MM-DD` in a given timezone, never the reader's — so a trip's
    "running today" is judged in the trip's own zone (the same rule the dashboard
    and planner use). */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return todayIso();
  }
}

/** A trip whose date range spans today in its own timezone — the one destination
    worth pulling to the front of the picker. */
function isCurrentTrip(group: GroupRow): boolean {
  if (group.type !== GroupType.Trip) return false;
  return dayNumber(todayIn(group.time_zone), group.start_date, group.end_date) !== null;
}

/**
 * The scan nonces already consumed, at module scope so the set survives a
 * remount.
 *
 * The dashboard camera opens this screen with `?scan=<nonce>` to mean "go
 * straight to the camera". Android recreates the JS activity when it returns
 * from the separate native camera activity, which remounts this screen with the
 * same URL still carrying that nonce — a `useRef` guard would reset and fire the
 * camera a second time on a loop. A module-level Set is the fix: a nonce is
 * recorded the first time it is seen and never acted on again, yet a genuinely
 * new tap carries a fresh `Date.now()` nonce and so still opens the camera.
 */
const consumedScans = new Set<string>();

/**
 * Catch an expense before it has a group.
 *
 * Deliberately the short version of add-expense: an amount, a note, a category,
 * a date, how it was paid, and optionally a photo of the bill — never a payer
 * or a split, because those describe how a bill is shared among a group's
 * members, and there is no group here by default. "Decide later" (`null`) is
 * that default, and it stays exactly this short.
 *
 * Picking a real group in the facts card below is a different thing entirely:
 * it hands the draft straight to that group's own add-expense form (the same
 * hand-off the inbox uses to assign a capture — `captureDraftFields` +
 * `assignCaptureHref`), where payer and split live already. That screen was
 * the honest place to ask them even before this hand-off existed — assigning a
 * capture always finished there — so a capture that already knows its group
 * now walks straight into the same form it was always going to end up on,
 * carrying everything typed here so far, rather than asking a shorter version
 * of the same two questions twice in two different shapes. The photo is read
 * on the phone (A5) so its text can ride along as `rawText` if the capture
 * stays here (no group); a group hand-off carries neither the photo nor that
 * text, matching the inbox's own assign, which has never carried them either —
 * a bill attached at capture time is not yet reachable from the expense the
 * hand-off is about to create.
 */
export default function CaptureScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // What the pinned Save bar leaves beneath itself for the system navigation
  // bar, from the helper every scrolling screen uses for the same question.
  const clearance = useScreenClearance(theme.spacing.md);
  const { t, locale } = useStrings();
  const createCapture = useCreateCapture();
  const updateCapture = useUpdateCapture();
  // `scan` fires the camera on entry; `editId` opens an existing draft to fix
  // (from the inbox pencil), with every field it carries prefilled below; the
  // rest are an optional prefill when this screen is reached from a group's
  // "just for me" affordance — the amount, note and currency already typed there
  // carry over so nothing is entered twice. On the private-route prefill a group
  // is never carried; on an edit it is, so the draft keeps its intended
  // destination.
  const {
    scan,
    editId,
    amount: amountParam,
    desc: descParam,
    cur: curParam,
    category: categoryParam,
    categoryMeta: categoryMetaParam,
    date: dateParam,
    payment: paymentParam,
    targetGroupId: targetGroupParam,
    location: locationParam,
    note: noteParam,
    photoPath: photoPathParam,
    rawText: rawTextParam,
    parsed: parsedParam,
  } = useLocalSearchParams<{
    scan?: string;
    editId?: string;
    amount?: string;
    desc?: string;
    cur?: string;
    category?: string;
    categoryMeta?: string;
    date?: string;
    payment?: string;
    targetGroupId?: string;
    location?: string;
    note?: string;
    photoPath?: string;
    rawText?: string;
    parsed?: string;
  }>();

  // Editing an existing draft rather than drafting a new one: the submit updates
  // the row in place, the photo already stored is kept unless a new one is
  // taken, and the header says so.
  const isEditing = Boolean(editId);

  // Chosen here so the photo can be uploaded under it before the row exists —
  // the storage path keys off the capture id, exactly as add-expense seeds its
  // own expense id up front.
  // On an edit this is the existing draft's id, so the update targets that row;
  // on a fresh draft a new id, chosen up front so a photo can be uploaded under
  // it before the row exists.
  const [captureId] = useState(() => editId ?? randomUUID());

  // The currency starts device-derived (INR when the region is unknown, never a
  // US default) but is the person's to change here — the currency pill under the
  // amount opens the picker. A traveller paying in a currency their phone's
  // region does not use should not have to leave and reopen the group form.
  const defaultCurrency = useDefaultCurrency();
  // Until the person picks a currency by hand, it follows the account default —
  // which can arrive a beat after this screen mounts, once the profile loads, so
  // an untouched capture is never saved in the device currency when the account
  // says something else. Their pick then wins and sticks. Derived, not synced in
  // an effect, so there is no setState-in-effect and no first-render snapshot.
  const [pickedCurrency, setPickedCurrency] = useState<string | null>(() => curParam ?? null);
  const currency = pickedCurrency ?? defaultCurrency;
  const [pickingCurrency, setPickingCurrency] = useState(false);

  const [amount, setAmount] = useState<bigint>(() => amountFromParam(amountParam));
  const [description, setDescription] = useState(() => descParam ?? '');
  // A built-in id or a custom tag's id; `categoryMeta` carries the display of a
  // custom tag so it rides onto the capture (extends TDR §8). On an edit both
  // come from the draft; otherwise Food & drink is the default.
  const [category, setCategory] = useState<string | null>(() => categoryParam || CategoryId.Food);
  const [categoryMeta, setCategoryMeta] = useState<CategoryMeta | null>(() =>
    jsonParam<CategoryMeta>(categoryMetaParam),
  );
  // On an edit the category is already the draft's own — treat it as chosen so
  // the description guesser below does not move it out from under the person.
  const [categoryChosen, setCategoryChosen] = useState(() => isEditing);
  // The create-tag sheet, opened from the "＋ New tag" row in the category
  // sheet.
  const [editingTag, setEditingTag] = useState(false);
  // The category and payment-rail pickers, opened from their row in the facts
  // card below rather than drawn as a lane of chips — see that card's own
  // comment for why.
  const [pickingCategory, setPickingCategory] = useState(false);
  const [pickingPayment, setPickingPayment] = useState(false);
  const [date, setDate] = useState<string>(() => dateParam ?? todayIso());
  // A stored bill's path and the OCR text and parsed blob that rode with the
  // draft — kept as-is through an edit so saving never wipes the receipt, the
  // recovered text, or the voice-batch id the parsed blob carries. A freshly
  // scanned receipt below replaces them.
  const [keptPhotoPath] = useState<string | null>(() => photoPathParam ?? null);
  const [keptParsed] = useState<Record<string, unknown> | null>(() =>
    jsonParam<Record<string, unknown>>(parsedParam),
  );
  const [editingDate, setEditingDate] = useState(false);
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  // Full-screen preview of the attached bill, opened by tapping the thumbnail.
  const [previewing, setPreviewing] = useState(false);
  const [rawText, setRawText] = useState<string | null>(() => rawTextParam ?? null);
  // What the on-device parser recovered from the bill: total, item count, lines.
  // Null until a receipt is read; low `confidence` means show it as a draft.
  const [parsed, setParsed] = useState<HeuristicReceipt | null>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Camera-first: entered from the dashboard camera icon (`?scan`), this screen
  // opens the camera and shows nothing but a launcher until a photo is taken —
  // the form is not what the person asked for, the camera is. Seeded false on a
  // remount whose nonce is already consumed (Android recreates the screen when
  // it returns from the native camera) so the form is not blocked a second time.
  const [awaitingScan, setAwaitingScan] = useState<boolean>(() =>
    scan ? !consumedScans.has(scan) : false,
  );

  // How it was paid and which group it is bound for — both tags that ride the
  // capture and survive until it is assigned. Payment defaults to cash (the most
  // common answer, and one fewer tap for it); the group defaults to "decide
  // later" (null), which keeps the capture in the inbox.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(() =>
    isEditing ? ((paymentParam as PaymentMethod | undefined) ?? null) : 'cash',
  );
  const [targetGroupId, setTargetGroupId] = useState<string | null>(() => targetGroupParam ?? null);
  // "Just me": this spend is nobody else's, so it is not a draft waiting for a
  // group at all — it is a personal-ledger entry (A48). Held apart from
  // `targetGroupId` rather than encoded as a magic id, because it does not name
  // a group and a sentinel that looked like one would eventually be treated as
  // one. The two are mutually exclusive and `pickDestination` keeps them so.
  const [justMe, setJustMe] = useState(false);
  const [pickingGroup, setPickingGroup] = useState(false);
  // Where it happened (A43). Optional and opt-in; null until the person taps
  // "Add location" and grants the permission — or, on an edit, the place the
  // draft already carried.
  const [location, setLocation] = useState<ExpenseLocation | null>(() =>
    jsonParam<ExpenseLocation>(locationParam),
  );

  const { profile } = useAuth();
  const upsertPersonal = useUpsertPersonalRecord();
  const deleteCapture = useDeleteCapture();
  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);
  const groupRows = groups.data ?? [];
  const groupNameHints = groupRows.map((group) => group.name ?? '').filter(Boolean);
  const targetGroup = groupRows.find((group) => group.id === targetGroupId) ?? null;
  const targetGroupName = justMe
    ? t.voice.justMe
    : targetGroup
      ? groupLabel(targetGroup, summary.membersFor(targetGroup.id), profile?.id)
      : t.captures.decideLater;

  // Category starts on Food & drink — the most common capture, one fewer tap for
  // it. The guess then follows the description until the row is tapped and a
  // choice made in its sheet, at which point it stops moving under the user's
  // finger (the same rule add-expense uses). Seeding guessedFrom to the initial
  // empty description means the guess does not fire on mount, so that default
  // survives until the person types.
  // Seeded to the carried-in note (or empty) so the category guesser does not
  // fire on mount and overwrite the Food default before the person types.
  const [guessedFrom, setGuessedFrom] = useState<string | null>(() => descParam ?? '');
  if (!categoryChosen && description !== guessedFrom) {
    setGuessedFrom(description);
    // Keep the current category when the description matches no bucket:
    // guessCategory returns null for unrecognised text, and clearing on null
    // would wipe the Food default (or a prior guess) leaving the row blank.
    const guess = guessCategory(description);
    if (guess) {
      setCategory(guess);
      // The guess is always a built-in, so it carries no custom snapshot.
      setCategoryMeta(null);
    }
  }

  const applyDate = (event: DateTimePickerEvent, picked?: Date): void => {
    if (Platform.OS === 'android') setEditingDate(false);
    if (event.type === 'dismissed' || !picked) return;
    setDate(isoDate(picked));
  };

  /**
   * Photograph the bill and keep it. On-device OCR (A5) reads the text so it can
   * travel with the capture as `rawText`; there is no group here, so nothing is
   * sent to be parsed — the amount stays the user's to type.
   */
  const addReceipt = async (opts?: { scanEntry?: boolean }): Promise<void> => {
    setError(null);

    // The camera and the document scanner are native, and a native failure —
    // a denied permission mid-flow, a scanner that will not open, an out-of-
    // memory during the resize — must not escape as an unhandled rejection and
    // take the screen down. A failed capture is simply no photo: the person
    // types the amount, exactly as before this feature existed.
    let picked: PickedImage | null = null;
    try {
      picked = await captureReceipt();
    } catch {
      picked = null;
    }
    if (!picked) {
      // Cancelled at the camera. On the camera-first entry there is no form to
      // fall back to — the person asked for the camera, backed out, so leave
      // rather than stranding them on an empty capture they never opened.
      if (opts?.scanEntry) router.back();
      return;
    }

    // A photo exists now: on the camera-first entry, reveal the form (with the
    // shot and its OCR) — this is the moment the person confirmed "okay".
    if (opts?.scanEntry) setAwaitingScan(false);
    setPhoto(picked);
    setScanning(true);
    try {
      const recognised = await recogniseReceipt(picked.uri);
      setRawText(recognised?.text ?? null);

      // Read the total and the line items off the OCR text on the phone (A34 /
      // A5). The model path (`receipt-parse`) stays the eventual source of truth
      // once it is funded, but the heuristic is what makes the amount appear now
      // rather than leaving it for the user to type off the photo.
      const receipt = recognised ? parseReceiptText(recognised.text, { currency }) : null;
      setParsed(receipt);
      if (receipt && receipt.grandTotal > 0) {
        setAmount(safeMinor(receipt.grandTotal));
        if (receipt.merchant && description.trim().length === 0) setDescription(receipt.merchant);
      }
    } catch {
      setRawText(null);
      setParsed(null);
    } finally {
      setScanning(false);
    }
  };

  // "Straight to the camera": when opened from the dashboard scanner icon, fire
  // the capture once for this nonce. The module-level `consumedScans` set is
  // what makes it exactly once even across the remount Android forces when it
  // returns from the native camera (see the set's own note).
  useEffect(() => {
    if (scan && !consumedScans.has(scan)) {
      consumedScans.add(scan);
      // Deferred a microtask so the state addReceipt sets on entry does not run
      // synchronously inside the effect body — the same async-callback shape the
      // other effects here use. The camera still opens effectively at once.
      void Promise.resolve().then(() => addReceipt({ scanEntry: true }));
    }
    // addReceipt is stable enough for a one-shot; deps intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan]);

  const submit = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      // "Just me" does not make a draft. A draft is a spend waiting to be told
      // who it was with, and this one has been told: nobody. So it goes
      // straight to the private ledger as a finished entry (A48) and there is
      // no inbox row left behind to answer later.
      //
      // What to write is `planPersonalPlacement`'s decision, not this screen's
      // — the same function the Review screen and Bank messages file through,
      // so a lunch kept for oneself is the same row whichever door it came in
      // by, including taking the capture's own id so a retry rewrites rather
      // than duplicates.
      //
      // No photo is uploaded on this path. The personal ledger keeps amounts,
      // not images, so an upload here would spend somebody's storage on a file
      // nothing could ever show them. The sheet says so before they choose.
      if (justMe) {
        const plan = planPersonalPlacement({
          captures: [
            captureRowForPersonal({
              captureId,
              ownerId: profile?.id ?? '',
              description: description.trim(),
              category,
              categoryMeta,
              date,
              currency,
              amount,
            }),
          ],
          fallbackDescription: t.voice.anExpense,
        });
        const write = plan.writes[0];
        if (!write) {
          setError(t.captures.couldNotSave);
          return;
        }
        await upsertPersonal.mutateAsync({
          recordId: write.recordId,
          recordKind: 'txn',
          data: write.data,
        });
        // Editing a draft into the private ledger consumes it. Only once the
        // record is queued: a draft closed before its record exists is a spend
        // that quietly disappeared.
        if (isEditing) await deleteCapture.mutateAsync(captureId);
        router.back();
        return;
      }

      // The bill photo goes to the person's own R2 storage under the capture id
      // (A44) — the `captures` bucket is keyed by the owner, so no group has to
      // exist yet. Best-effort: a failed upload (offline, out of storage) must
      // never cost the capture itself, so on any trouble the photo path stays
      // null and only the parsed fields (amount, text, itemisation) ride the
      // sync. The returned path is written onto the capture row so it can be
      // viewed later from any of the owner's devices.
      // On an edit, the draft's stored photo is the starting point and is kept
      // unless a new one is taken here; on a fresh draft there is none until one
      // is. A failed upload leaves whatever was already there rather than
      // dropping it.
      let photoPath: string | null = keptPhotoPath;
      let photoError: unknown = null;
      if (photo && profile?.id) {
        try {
          photoPath = await uploadCapturePhoto({
            ownerUserId: profile.id,
            captureId,
            base64: photo.base64,
            mimeType: photo.mimeType,
          });
        } catch (caught) {
          photoError = caught;
        }
      }

      const input = {
        captureId,
        description: description.trim(),
        category,
        categoryMeta,
        expenseDate: date,
        currency,
        amount,
        // An edit keeps the note the draft already had — the form has no note
        // field, so there is nothing here to overwrite it with.
        notes: noteParam ?? null,
        photoPath,
        rawText,
        // A freshly scanned receipt wins; otherwise keep the blob the draft
        // arrived with, so an edit never loses its itemisation or the
        // voice-batch id that keeps a spoken item tied to its batch.
        parsed: parsed ? (parsed as unknown as Record<string, unknown>) : keptParsed,
        paymentMethod,
        targetGroupId,
        location,
      };
      if (isEditing) await updateCapture.mutateAsync({ ...input, captureId });
      else await createCapture.mutateAsync(input);

      // The capture is saved — its fields are the point. If the bill *photo*
      // could not be stored because the account is out of room, say so and stay:
      // an over-cap refusal is the one photo failure the person can act on, and
      // the fields are already safe (createCapture is idempotent on a retry). An
      // offline failure stays best-effort silent — the photo is optional and R2
      // has no offline path, so the parsed fields sync now and the photo does not.
      if (photoError instanceof StorageCapError) {
        setError(t.storage.full);
        return;
      }
      router.back();
    } catch (caught) {
      setError(friendlyError(caught, t.captures.couldNotSave, 'capture.save'));
    } finally {
      setSaving(false);
    }
  };

  // Camera-first entry: nothing but a launcher behind the native camera, so the
  // form never flashes up before a photo is taken. The scan effect above has
  // already opened the camera; on "okay" it flips this off and the form below
  // renders with the shot, on cancel it navigates back.
  if (awaitingScan) {
    return (
      <Screen edges={['top']}>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.md,
          }}
        >
          <ActivityIndicator color={theme.color.brand} />
          <Text variant="caption" tone="muted">
            {t.captures.openingCamera}
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen edges={['top']}>
      <View style={{ paddingHorizontal: theme.spacing.xl }}>
        <ExpenseHeader title={isEditing ? t.captures.editTitle : t.captures.newTitle} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Amount-forward hero: the number is the point of this screen, so it
            leads — big and centred, with the currency it is counted in a tap
            below it (the Splitwise/PayPal amount-first pattern). Shared with
            add-expense. */}
        <AmountHeader
          currency={currency}
          amount={amount}
          onAmountChange={setAmount}
          onPressCurrency={() => setPickingCurrency(true)}
        />

        {/* The bill, right under the amount — the order add-expense reads a bill
            in, and for the same reason: scanning one fills in the amount above
            and the note below, so it belongs before the fields it populates, not
            after them. It used to sit at the foot of this form, last of
            everything, which meant the one shortcut that saves the most typing
            was the one thing a person had to scroll past six other fields to
            find.

            Simpler than add-expense's pair of buttons on purpose: this capture
            has no group yet, so there is no metered `scanReceipt` edge function
            to call and no per-group receipt cap to draw around it — only the
            on-device camera and OCR (A5), which is `addReceipt` below. Nor is
            there a gallery to attach an existing photo from; a capture is
            usually filed at the till, camera in hand, not from an old
            screenshot. */}
        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="subheading">{t.captures.receipt}</Text>
            <Button
              label={t.captures.addReceipt}
              variant="secondary"
              size="sm"
              disabled={scanning || saving}
              onPress={() => void addReceipt()}
              icon={<Ionicons name="camera-outline" size={iconSize.md} color={theme.color.brand} />}
            />
          </Row>
          {scanning ? <ActivityIndicator color={theme.color.brand} /> : null}
          {photo ? (
            // Tap the thumbnail to see the whole bill: the cropped cover view is
            // enough to confirm the right photo attached, but reading the lines
            // needs the full frame.
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={t.captures.previewReceipt}
              onPress={() => setPreviewing(true)}
              style={{ borderRadius: theme.radius.md, overflow: 'hidden' }}
            >
              <Image
                source={{ uri: photo.uri }}
                style={{ width: '100%', height: 180 }}
                contentFit="cover"
                transition={150}
              />
              <View
                style={{
                  position: 'absolute',
                  right: theme.spacing.sm,
                  bottom: theme.spacing.sm,
                  padding: theme.spacing.xs,
                  borderRadius: theme.radius.sm,
                  backgroundColor: 'rgba(10, 10, 26, 0.55)',
                }}
              >
                <Ionicons name="expand-outline" size={iconSize.sm} color="#ffffff" />
              </View>
            </Pressable>
          ) : null}

          {/* What the phone read off the bill. A confident parse shows the lines
              and the total it filled in; a scan it could not make sense of says
              so and leaves the amount to the person. */}
          {parsed && parsed.items.length > 0 ? (
            <View style={{ gap: theme.spacing.sm }}>
              <Divider />
              <Row style={{ justifyContent: 'space-between' }}>
                <Text variant="caption" tone="muted">
                  {t.captures.itemizedTitle}
                </Text>
                <Text variant="caption" tone="muted">
                  {plural(locale, parsed.items.length, t.captures.itemCount)}
                </Text>
              </Row>
              {parsed.items.map((item, index) => (
                <Row
                  key={`${item.label}-${index}`}
                  style={{ justifyContent: 'space-between', gap: theme.spacing.md }}
                >
                  <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
                    {item.label}
                  </Text>
                  <MoneyText
                    amount={safeMinor(item.total)}
                    currency={currency as never}
                    locale={locale}
                    variant="body"
                  />
                </Row>
              ))}
              <Divider />
              <Row style={{ justifyContent: 'space-between' }}>
                <Text variant="subheading">{t.captures.amount}</Text>
                <MoneyText
                  amount={safeMinor(parsed.grandTotal)}
                  currency={currency as never}
                  locale={locale}
                  variant="subheading"
                />
              </Row>
            </View>
          ) : parsed && photo ? (
            <Callout tone="info">{t.captures.couldNotRead}</Callout>
          ) : null}
        </Card>

        {/* Description, as a single underlined field rather than a boxed card —
            with the mic to speak it instead of type (A5). Group names are handed
            to the recogniser as hints — a general model mangles Indian names,
            and a note like "dinner with Ravi" is exactly where they turn up. */}
        <DescriptionField
          value={description}
          onChange={setDescription}
          placeholder={t.captures.descriptionPlaceholder}
          accessibilityLabel={t.captures.description}
          hints={groupNameHints}
        />

        {/* Where it happened (A43) — optional, opt-in, never a background track. */}
        <LocationField value={location} onChange={setLocation} />

        {/* What for, paid with, destination and date, folded into one card of
            divided rows rather than four scattered controls — the facts a
            capture carries, grouped so it reads as one block, the same
            `DetailRows` the group expense form and the expense screen wear.

            What for and paid with used to be lanes of chips under the
            description — a picker each, so choosing them read as a different
            kind of question from the group and the date sitting in their own
            card below. Now all four are the same kind of row: a short,
            already-chosen answer, changed from a sheet. `CategoryRow` and
            `PaymentMethodRow` are the exact rows add-expense's own facts card
            uses for the same two fields, so a capture assigned into a group
            keeps reading as the same two facts rather than restating them in a
            different shape.

            "Decide later" is the default group, and with it chosen this card
            asks four things about a capture and nothing about splitting — there
            is nobody to split it among yet. Picking any other group from this
            row's sheet does not stay on this card at all: it hands the draft
            straight to that group's add-expense form, where who paid and how it
            is split are asked for real (see this screen's own header comment).

            The date picker is wrapped with its row rather than left as a
            sibling: `DetailRows` puts a hairline in every gap between its
            children, so an unfolded date wheel counted as a row of its own
            would be ruled off from the row that opened it. */}
        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          <DetailRows>
            <CategoryRow
              value={category}
              meta={categoryMeta}
              onPress={() => setPickingCategory(true)}
            />
            <PaymentMethodRow value={paymentMethod} onPress={() => setPickingPayment(true)} />
            <DetailRow
              icon={targetGroup ? 'people' : 'people-outline'}
              iconColor={targetGroup ? theme.color.brand : theme.color.textMuted}
              label={t.captures.group}
              value={targetGroupName}
              placeholder={!targetGroup}
              onPress={() => setPickingGroup(true)}
              accessibilityLabel={`${t.captures.group}: ${targetGroupName}`}
            />
            <View>
              <DetailRow
                icon="calendar-outline"
                label={t.captures.date}
                value={showDate(date, locale)}
                onPress={() => setEditingDate(true)}
                accessibilityLabel={`${t.captures.date}: ${showDate(date, locale)}`}
              />
              {editingDate ? (
                <DateTimePicker
                  value={dateFrom(date)}
                  mode="date"
                  onChange={applyDate}
                  // A capture is caught now or in the recent past — a spend cannot
                  // have happened tomorrow.
                  maximumDate={new Date()}
                />
              ) : null}
            </View>
          </DetailRows>
        </Card>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
          // The bar carries the navigation-bar inset itself rather than letting
          // the Screen hold it off the bottom edge: its fill and hairline reach
          // the edge, Save keeps a breath under it, and the picker sheets — which
          // are absolutely positioned inside this same tree — can finally reach
          // the bottom of the screen instead of stopping at the Screen's padding.
          paddingBottom: clearance,
          gap: theme.spacing.sm,
          borderTopWidth: 1,
          borderTopColor: theme.color.border,
          backgroundColor: theme.color.bg,
        }}
      >
        {error ? <Callout tone="negative">{error}</Callout> : null}
        {saving ? <ActivityIndicator color={theme.color.brand} /> : null}
        <Button
          label={t.captures.save}
          size="lg"
          fullWidth
          disabled={amount === 0n || saving}
          onPress={() => void submit()}
        />
      </View>

      {/* What it was for, from the facts card's row. Picking one closes the
          sheet; "＋ New tag" swaps this sheet for the tag editor rather than
          stacking one over the other — the same handoff add-expense uses. */}
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

      {/* How it was paid, from the facts card's row. `allowDeselect` keeps "not
          said" reachable: tapping the rail already chosen clears it, exactly as
          the chip lane this replaced let a second tap on the lit chip do. */}
      {pickingPayment ? (
        <PaymentMethodSheet
          value={paymentMethod}
          allowDeselect
          onChange={(picked) => {
            setPaymentMethod(picked);
            setPickingPayment(false);
          }}
          onClose={() => setPickingPayment(false)}
        />
      ) : null}

      {/* Currency picker, as a sheet over the form. The shortlist is the same one
          the group expense form offers (COMMON_CURRENCIES), so a person meets the
          same currencies in both places. */}
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
                onPress={() => {
                  setPickedCurrency(code);
                  setPickingCurrency(false);
                }}
              />
            ))}
          </View>
        </SheetOverlay>
      ) : null}

      {/* Destination picker, as a sheet over the form rather than a route away:
          "Decide later" pinned at the top so the default is always reachable,
          then a running trip if one is on today, the groups used most recently,
          and the rest — so the group you mean is usually one of the first taps.

          Picking "Decide later" is the only choice that stays a choice on this
          screen — it just records the null destination, same as ever. Picking
          any real group hands off instead: `captureDraftFields` reads whatever
          is typed so far off this screen's own state, and `assignCaptureHref`
          turns that into the exact params the inbox's assign already sends the
          group's add-expense form, so the two arrive at that screen the same
          way. Pushed, not replaced — backing out of add-expense with nothing
          saved returns here with this draft untouched, the group row still
          reading whatever it read before the tap. */}
      {pickingGroup ? (
        <SheetOverlay title={t.captures.groupPickerTitle} onClose={() => setPickingGroup(false)}>
          <Text variant="caption" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
            {t.captures.groupPickerBody}
          </Text>
          <GroupPicker
            groups={groupRows}
            selectedId={targetGroupId}
            justMe={justMe}
            photoAttached={photo !== null || keptPhotoPath !== null}
            profileId={profile?.id ?? null}
            membersFor={summary.membersFor}
            t={t}
            onPick={(choice) => {
              setPickingGroup(false);
              if (choice.kind === 'later') {
                setTargetGroupId(null);
                setJustMe(false);
                return;
              }
              // Unlike a group, this does not leave for the add-expense form —
              // there is nothing to ask. It is a destination the Save button
              // then honours, so the amount still goes through the same field,
              // the same validation and the same button as every other capture.
              if (choice.kind === 'me') {
                setTargetGroupId(null);
                setJustMe(true);
                return;
              }
              const id = choice.id;
              router.push(
                assignCaptureHref(
                  captureDraftFields({
                    captureId,
                    description,
                    amount,
                    category,
                    categoryMeta,
                    location,
                    paymentMethod,
                    date,
                  }),
                  id,
                ),
              );
            }}
          />
        </SheetOverlay>
      ) : null}

      {/* The bill at full size — pinch to zoom, drag to pan, tap the corner to
          close. Same viewer as the saved receipt, so it reads the same before
          the row exists. */}
      <Modal
        visible={previewing && photo !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewing(false)}
        statusBarTranslucent
      >
        <View style={{ flex: 1, backgroundColor: '#000000' }}>
          {photo ? <ZoomableImage uri={photo.uri} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.close}
            onPress={() => setPreviewing(false)}
            style={{
              position: 'absolute',
              top: insets.top + theme.spacing.md,
              right: theme.spacing.xl,
              padding: theme.spacing.sm,
              borderRadius: theme.radius.pill,
              backgroundColor: 'rgba(255, 255, 255, 0.15)',
            }}
          >
            <Ionicons name="close" size={iconSize.md} color="#ffffff" />
          </Pressable>
        </View>
      </Modal>

      {/* Make a tag on the spot, from the category sheet's "＋ New tag" row. */}
      <TagEditorSheet open={editingTag} onClose={() => setEditingTag(false)} />
    </Screen>
  );
}

/**
 * The form's fields, dressed as the row `planPersonalPlacement` reads.
 *
 * The planner takes a capture because two of its three callers have one. This
 * one does not — the draft is still in the form and, on the "just me" path,
 * never becomes a row at all. So the fields are handed over in the shape the
 * planner expects, with the rest filled as a draft made here would have had
 * them rather than left undefined, and the planner makes the same decisions it
 * makes for everybody else.
 */
function captureRowForPersonal(input: {
  captureId: string;
  ownerId: string;
  description: string;
  category: string | null;
  categoryMeta: CategoryMeta | null;
  date: string;
  currency: string;
  amount: bigint;
}): CaptureRow {
  return {
    id: input.captureId,
    owner_user_id: input.ownerId,
    description: input.description,
    category: input.category,
    category_meta: input.categoryMeta,
    expense_date: input.date,
    currency: input.currency,
    amount: input.amount.toString(),
    notes: null,
    // Never uploaded on this path — the private ledger keeps amounts, not
    // images, and the sheet says so before the choice is made.
    photo_path: null,
    raw_text: null,
    parsed: null,
    payment_method: null,
    target_group_id: null,
    location: null,
    status: 'open' as CaptureRow['status'],
    assigned_expense_id: null,
    assigned_group_id: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * What the destination sheet can answer.
 *
 * Three answers, not "a group id or null": "just me" is neither a group nor
 * the absence of one, and encoding it as a sentinel id would leave something
 * that looks like a group id in a variable every other reader treats as one.
 */
type CaptureDestination = { kind: 'later' } | { kind: 'me' } | { kind: 'group'; id: string };

/**
 * The group destinations, grouped so the one you mean is near the top:
 *
 *   1. "Decide later" — pinned, the default that keeps the capture in the inbox.
 *   2. Current trip — any trip whose dates span today (its own timezone).
 *   3. Recently used — the most recently created groups, a proxy for recency
 *      since the group model has no last-touched field to sort by.
 *   4. All groups — everything not already shown above.
 *
 * Section headers appear only once there is more than one section to separate;
 * with a single short list the picker stays flat, exactly as it was before.
 */
function GroupPicker({
  groups,
  selectedId,
  justMe,
  photoAttached,
  profileId,
  membersFor,
  t,
  onPick,
}: {
  groups: readonly GroupRow[];
  selectedId: string | null;
  /** Whether "Just me" is the current answer. Never true alongside a group. */
  justMe: boolean;
  /** Whether a bill photo is attached, which "Just me" cannot carry. */
  photoAttached: boolean;
  profileId: string | null;
  membersFor: (groupId: string) => readonly MemberRow[];
  t: UiStrings;
  onPick: (choice: CaptureDestination) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const personalOffered = usePersonalOffered();

  const currentTrips = groups.filter(isCurrentTrip);
  const currentTripIds = new Set(currentTrips.map((group) => group.id));
  const rest = groups.filter((group) => !currentTripIds.has(group.id));

  // Newest-created first, standing in for "recently used": the group model
  // carries no updated_at / last-activity field, so creation order is the only
  // honest recency signal available without a heavier query.
  const byRecent = [...rest].sort(byNewest((row) => row.created_at));

  // Only split "recently used" out from "all" once there are enough groups that
  // a shortcut to the top few actually saves scrolling.
  const RECENT_MAX = 3;
  const splitRecent = groups.length > 5;
  const recent = splitRecent ? byRecent.slice(0, RECENT_MAX) : [];
  const recentIds = new Set(recent.map((group) => group.id));
  const all = splitRecent ? byRecent.filter((group) => !recentIds.has(group.id)) : byRecent;

  const sections = [
    { key: 'trip', title: t.captures.groupSectionCurrentTrip, groups: currentTrips },
    { key: 'recent', title: t.captures.groupSectionRecent, groups: recent },
    { key: 'all', title: t.captures.groupSectionAll, groups: all },
  ].filter((section) => section.groups.length > 0);
  const showHeaders = sections.length > 1;

  const renderGroup = (group: GroupRow): React.JSX.Element => (
    <ChoiceRow
      key={group.id}
      leading={<GroupMark emoji={group.cover_emoji} size={22} />}
      label={groupLabel(group, membersFor(group.id), profileId)}
      selected={selectedId === group.id}
      onPress={() => onPick({ kind: 'group', id: group.id })}
    />
  );

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <ChoiceRow
        leading={<Text variant="subheading">🕓</Text>}
        label={t.captures.decideLater}
        selected={selectedId === null && !justMe}
        onPress={() => onPick({ kind: 'later' })}
      />
      {/* Above the groups, beside "Decide later", because it answers the same
          question they do: not "which group" but "who is this with". It is the
          one answer that ends the errand here — a spend split with nobody is
          complete the moment it is saved. Offered only where the private ledger
          is: a guest account may not hold one. */}
      {personalOffered ? (
        <ChoiceRow
          leading={<Text variant="subheading">🧍</Text>}
          label={t.voice.justMe}
          selected={justMe}
          onPress={() => onPick({ kind: 'me' })}
        />
      ) : null}
      {/* Said before the choice, not after it. The personal ledger keeps
          amounts, not images, so a bill attached here has nowhere to go — and
          somebody who finds that out after saving has already lost it. */}
      {photoAttached ? (
        <Text variant="micro" tone="muted" style={{ paddingHorizontal: theme.spacing.sm }}>
          {t.captures.justMeDropsPhoto}
        </Text>
      ) : null}
      {sections.map((section) => (
        <View key={section.key} style={{ gap: theme.spacing.xs }}>
          {showHeaders ? (
            <Text
              variant="micro"
              tone="muted"
              style={{ marginTop: theme.spacing.sm, letterSpacing: 0.6 }}
            >
              {section.title.toUpperCase()}
            </Text>
          ) : null}
          {section.groups.map(renderGroup)}
        </View>
      ))}
    </View>
  );
}
