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
 * The direction is asked, never assumed: "they owe me" and "I owe them" are
 * opposite ledger entries, and defaulting one would quietly book the wrong one.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  AmountField,
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
} from '@baaki/ui';

import { ContactPicker, type PickedContact } from '@/components/ContactPicker';
import { useAddGhostMember, useCreateGroup, useWriteExpense } from '@/data/hooks';
import { GroupType } from '@/data/types';
import { deviceDefaultCurrency, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useGuestGuard } from '@/lib/guestGuard';

type Direction = 'theyOwe' | 'iOwe';

/** Today as `YYYY-MM-DD`, the format an expense date is stored in. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
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

  const currency = deviceDefaultCurrency();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState(0n);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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
      });

      // All three writes went through the offline queue, which updates the mirror
      // synchronously — the now-local Friends list already shows the new person,
      // and the whole IOU syncs when there is a connection. Nothing to refetch.
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
            <Text variant="heading">{t.addPerson.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="caption" tone="muted" align="center">
          {t.addPerson.subtitle}
        </Text>

        <Card style={{ gap: theme.spacing.xs }}>
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
              paddingVertical: theme.spacing.sm,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.tabs.fromContacts}
            onPress={() => setPickerOpen(true)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.xs,
              alignSelf: 'flex-start',
              paddingVertical: theme.spacing.xs,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons name="person-add-outline" size={iconSize.sm} color={theme.color.brand} />
            <Text variant="caption" style={{ color: theme.color.brand }}>
              {t.tabs.fromContacts}
            </Text>
          </Pressable>
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

        <Card style={{ gap: theme.spacing.xs }}>
          <Text variant="caption" tone="muted">
            {t.addPerson.noteLabel}
          </Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            accessibilityLabel={t.addPerson.noteLabel}
            placeholder={t.addPerson.notePlaceholder}
            placeholderTextColor={theme.color.textFaint}
            style={{ fontSize: 16, color: theme.color.text, paddingVertical: theme.spacing.sm }}
          />
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
        <Screen edges={['top', 'bottom']}>
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
            <ContactPicker onConfirm={onPickContact} confirmVerb={t.misc.continueWith} />
          </View>
        </Screen>
      </Modal>
    </Screen>
  );
}
