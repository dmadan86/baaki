import { useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import { guessCategory, type CategoryId } from '@baaki/core';
import {
  AmountField,
  Button,
  Callout,
  Card,
  IconButton,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { CategoryPicker } from '@/components/Category';
import { uploadCapturePhoto } from '@/data/api';
import { useCreateCapture } from '@/data/hooks';
import { deviceDefaultCurrency, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { captureReceipt, type PickedImage } from '@/lib/image';
import { recogniseReceipt } from '@/lib/ocr';

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
  const { session } = useAuth();
  const createCapture = useCreateCapture();

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
    const picked = await captureReceipt();
    if (!picked) return;
    setError(null);
    setPhoto(picked);
    setScanning(true);
    try {
      const recognised = await recogniseReceipt(picked.uri);
      setRawText(recognised?.text ?? null);
    } catch {
      setRawText(null);
    } finally {
      setScanning(false);
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      // The photo lives in the owner-scoped bucket, uploaded before the row is
      // queued so its path can ride in the create payload (like new-group's
      // cover, but keyed on the capture id rather than a group id).
      let photoPath: string | null = null;
      if (photo && session?.user?.id) {
        photoPath = await uploadCapturePhoto({
          ownerUserId: session.user.id,
          captureId,
          base64: photo.base64,
          mimeType: photo.mimeType,
        });
      }
      await createCapture.mutateAsync({
        captureId,
        description: description.trim(),
        category,
        expenseDate: date,
        currency,
        amount,
        photoPath,
        rawText,
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
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.captures.newTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card>
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
              icon={<Ionicons name="camera-outline" size={18} color={theme.color.brand} />}
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
