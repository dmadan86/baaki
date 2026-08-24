import { useEffect, useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
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
  useTheme,
} from '@waves/ui';

import { CategoryPicker } from '@/components/Category';
import { TagEditorSheet } from '@/components/TagEditorSheet';
import { PaymentMethodPicker } from '@/components/PaymentMethodPicker';
import { LocationField } from '@/components/LocationField';
import { ZoomableImage } from '@/components/ZoomableImage';
import { COMMON_CURRENCIES } from '@/components/CurrencyRate';
import { AmountHeader } from '@/components/expense/AmountHeader';
import { DescriptionField } from '@/components/expense/DescriptionField';
import { ExpenseHeader } from '@/components/expense/ExpenseHeader';
import { ChoiceRow, FieldRow, SheetOverlay } from '@/components/expense/SheetOverlay';
import { useCreateCapture, useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel, GroupType, type GroupRow, type MemberRow } from '@/data/types';
import { useAuth } from '@/lib/auth';
import { useDefaultCurrency } from '@/lib/currency';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { captureReceipt, type PickedImage } from '@/lib/image';
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
 * Parsed as local noon rather than midnight: a date-only string turned into
 * midnight UTC lands on the previous day west of Greenwich (the same trap
 * TripDates avoids).
 */
function dateFrom(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1, 12);
}

function isoDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function showDate(iso: string, locale: string): string {
  return dateFrom(iso).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
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
 * a date, how it was paid, and optionally a photo of the bill — but no payer,
 * no participants, no split, because none of those exist until the capture is
 * assigned to a group. A group can be *tagged* here as the intended destination
 * (`targetGroupId`), but that only pre-aims it; who splits it, and how, is still
 * decided at assignment. The photo is read on the phone (A5) so its text can
 * ride along as `rawText` for the group form to reuse later.
 */
export default function CaptureScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t, locale } = useStrings();
  const createCapture = useCreateCapture();
  // `scan` fires the camera on entry; the rest are an optional prefill when this
  // screen is reached from a group's "just for me" affordance — the amount, note
  // and currency already typed there carry over so nothing is entered twice. A
  // group is never carried: the point of the private route is that this spend
  // stays personal, off any shared ledger, so `targetGroupId` remains null.
  const {
    scan,
    amount: amountParam,
    desc: descParam,
    cur: curParam,
  } = useLocalSearchParams<{ scan?: string; amount?: string; desc?: string; cur?: string }>();

  // Chosen here so the photo can be uploaded under it before the row exists —
  // the storage path keys off the capture id, exactly as add-expense seeds its
  // own expense id up front.
  const [captureId] = useState(() => randomUUID());

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
  // custom tag so it rides onto the capture (extends TDR §8).
  const [category, setCategory] = useState<string | null>(CategoryId.Food);
  const [categoryMeta, setCategoryMeta] = useState<CategoryMeta | null>(null);
  const [categoryChosen, setCategoryChosen] = useState(false);
  // The create-tag sheet, opened from the "＋ New tag" chip in the picker.
  const [editingTag, setEditingTag] = useState(false);
  const [date, setDate] = useState<string>(() => todayIso());
  const [editingDate, setEditingDate] = useState(false);
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  // Full-screen preview of the attached bill, opened by tapping the thumbnail.
  const [previewing, setPreviewing] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
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
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>('cash');
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [pickingGroup, setPickingGroup] = useState(false);
  // Where it happened (A43). Optional and opt-in; null until the person taps
  // "Add location" and grants the permission.
  const [location, setLocation] = useState<ExpenseLocation | null>(null);

  const { profile } = useAuth();
  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);
  const groupRows = groups.data ?? [];
  const groupNameHints = groupRows.map((group) => group.name ?? '').filter(Boolean);
  const targetGroup = groupRows.find((group) => group.id === targetGroupId) ?? null;
  const targetGroupName = targetGroup
    ? groupLabel(targetGroup, summary.membersFor(targetGroup.id), profile?.id)
    : t.captures.decideLater;

  // Category starts on Food & drink — the most common capture, one fewer tap for
  // it. The guess then follows the description until a chip is tapped, at which
  // point it stops moving under the user's finger (the same rule add-expense
  // uses). Seeding guessedFrom to the initial empty description means the guess
  // does not fire on mount, so that default survives until the person types.
  // Seeded to the carried-in note (or empty) so the category guesser does not
  // fire on mount and overwrite the Food default before the person types.
  const [guessedFrom, setGuessedFrom] = useState<string | null>(() => descParam ?? '');
  if (!categoryChosen && description !== guessedFrom) {
    setGuessedFrom(description);
    // Keep the current category when the description matches no bucket:
    // guessCategory returns null for unrecognised text, and clearing on null
    // would wipe the Food default (or a prior guess) leaving no chip selected.
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
      // The bill photo goes to the person's own R2 storage under the capture id
      // (A44) — the `captures` bucket is keyed by the owner, so no group has to
      // exist yet. Best-effort: a failed upload (offline, out of storage) must
      // never cost the capture itself, so on any trouble the photo path stays
      // null and only the parsed fields (amount, text, itemisation) ride the
      // sync. The returned path is written onto the capture row so it can be
      // viewed later from any of the owner's devices.
      let photoPath: string | null = null;
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
          photoPath = null;
          photoError = caught;
        }
      }

      await createCapture.mutateAsync({
        captureId,
        description: description.trim(),
        category,
        categoryMeta,
        expenseDate: date,
        currency,
        amount,
        photoPath,
        rawText,
        parsed: parsed ? (parsed as unknown as Record<string, unknown>) : null,
        paymentMethod,
        targetGroupId,
        location,
      });

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
      <Screen edges={['top', 'bottom']}>
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
    <Screen edges={['top', 'bottom']}>
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
        <ExpenseHeader title={t.captures.newTitle} />

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

        {/* Description, as a single underlined field rather than a boxed card —
            it sits right under the amount so the two things a person always fills
            in are together, with the mic to speak it instead of type (A5). Group
            names are handed to the recogniser as hints — a general model mangles
            Indian names, and a note like "dinner with Ravi" is exactly where they
            turn up. */}
        <DescriptionField
          value={description}
          onChange={setDescription}
          placeholder={t.captures.descriptionPlaceholder}
          accessibilityLabel={t.captures.description}
          hints={groupNameHints}
        />

        {/* What it was for. The guess follows the description until a chip is
            tapped; the chips are the picker, unchanged. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.captures.category}
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

        {/* How it was paid. Single-select tags, icon + word; cash is chosen by
            default, tapping the chosen one again clears it ("not said" stays a
            valid answer). UPI only appears where the region settles over it. One
            row that scrolls sideways rather than wrapping to a second line, so the
            block keeps a fixed height however many rails the region offers. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.captures.paidWith}
          </Text>
          {/* Shared with add-expense; capture lets "not said" stand, so a tap on
              the chosen chip clears it (allowDeselect). */}
          <PaymentMethodPicker value={paymentMethod} onChange={setPaymentMethod} allowDeselect />
        </View>

        {/* Where it happened (A43) — optional, opt-in, never a background track. */}
        <LocationField value={location} onChange={setLocation} />

        {/* Destination and date, folded into one card of divided rows rather than
            two stacked cards — the meta a capture carries, grouped so it reads as
            one block. "Decide later" is the default group: the split, and who is
            in it, is chosen when the capture is assigned. */}
        <Card style={{ paddingVertical: theme.spacing.xs, gap: 0 }}>
          <FieldRow
            icon={targetGroup ? 'people' : 'people-outline'}
            iconColor={targetGroup ? theme.color.brand : theme.color.textMuted}
            label={t.captures.group}
            value={targetGroupName}
            valueMuted={!targetGroup}
            onPress={() => setPickingGroup(true)}
            accessibilityLabel={`${t.captures.group}: ${targetGroupName}`}
          />
          <Divider />
          <FieldRow
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
        </Card>

        {/* The bill, for the times pointing a camera is easier than typing. The
            photo is kept and its text read on the phone; the amount stays the
            user's to enter, because reading it needs a group this row does not
            have yet. */}
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
      </ScrollView>

      <View
        style={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.md,
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
          and the rest — so the group you mean is usually one of the first taps. */}
      {pickingGroup ? (
        <SheetOverlay title={t.captures.groupPickerTitle} onClose={() => setPickingGroup(false)}>
          <Text variant="caption" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
            {t.captures.groupPickerBody}
          </Text>
          <GroupPicker
            groups={groupRows}
            selectedId={targetGroupId}
            profileId={profile?.id ?? null}
            membersFor={summary.membersFor}
            t={t}
            onPick={(id) => {
              setTargetGroupId(id);
              setPickingGroup(false);
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

      {/* Make a tag on the spot, from the picker's "＋ New tag" chip. */}
      <TagEditorSheet open={editingTag} onClose={() => setEditingTag(false)} />
    </Screen>
  );
}

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
  profileId,
  membersFor,
  t,
  onPick,
}: {
  groups: readonly GroupRow[];
  selectedId: string | null;
  profileId: string | null;
  membersFor: (groupId: string) => readonly MemberRow[];
  t: UiStrings;
  onPick: (id: string | null) => void;
}): React.JSX.Element {
  const theme = useTheme();

  const currentTrips = groups.filter(isCurrentTrip);
  const currentTripIds = new Set(currentTrips.map((group) => group.id));
  const rest = groups.filter((group) => !currentTripIds.has(group.id));

  // Newest-created first, standing in for "recently used": the group model
  // carries no updated_at / last-activity field, so creation order is the only
  // honest recency signal available without a heavier query.
  const byRecent = [...rest].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

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
      leading={<Text variant="subheading">{group.cover_emoji ?? '👥'}</Text>}
      label={groupLabel(group, membersFor(group.id), profileId)}
      selected={selectedId === group.id}
      onPress={() => onPick(group.id)}
    />
  );

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <ChoiceRow
        leading={<Text variant="subheading">🕓</Text>}
        label={t.captures.decideLater}
        selected={selectedId === null}
        onPress={() => onPick(null)}
      />
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
