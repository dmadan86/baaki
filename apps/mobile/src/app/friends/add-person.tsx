/**
 * Add a person who is not in your contacts, and the amount between you.
 *
 * The rest of the app records a debt inside a group, because a debt is between
 * people *about something*. This is the shortcut for the plainest case of all:
 * "Ravi owes me ₹500" with no trip, no bill, no app on Ravi's phone. Under the
 * hood it is still a group — a one-to-one group named after the person, with a
 * single expense that produces the balance — so it shows up on the dashboard
 * and folds into the Friends totals like any other. Nothing here is a new kind
 * of record; it is the ordinary primitives (create a group, add a ghost, write
 * one expense) wired to one screen so the common case takes one save.
 *
 * The direction defaults to "they owe me" — the case people open this screen
 * for — but it stays a visible, selected choice, not a hidden one: both options
 * are on screen and picking "I owe them" is a single tap before saving.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';

import { parseReceiptText, type HeuristicReceipt, type PaymentMethod } from '@waves/core';

import {
  AmountField,
  Avatar,
  Button,
  Callout,
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { friendlyError } from '@/lib/errors';
import { DictateButton } from '@/components/DictateButton';
import { useAddGhostMember, useCreateGroup, useWriteExpense } from '@/data/hooks';
import { GroupType } from '@/data/types';
import { deviceSupportsUpi, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useDefaultCurrency } from '@/lib/currency';
import { useBackup } from '@/lib/cloud/BackupProvider';
import { captureReceipt, type PickedImage } from '@/lib/image';
import { useGuestGuard } from '@/lib/guestGuard';
import { recogniseReceipt } from '@/lib/ocr';
import { markPending } from '@/lib/receiptIndex';
import { saveReceipt } from '@/lib/receiptStore';

type Direction = 'theyOwe' | 'iOwe';

/**
 * How the money moved. A single-select row that mirrors the rest of the app:
 * the same four ids and icons everywhere, so "credit" is one glyph the user
 * learns once. It is optional — tapping the chosen chip again clears it.
 */
const PAYMENT_METHODS: readonly {
  readonly id: PaymentMethod;
  readonly icon: keyof typeof Ionicons.glyphMap;
  /** Offered only where the rail exists (deviceSupportsUpi); filtered below. */
  readonly regional?: boolean;
}[] = [
  { id: 'cash', icon: 'cash-outline' },
  { id: 'upi', icon: 'phone-portrait-outline', regional: true },
  { id: 'credit', icon: 'card-outline' },
  { id: 'debit', icon: 'card' },
  { id: 'forex', icon: 'swap-horizontal-outline' },
];

/** The i18n label for one method — kept beside the ids so a new method is a
 * type error until it is translated in every locale. */
function paymentMethodLabel(t: ReturnType<typeof useStrings>['t'], id: PaymentMethod): string {
  switch (id) {
    case 'cash':
      return t.addPerson.payCash;
    case 'upi':
      return t.captures.payUpi;
    case 'credit':
      return t.addPerson.payCredit;
    case 'debit':
      return t.addPerson.payDebit;
    case 'forex':
      return t.addPerson.payForex;
  }
}

/** Today as `YYYY-MM-DD`, the format an expense date is stored in. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export default function AddPersonScreen() {
  const theme = useTheme();
  // Under the persistent bottom nav (like friends/contacts and friends/merge),
  // so pad for the bar, not just the system inset.
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { profile } = useAuth();
  const guard = useGuestGuard();

  // The 1:1 group and my own membership id, chosen once on the device so the
  // whole IOU — group, ghost, expense — can be built and queued offline (ADR-005)
  // and land under these exact ids when it syncs. Was a chain of direct RPCs
  // (the add-person deviation); now it rides the queue like every other write.
  const [groupId] = useState(() => randomUUID());
  const [myMemberId] = useState(() => randomUUID());
  const createGroup = useCreateGroup();
  const addGhost = useAddGhostMember(groupId);
  const writeExpense = useWriteExpense(groupId);
  const backup = useBackup();

  const currency = useDefaultCurrency();
  // UPI only where the region has the rail; every other method is universal.
  const paymentMethods = PAYMENT_METHODS.filter(
    (method) => !method.regional || deviceSupportsUpi(),
  );
  const [name, setName] = useState('');
  const [amount, setAmount] = useState(0n);
  // Defaults to the common case — they owe you — but stays a visible, selected
  // choice with "I owe them" one tap away, not a hidden assumption.
  const [direction, setDirection] = useState<Direction | null>('theyOwe');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>('cash');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // A receipt for the IOU. The photo is read on the phone (A5); the merchant
  // prefills the note, and the image and its OCR text are kept in the device
  // vault + your own cloud — never uploaded to Baaki (the receipt-scan privacy
  // choice). Keyed by an id chosen up front so the vault path is stable.
  const [receiptId] = useState(() => randomUUID());
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [parsed, setParsed] = useState<HeuristicReceipt | null>(null);
  const [scanning, setScanning] = useState(false);

  /**
   * Photograph the bill and keep it. On-device OCR reads the text so it can
   * travel with the expense; the heuristic parser pulls the merchant to prefill
   * the note. The amount stays yours to type — reading a trustworthy total needs
   * the metered server parser, which needs a group this screen has not made yet.
   */
  const addReceipt = async (): Promise<void> => {
    setError(null);
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
      const receipt = recognised ? parseReceiptText(recognised.text, { currency }) : null;
      setParsed(receipt);
      if (receipt?.merchant && note.trim().length === 0) setNote(receipt.merchant);
    } catch {
      setRawText(null);
      setParsed(null);
    } finally {
      setScanning(false);
    }
  };

  // Pull the name straight off a contact instead of typing it. This is a 1:1
  // IOU, so only the first ticked person is used; the address book never leaves
  // the device (ContactPicker reads it locally).
  const onPickContact = (chosen: readonly PickedContact[]): void => {
    const first = chosen[0];
    if (first) setName(first.name);
    setPickerOpen(false);
  };

  const canSave = name.trim().length > 0 && amount > 0n && direction !== null && !saving;

  const save = async (): Promise<void> => {
    // A one-to-one IOU is still a group, so it counts against the guest ceiling
    // exactly like any other new group (ADR-006 addendum).
    if (guard.blockAddGroup()) return;
    if (!profile || direction === null || amount <= 0n || name.trim().length === 0) return;
    setError(null);
    setSaving(true);
    try {
      const personName = name.trim();
      // Create the 1:1 group with my membership under the id chosen above, so the
      // expense two lines down can already name me as payer or debtor.
      await createGroup.mutateAsync({
        name: personName,
        type: GroupType.Other,
        currency,
        groupId,
        creatorMemberId: myMemberId,
      });
      const ghostId = await addGhost.mutateAsync(personName);

      // One expense that books the whole amount against the debtor: the payer
      // put the money in, the debtor's share is the lot, so the debtor owes the
      // payer exactly `amount`. "They owe me" makes me the payer; "I owe them"
      // makes the person the payer and the amount my share.
      const theyOwe = direction === 'theyOwe';
      const payerId = theyOwe ? myMemberId : ghostId;
      const debtorId = theyOwe ? ghostId : myMemberId;
      await writeExpense.mutateAsync({
        description: note.trim() || personName,
        expenseDate: today(),
        currency,
        amount,
        participants: [myMemberId, ghostId],
        payers: { [payerId]: amount },
        splitParams: { kind: 'exact', amounts: { [debtorId]: amount, [payerId]: 0n } },
        paymentMethod,
      });

      // Keep the receipt image on the device and, if a personal cloud is
      // connected, queue it there — it is never uploaded to Baaki. The photo and
      // its OCR text stay in the vault sidecar; only the amount and note reached
      // the expense (A5, receipt-scan privacy).
      if (photo) {
        const saved = saveReceipt(receiptId, {
          base64: photo.base64,
          sidecar: {
            captureId: receiptId,
            currency,
            amountMinor: Number(amount),
            itemCount: parsed?.items.length ?? 0,
            items: (parsed?.items ?? []).map((item) => ({ label: item.label, total: item.total })),
            date: today(),
            category: null,
            rawText,
            createdAt: new Date().toISOString(),
          },
        });
        if (saved) {
          await markPending(receiptId, saved, new Date().toISOString());
          void backup.kick();
        }
      }

      // All three writes went through the offline queue, which updates the mirror
      // synchronously — the now-local Friends list already shows the new person,
      // and the whole IOU syncs when there is a connection. Nothing to refetch.
      router.back();
    } catch (caught) {
      setError(friendlyError(caught, t.addPerson.couldNotRecord, 'addPerson.save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
              <Ionicons name="person-add-outline" size={iconSize.md} color={theme.color.brand} />
              <Text variant="heading">{t.addPerson.title}</Text>
            </Row>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* The person is the subject of this screen, so the card leads with
            them: an avatar that fills in with the name's own colour and initial
            as it is typed, the name as the field beside it, and picking from
            contacts as a real button rather than a footnote link. */}
        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Avatar name={name.trim() || '?'} size={56} ghost />
            <View style={{ flex: 1, gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {t.addPerson.nameLabel}
              </Text>
              <TextInput
                value={name}
                onChangeText={setName}
                accessibilityLabel={t.addPerson.nameLabel}
                placeholder={t.addPerson.namePlaceholder}
                placeholderTextColor={theme.color.textFaint}
                autoFocus
                style={{
                  fontSize: 20,
                  fontWeight: '700',
                  color: theme.color.text,
                  paddingVertical: theme.spacing.xs,
                }}
              />
            </View>
          </Row>
          <Button
            label={t.tabs.fromContacts}
            variant="secondary"
            size="sm"
            fullWidth
            onPress={() => setPickerOpen(true)}
          />
        </Card>

        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.addPerson.amountLabel}
          </Text>
          <AmountField currency={currency} value={amount} onChange={setAmount} />
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.addPerson.directionQuestion}
          </Text>
          <Row style={{ gap: theme.spacing.md }}>
            {(
              [
                { key: 'theyOwe', label: t.addPerson.theyOweMe },
                { key: 'iOwe', label: t.addPerson.iOweThem },
              ] as const
            ).map((option) => {
              const active = direction === option.key;
              return (
                <Pressable
                  key={option.key}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={option.label}
                  onPress={() => setDirection(option.key)}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: active ? theme.color.brand : theme.color.border,
                    backgroundColor: active ? theme.color.brandSoft : theme.color.surface,
                  }}
                >
                  <Text
                    variant="subheading"
                    style={{ color: active ? theme.color.brand : theme.color.text }}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </Row>
        </View>

        {/* How the money moved — the same four methods, ids and icons the rest of
            the app uses, so it reads as one app. Optional and single-select:
            tapping the chosen chip again clears it. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.addPerson.paidWith}
          </Text>
          <Row style={{ gap: theme.spacing.sm }}>
            {paymentMethods.map((method) => {
              const active = paymentMethod === method.id;
              const label = paymentMethodLabel(t, method.id);
              return (
                <Pressable
                  key={method.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active, disabled: saving }}
                  accessibilityLabel={label}
                  disabled={saving}
                  // Tap the selected one again to clear it — the field is optional.
                  onPress={() =>
                    setPaymentMethod((current) => (current === method.id ? null : method.id))
                  }
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    gap: theme.spacing.xs,
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: active ? theme.color.brand : theme.color.border,
                    backgroundColor: active ? theme.color.brandSoft : theme.color.surface,
                    opacity: saving ? 0.5 : 1,
                  }}
                >
                  <Ionicons
                    name={method.icon}
                    size={iconSize.md}
                    color={active ? theme.color.brand : theme.color.text}
                  />
                  <Text
                    variant="caption"
                    style={{ color: active ? theme.color.brand : theme.color.text }}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </Row>
        </View>

        <Card style={{ gap: theme.spacing.xs }}>
          <Text variant="caption" tone="muted">
            {t.addPerson.noteLabel}
          </Text>
          <Row style={{ gap: theme.spacing.sm, alignItems: 'flex-start' }}>
            <TextInput
              value={note}
              onChangeText={setNote}
              accessibilityLabel={t.addPerson.noteLabel}
              placeholder={t.addPerson.notePlaceholder}
              placeholderTextColor={theme.color.textFaint}
              multiline
              textAlignVertical="top"
              style={{
                flex: 1,
                fontSize: 16,
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
                minHeight: 44,
              }}
            />
            {/* Speak the note instead of typing it — the same mic the expense
                description has. The person's name is handed to the recogniser as
                a hint, since a name is exactly what a general model mishears. */}
            <DictateButton
              value={note}
              onChange={setNote}
              hints={name.trim() ? [name.trim()] : undefined}
            />
          </Row>
        </Card>

        {/* The bill, for when pointing a camera beats typing. The photo is kept
            on the device (and your own cloud), never on Baaki; its text is read
            here and rides the expense, and the merchant prefills the note. */}
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
              style={{ width: '100%', height: 160, borderRadius: theme.radius.md }}
              contentFit="cover"
              transition={150}
            />
          ) : null}
          {photo && parsed && parsed.items.length === 0 ? (
            <Callout tone="info">{t.captures.couldNotRead}</Callout>
          ) : null}
        </Card>

        {error ? <Callout tone="negative">{error}</Callout> : null}

        <Button
          label={t.addPerson.save}
          size="lg"
          fullWidth
          disabled={!canSave}
          onPress={() => void save()}
        />
        {saving ? <ActivityIndicator color={theme.color.brand} /> : null}
      </ScrollView>

      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <Screen edges={['top', 'bottom']} inModal>
          <View
            style={{
              flex: 1,
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.md,
              gap: theme.spacing.lg,
            }}
          >
            <Row style={{ paddingTop: theme.spacing.md }}>
              <IconButton label={t.common.close} onPress={() => setPickerOpen(false)}>
                <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
              </IconButton>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text variant="heading">{t.tabs.fromContacts}</Text>
              </View>
              <View style={{ width: 44 }} />
            </Row>
            {/* Mounted only while open. ContactPicker keeps the ticked set in
                its own state, and a React Native Modal keeps its children mounted
                across a close — so without this gate, reopening the picker shows
                the last pick still ticked and confirming re-saves that stale
                person (onPickContact takes the first of the set). Remounting on
                each open starts it empty. */}
            {pickerOpen ? (
              // Single-pick: a one-to-one IOU has room for exactly one name, so
              // a tap chooses that person and closes the sheet.
              <ContactPicker single onConfirm={onPickContact} confirmVerb={t.misc.continueWith} />
            ) : null}
          </View>
        </Screen>
      </Modal>
    </Screen>
  );
}
