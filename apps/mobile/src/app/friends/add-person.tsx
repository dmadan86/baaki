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
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

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
  useScreenClearance,
  useTheme,
} from '@baaki/ui';

import { addGhostMember, createGroup, fetchMembers, writeExpense } from '@/data/api';
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
  const clearance = useScreenClearance();
  const { t } = useStrings();
  const { profile } = useAuth();
  const guard = useGuestGuard();
  const queryClient = useQueryClient();

  const currency = deviceDefaultCurrency();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState(0n);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const groupId = await createGroup({ name: personName, type: GroupType.Other, currency });
      const ghostId = await addGhostMember(groupId, personName);
      const members = await fetchMembers(groupId);
      const me = members.find((member) => member.profile_id === profile.id);
      if (!me) throw new Error(t.addPerson.couldNotRecord);

      // One expense that books the whole amount against the debtor: the payer
      // put the money in, the debtor's share is the lot, so the debtor owes the
      // payer exactly `amount`. "They owe me" makes me the payer; "I owe them"
      // makes the person the payer and the amount my share.
      const theyOwe = direction === 'theyOwe';
      const payerId = theyOwe ? me.id : ghostId;
      const debtorId = theyOwe ? ghostId : me.id;
      await writeExpense({
        groupId,
        description: note.trim() || personName,
        expenseDate: today(),
        currency,
        amount,
        participants: [me.id, ghostId],
        payers: { [payerId]: amount },
        splitParams: { kind: 'exact', amounts: { [debtorId]: amount, [payerId]: 0n } },
      });

      // These were direct writes, not the offline queue, so the local mirror
      // does not know about them yet — the Friends list reads the server, so
      // nudge it to refetch and the new person shows the moment we land back on
      // it. The 1:1 group itself appears on the dashboard on the next sync pull.
      await queryClient.invalidateQueries({ queryKey: ['people', 'balances'] });
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
    </Screen>
  );
}
