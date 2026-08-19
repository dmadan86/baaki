import { useEffect, useState, type ReactNode } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  currencySymbol,
  dayNumber,
  guessCategory,
  parseReceiptText,
  CategoryId,
  type HeuristicReceipt,
} from '@waves/core';
import {
  AmountField,
  Button,
  Callout,
  Card,
  Divider,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@waves/ui';

import { CategoryPicker } from '@/components/Category';
import { COMMON_CURRENCIES } from '@/components/CurrencyRate';
import { DictateButton } from '@/components/DictateButton';
import { useCreateCapture, useGroups, useHomeSummary } from '@/data/hooks';
import { groupLabel, GroupType, type GroupRow, type MemberRow } from '@/data/types';
import { useAuth } from '@/lib/auth';
import {
  deviceDefaultCurrency,
  deviceSupportsUpi,
  plural,
  useStrings,
  type UiStrings,
} from '@/i18n';
import { captureReceipt, type PickedImage } from '@/lib/image';
import { recogniseReceipt } from '@/lib/ocr';
import { saveReceipt } from '@/lib/receiptStore';
import { markPending } from '@/lib/receiptIndex';
import { friendlyError } from '@/lib/errors';
import { useBackup } from '@/lib/cloud/BackupProvider';

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
 * How the spend was paid — a tag, not a commitment. The id is what persists (a
 * free-text `payment_method` column, so any of these ids is safe to store); the
 * icon and label are UI. Debit wears the filled card so it reads apart from
 * credit's outline at chip size. `upi` is offered only where the rail exists
 * (see `deviceSupportsUpi`); everywhere else the row is region rails a person
 * would recognise.
 */
const PAYMENT_METHODS: readonly {
  id: 'cash' | 'upi' | 'credit' | 'debit' | 'forex';
  icon: keyof typeof Ionicons.glyphMap;
  /** True for a rail that only some regions have — filtered by device support. */
  regional?: boolean;
}[] = [
  { id: 'cash', icon: 'cash-outline' },
  { id: 'upi', icon: 'phone-portrait-outline', regional: true },
  { id: 'credit', icon: 'card-outline' },
  { id: 'debit', icon: 'card' },
  { id: 'forex', icon: 'swap-horizontal-outline' },
];

type PaymentMethodId = (typeof PAYMENT_METHODS)[number]['id'];

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
  const { t, locale } = useStrings();
  const createCapture = useCreateCapture();
  const backup = useBackup();
  const { scan } = useLocalSearchParams<{ scan?: string }>();

  // Chosen here so the photo can be uploaded under it before the row exists —
  // the storage path keys off the capture id, exactly as add-expense seeds its
  // own expense id up front.
  const [captureId] = useState(() => randomUUID());

  // The currency starts device-derived (INR when the region is unknown, never a
  // US default) but is the person's to change here — the currency pill under the
  // amount opens the picker. A traveller paying in a currency their phone's
  // region does not use should not have to leave and reopen the group form.
  const [currency, setCurrency] = useState<string>(() => deviceDefaultCurrency());
  const [pickingCurrency, setPickingCurrency] = useState(false);

  const [amount, setAmount] = useState<bigint>(0n);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<CategoryId | null>(CategoryId.Food);
  const [categoryChosen, setCategoryChosen] = useState(false);
  const [date, setDate] = useState<string>(() => todayIso());
  const [editingDate, setEditingDate] = useState(false);
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  // What the on-device parser recovered from the bill: total, item count, lines.
  // Null until a receipt is read; low `confidence` means show it as a draft.
  const [parsed, setParsed] = useState<HeuristicReceipt | null>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // How it was paid and which group it is bound for — both tags that ride the
  // capture and survive until it is assigned. Payment defaults to cash (the most
  // common answer, and one fewer tap for it); the group defaults to "decide
  // later" (null), which keeps the capture in the inbox.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodId | null>('cash');
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [pickingGroup, setPickingGroup] = useState(false);

  const { profile } = useAuth();
  const groups = useGroups();
  const summary = useHomeSummary(profile?.id ?? null);
  const groupRows = groups.data ?? [];
  const groupNameHints = groupRows.map((group) => group.name ?? '').filter(Boolean);
  const targetGroup = groupRows.find((group) => group.id === targetGroupId) ?? null;
  const targetGroupName = targetGroup
    ? groupLabel(targetGroup, summary.membersFor(targetGroup.id), profile?.id)
    : t.captures.decideLater;

  // Only the rails this region actually offers. UPI is dropped everywhere the
  // device does not settle over it, so nobody outside its reach sees a tag that
  // means nothing to them.
  const upiSupported = deviceSupportsUpi();
  const paymentMethods = PAYMENT_METHODS.filter((method) => !method.regional || upiSupported);

  const paymentLabel = (id: PaymentMethodId): string => {
    switch (id) {
      case 'cash':
        return t.captures.payCash;
      case 'upi':
        return t.captures.payUpi;
      case 'credit':
        return t.captures.payCredit;
      case 'debit':
        return t.captures.payDebit;
      case 'forex':
        return t.captures.payForex;
    }
  };

  // Category starts on Food & drink — the most common capture, one fewer tap for
  // it. The guess then follows the description until a chip is tapped, at which
  // point it stops moving under the user's finger (the same rule add-expense
  // uses). Seeding guessedFrom to the initial empty description means the guess
  // does not fire on mount, so that default survives until the person types.
  const [guessedFrom, setGuessedFrom] = useState<string | null>('');
  if (!categoryChosen && description !== guessedFrom) {
    setGuessedFrom(description);
    setCategory(guessCategory(description));
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
  const addReceipt = async (): Promise<void> => {
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
    if (!picked) return;

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
      void Promise.resolve().then(() => addReceipt());
    }
    // addReceipt is stable enough for a one-shot; deps intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan]);

  const submit = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      // The receipt photo is deliberately NOT uploaded to Baaki. It is written
      // to the on-device vault and, if the person connected a personal cloud,
      // queued for backup there — the privacy choice behind this feature. Only
      // the parsed fields (amount, text, itemisation) ride the capture sync, so
      // `photoPath` on the synced row is always null.
      if (photo) {
        const saved = saveReceipt(captureId, {
          base64: photo.base64,
          sidecar: {
            captureId,
            currency,
            amountMinor: Number(amount),
            itemCount: parsed?.items.length ?? 0,
            items: (parsed?.items ?? []).map((item) => ({ label: item.label, total: item.total })),
            date,
            category,
            rawText,
            createdAt: new Date().toISOString(),
          },
        });
        if (saved) {
          await markPending(captureId, saved, new Date().toISOString());
          // Try to back it up now; the queue itself no-ops when offline, when a
          // Wi‑Fi-only policy is set on mobile data, or when no provider is set.
          void backup.kick();
        }
      }

      await createCapture.mutateAsync({
        captureId,
        description: description.trim(),
        category,
        expenseDate: date,
        currency,
        amount,
        photoPath: null,
        rawText,
        parsed: parsed ? (parsed as unknown as Record<string, unknown>) : null,
        paymentMethod,
        targetGroupId,
      });
      router.back();
    } catch (caught) {
      setError(friendlyError(caught, t.captures.couldNotSave, 'capture.save'));
    } finally {
      setSaving(false);
    }
  };

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
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          <Row style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.xs }}>
            <Ionicons name="receipt-outline" size={iconSize.md} color={theme.color.brand} />
            <Text variant="heading">{t.captures.newTitle}</Text>
          </Row>
          <View style={{ width: 44 }} />
        </Row>

        {/* Amount-forward hero: the number is the point of this screen, so it
            leads — big and centred, with the currency it is counted in a tap
            below it (the Splitwise/PayPal amount-first pattern). No card around
            it; the whitespace is the frame. */}
        <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
          <AmountField currency={currency} value={amount} onChange={setAmount} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t.captures.currencyLabel}: ${currency}`}
            onPress={() => setPickingCurrency(true)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
              paddingVertical: theme.spacing.xs,
              paddingHorizontal: theme.spacing.md,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.color.surfaceMuted,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text variant="caption" tone="muted">
              {currencySymbol(currency)}
            </Text>
            <Text variant="caption" style={{ fontWeight: '700', color: theme.color.text }}>
              {currency}
            </Text>
            <Ionicons name="chevron-down" size={iconSize.sm} color={theme.color.textMuted} />
          </Pressable>
        </View>

        {/* Description, as a single underlined field rather than a boxed card —
            it sits right under the amount so the two things a person always fills
            in are together, with the mic to speak it instead of type (A5). */}
        <View style={{ gap: theme.spacing.xs }}>
          <Row
            style={{
              alignItems: 'center',
              gap: theme.spacing.sm,
              borderBottomWidth: 1,
              borderBottomColor: theme.color.border,
              paddingBottom: theme.spacing.xs,
            }}
          >
            <Ionicons name="receipt-outline" size={iconSize.md} color={theme.color.textMuted} />
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={t.captures.descriptionPlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.captures.description}
              style={{
                flex: 1,
                fontSize: 17,
                fontWeight: '600',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
            {/* Group names are handed to the recogniser as hints — a general
                model mangles Indian names, and a note like "dinner with Ravi" is
                exactly where they turn up. */}
            <DictateButton value={description} onChange={setDescription} hints={groupNameHints} />
          </Row>
        </View>

        {/* What it was for. The guess follows the description until a chip is
            tapped; the chips are the picker, unchanged. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.captures.category}
          </Text>
          <CategoryPicker
            value={category}
            onChange={(picked) => {
              setCategory(picked);
              setCategoryChosen(true);
            }}
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
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.xl }}
          >
            {paymentMethods.map((method) => {
              const active = paymentMethod === method.id;
              return (
                <Pressable
                  key={method.id}
                  accessibilityRole="button"
                  accessibilityLabel={paymentLabel(method.id)}
                  accessibilityState={{ selected: active }}
                  onPress={() =>
                    setPaymentMethod((current) => (current === method.id ? null : method.id))
                  }
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.xs,
                    paddingVertical: theme.spacing.sm,
                    paddingHorizontal: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: active ? theme.color.brand : theme.color.border,
                    backgroundColor: active ? theme.color.brandSoft : theme.color.surface,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ionicons
                    name={method.icon}
                    size={iconSize.md}
                    color={active ? theme.color.brand : theme.color.textMuted}
                  />
                  <Text
                    variant="body"
                    style={{ color: active ? theme.color.brand : theme.color.text }}
                  >
                    {paymentLabel(method.id)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

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
            <Image
              source={{ uri: photo.uri }}
              style={{ width: '100%', height: 180, borderRadius: theme.radius.md }}
              contentFit="cover"
              transition={150}
            />
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
                    style={{ width: 28, textAlign: 'center' }}
                  >
                    {currencySymbol(code)}
                  </Text>
                }
                label={code}
                selected={currency === code}
                onPress={() => {
                  setCurrency(code);
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
    </Screen>
  );
}

/**
 * A labelled tap-row: a leading icon, the field name over its value, a chevron.
 * The rows a capture's meta (group, date) share, so they read as one block
 * inside a single card rather than a stack of near-identical cards.
 */
function FieldRow({
  icon,
  iconColor,
  label,
  value,
  valueMuted = false,
  onPress,
  accessibilityLabel,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  label: string;
  value: string;
  valueMuted?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.md} color={iconColor ?? theme.color.textMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text variant="subheading" numberOfLines={1} tone={valueMuted ? 'muted' : undefined}>
          {value}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={iconSize.md} color={theme.color.textFaint} />
    </Pressable>
  );
}

/**
 * A bottom sheet over the form: a dimmed backdrop that closes on tap, a rounded
 * card that swallows its own taps, a grab handle and a title. The two pickers on
 * this screen (currency, group) share it so they present and dismiss the same
 * way.
 */
function SheetOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t.common.close}
      onPress={onClose}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(10, 10, 26, 0.55)',
        justifyContent: 'flex-end',
      }}
    >
      <Pressable
        onPress={() => {}}
        style={{
          backgroundColor: theme.color.surface,
          borderTopLeftRadius: theme.radius.lg,
          borderTopRightRadius: theme.radius.lg,
          padding: theme.spacing.xl,
          gap: theme.spacing.md,
          maxHeight: '75%',
        }}
      >
        <View
          style={{
            alignSelf: 'center',
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.color.border,
          }}
        />
        <Text variant="heading">{title}</Text>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </Pressable>
    </Pressable>
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

/** One row in a picker sheet — a leading glyph, a label, a check when chosen. */
function ChoiceRow({
  leading,
  label,
  selected,
  onPress,
}: {
  leading: ReactNode;
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {leading}
      <Text
        variant="body"
        numberOfLines={1}
        style={{ flex: 1, color: selected ? theme.color.brand : theme.color.text }}
      >
        {label}
      </Text>
      {selected ? <Ionicons name="checkmark" size={iconSize.md} color={theme.color.brand} /> : null}
    </Pressable>
  );
}
