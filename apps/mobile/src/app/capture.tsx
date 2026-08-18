import { useEffect, useRef, useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  guessCategory,
  parseReceiptText,
  type CategoryId,
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
import { useCreateCapture } from '@/data/hooks';
import { deviceDefaultCurrency, plural, useStrings } from '@/i18n';
import { captureReceipt, type PickedImage } from '@/lib/image';
import { recogniseReceipt } from '@/lib/ocr';
import { saveReceipt } from '@/lib/receiptStore';
import { markPending } from '@/lib/receiptIndex';
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
 * Catch an expense before it has a group.
 *
 * Deliberately the short version of add-expense: an amount, a note, a category
 * and a date, and optionally a photo of the bill — no payer, no participants,
 * no split, because none of those exist until the capture is assigned to a
 * group. The photo is read on the phone (A5) so its text can ride along as
 * `rawText` for the group form to reuse later; nothing group-scoped is called
 * here, because a capture has no group to scope to.
 */
export default function CaptureScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const createCapture = useCreateCapture();
  const backup = useBackup();
  // The dashboard camera opens this screen with `?scan=1` to mean "go straight
  // to the camera", rather than showing an empty form to fill in first.
  const { scan } = useLocalSearchParams<{ scan?: string }>();

  // Chosen here so the photo can be uploaded under it before the row exists —
  // the storage path keys off the capture id, exactly as add-expense seeds its
  // own expense id up front.
  const [captureId] = useState(() => randomUUID());
  const currency = deviceDefaultCurrency();

  const [amount, setAmount] = useState<bigint>(0n);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<CategoryId | null>(null);
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

  // The guess follows the description until a chip is tapped, then stops moving
  // under the user's finger — the same rule the add-expense category uses.
  const [guessedFrom, setGuessedFrom] = useState<string | null>(null);
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
  // the capture once on mount rather than waiting for a tap on "Add receipt".
  // The ref guards against the effect running twice (React 18 strict mode, or a
  // re-render mid-scan).
  const autoScanned = useRef(false);
  useEffect(() => {
    if (scan && !autoScanned.current) {
      autoScanned.current = true;
      void addReceipt();
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
      });
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
          gap: theme.spacing.lg,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.captures.newTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ paddingVertical: theme.spacing.lg }}>
          <AmountField currency={currency} value={amount} onChange={setAmount} />
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.captures.description}
          </Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t.captures.descriptionPlaceholder}
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel={t.captures.description}
            style={{
              fontSize: 17,
              fontWeight: '600',
              color: theme.color.text,
              paddingVertical: theme.spacing.sm,
            }}
          />
        </Card>

        <View style={{ gap: theme.spacing.md }}>
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

        <Card style={{ gap: theme.spacing.md }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t.captures.date}: ${showDate(date, locale)}`}
            onPress={() => setEditingDate(true)}
            style={{ gap: 2 }}
          >
            <Text variant="caption" tone="muted">
              {t.captures.date}
            </Text>
            <Text variant="subheading">{showDate(date, locale)}</Text>
          </Pressable>
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
    </Screen>
  );
}
