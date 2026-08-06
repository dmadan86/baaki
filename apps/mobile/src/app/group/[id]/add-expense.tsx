import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { computeShares, type FxRecord, type MemberId, type SplitParams } from '@baaki/core';
import {
  AmountKeypad,
  Avatar,
  Button,
  Card,
  ChipRow,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { CurrencyRate } from '@/components/CurrencyRate';
import { DictateButton } from '@/components/DictateButton';
import { useGroup } from '@/data/hooks';
import { displayName, groupLabel, isGhost } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import {
  entryValues,
  fillEntries,
  formatEntry,
  parseEntry,
  splitProblem,
  type SplitEntries,
  type SplitKind,
} from '@/lib/split';
import { clearDraft, useDraft, useRestoredDraft, useSync } from '@/sync';

interface ExpenseDraft {
  amount: string;
  description: string;
  splitKind: SplitKind;
  payer: MemberId | null;
  participants: MemberId[];
  /** Kept apart, because a weight of 1 is not one percent. */
  weights: SplitEntries;
  percents: SplitEntries;
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

export default function AddExpenseScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id, expenseId } = useLocalSearchParams<{ id: string; expenseId?: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members, expenses } = useGroup(groupId);
  const { mutate } = useSync();

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
  const [splitKind, setSplitKind] = useState<SplitKind>('equal');
  const [payer, setPayer] = useState<MemberId | null>(null);
  const [participants, setParticipants] = useState<MemberId[]>([]);
  // What was typed into each member's field, as text. Two maps, not one: the
  // same person is "2 shares" and "40%", and switching between the two must not
  // reinterpret one number as the other.
  const [weights, setWeights] = useState<SplitEntries>({});
  const [percents, setPercents] = useState<SplitEntries>({});
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
  );

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
    if (draft) {
      // A draft outranks the saved version: it is what the user was in the
      // middle of writing when the app went away.
      setAmount(BigInt(draft.amount));
      setDescription(draft.description);
      setSplitKind(draft.splitKind);
      setPayer(draft.payer ?? myMemberId);
      setParticipants(draft.participants);
      setWeights(draft.weights ?? {});
      setPercents(draft.percents ?? {});
    } else if (version) {
      setAmount(BigInt(version.amount));
      setDescription(version.description);
      setPayer(version.payers[0]?.member_id ?? myMemberId);
      setParticipants(version.shares.map((share) => share.member_id));
      setSplitKind(
        version.split_type === 'percent'
          ? 'percent'
          : version.split_type === 'shares'
            ? 'shares'
            : 'equal',
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

  // Everybody in a weighted split needs a number to start from, and the set
  // changes as people are ticked on and off. `fillEntries` returns null once
  // there is nothing left to fill, which is what stops this looping.
  if (splitKind === 'shares') {
    const filled = fillEntries('shares', weights, participants);
    if (filled) setWeights(filled);
  } else if (splitKind === 'percent') {
    const filled = fillEntries('percent', percents, participants);
    if (filled) setPercents(filled);
  }

  const entries = splitKind === 'shares' ? weights : percents;
  const setEntry = (memberId: MemberId, text: string): void => {
    const update = (current: SplitEntries): SplitEntries => ({ ...current, [memberId]: text });
    if (splitKind === 'shares') setWeights(update);
    else setPercents(update);
  };
  const splitIssue = splitProblem(splitKind, entries, participants);

  const groupCurrency = group.data?.default_currency ?? 'INR';
  // The expense keeps the currency it was paid in; the group's is only the
  // default and what a converted total would be shown in (ADR-003).
  const currency = expenseCurrency ?? groupCurrency;

  // Every keystroke, debounced just enough to avoid one write per character.
  useDraft<ExpenseDraft>(
    draftKey,
    { amount: amount.toString(), description, splitKind, payer, participants, weights, percents },
    { enabled: seededFor !== null },
  );

  const splitParams: SplitParams = useMemo(() => {
    if (splitKind === 'shares') {
      return { kind: 'shares', weights: entryValues('shares', weights, participants) };
    }
    if (splitKind === 'percent') {
      return { kind: 'percent', basisPoints: entryValues('percent', percents, participants) };
    }
    return { kind: 'equal' };
  }, [splitKind, weights, percents, participants]);

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
    return (
      <Screen>
        <View style={{ padding: theme.spacing.xl }}>
          <ActivityIndicator color={theme.color.brand} />
        </View>
      </Screen>
    );
  }

  if (!group.data) {
    return (
      <Screen>
        <EmptyState title="Group not found" body="It may have been archived." />
      </Screen>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    if (!payer) {
      setError('Choose who paid');
      return;
    }
    setSaving(true);
    try {
      // Straight into the durable queue: this returns as soon as the mutation
      // is on disk, so the expense is saved whether or not there is a network.
      await mutate(expenseId ? 'expense.update' : 'expense.create', groupId, {
        expenseId: targetExpenseId,
        description: description.trim() || 'Expense',
        expenseDate: new Date().toISOString().slice(0, 10),
        currency,
        amount: amount.toString(),
        fx,
        splitParams,
        participants,
        payers: { [payer]: amount.toString() },
        expectedShares: preview
          ? Object.fromEntries([...preview].map(([id, share]) => [id, share.toString()]))
          : undefined,
        // Lets the server tell a concurrent edit from a normal one (TDR §4.4).
        baseVersionNo: editing?.currentVersion?.version_no ?? null,
      });
      await clearDraft(draftKey);
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
    if (splitKind !== 'percent') return 0n;
    const basisPoints = parseEntry('percent', percents[memberId] ?? '') ?? 0;
    return (amount * BigInt(basisPoints)) / 10000n;
  };

  const toggleParticipant = (memberId: MemberId): void => {
    setParticipants((current) =>
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId],
    );
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Close" onPress={() => router.back()}>
            <Ionicons name="close" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{editing ? 'Edit expense' : t.addExpense}</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [], profile?.id)}
            </Text>
          </View>
          {editing ? (
            <View style={{ width: 44 }} />
          ) : (
            <IconButton
              label="Split by item"
              onPress={() => router.replace(`/group/${groupId}/itemize`)}
            >
              <Ionicons name="list-outline" size={20} color={theme.color.brand} />
            </IconButton>
          )}
        </Row>

        {editing ? (
          <Card style={{ backgroundColor: theme.color.brandSoft }}>
            <Text variant="caption" tone="brand">
              Editing keeps the old version. Everyone can see what changed, and it can be restored.
            </Text>
          </Card>
        ) : null}

        <Card>
          <AmountKeypad currency={currency} value={amount} onChange={setAmount} />
        </Card>

        <CurrencyRate
          groupCurrency={groupCurrency}
          currency={currency}
          onCurrencyChange={setExpenseCurrency}
          amount={amount}
          fx={fx}
          onFxChange={setFx}
        />

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.description}
          </Text>
          <Row style={{ gap: theme.spacing.md, alignItems: 'flex-start' }}>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Beach shack dinner"
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.description}
              style={{
                flex: 1,
                fontSize: 17,
                fontWeight: '600',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
            {/* The member names are handed to the recogniser as hints. A
                general model guesses at Indian names and gets them wrong, and
                the note is exactly where they turn up. */}
            <DictateButton value={description} onChange={setDescription} hints={nameHints} />
          </Row>
        </Card>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            How to split
          </Text>
          <ChipRow<SplitKind>
            value={splitKind}
            onChange={setSplitKind}
            options={[
              { value: 'equal', label: 'Equally' },
              { value: 'shares', label: 'Shares' },
              { value: 'percent', label: 'Percent' },
            ]}
          />
        </View>

        <Card style={{ gap: theme.spacing.md }}>
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
                style={{ alignItems: 'center', gap: 4, opacity: payer === member.id ? 1 : 0.45 }}
              >
                <Avatar name={displayName(member)} ghost={isGhost(member)} />
                <Text variant="micro" tone={payer === member.id ? 'brand' : 'muted'}>
                  {displayName(member, profile?.id)}
                </Text>
              </Pressable>
            ))}
          </Row>
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="caption" tone="muted">
              Split between
            </Text>
            <Text variant="micro" tone="muted">
              {`${participants.length} of ${members.data?.length ?? 0}`}
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
                      />
                    ) : null}
                  </View>
                </Pressable>

                {splitKind !== 'equal' && selected ? (
                  <Row style={{ gap: 2, alignItems: 'center', flexGrow: 0, flexShrink: 0 }}>
                    <TextInput
                      value={entries[member.id] ?? ''}
                      onChangeText={(text) => setEntry(member.id, text)}
                      keyboardType={splitKind === 'percent' ? 'decimal-pad' : 'number-pad'}
                      selectTextOnFocus
                      placeholder={splitKind === 'percent' ? '0' : '1'}
                      placeholderTextColor={theme.color.textFaint}
                      accessibilityLabel={
                        splitKind === 'percent' ? `${name}'s percentage` : `${name}'s shares`
                      }
                      style={{
                        width: 72,
                        fontSize: 16,
                        fontWeight: '700',
                        textAlign: 'right',
                        color: theme.color.text,
                        backgroundColor: theme.color.bg,
                        borderRadius: theme.radius.sm,
                        paddingVertical: theme.spacing.sm,
                        paddingHorizontal: theme.spacing.sm,
                      }}
                    />
                    <Text variant="micro" tone="muted">
                      {splitKind === 'percent' ? '%' : '×'}
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
                    size={22}
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
        </Card>

        {error ? (
          <Text variant="caption" tone="negative">
            {error}
          </Text>
        ) : null}

        <Button
          label={editing ? 'Save changes' : t.save}
          size="lg"
          fullWidth
          disabled={amount === 0n || participants.length === 0 || splitIssue !== null || saving}
          onPress={() => void submit()}
        />

        {saving ? <ActivityIndicator color={theme.color.brand} /> : null}

        <Text variant="micro" tone="faint" align="center">
          Saved on this phone straight away, with or without a signal. The server recomputes every
          share before it is stored, so no device can push a wrong number into the ledger.
        </Text>
      </ScrollView>
    </Screen>
  );
}
