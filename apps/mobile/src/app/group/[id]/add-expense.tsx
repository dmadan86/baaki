import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  computeShares,
  guessCategory,
  type CategoryId,
  type FxRecord,
  type MemberId,
  type SplitParams,
} from '@baaki/core';
import {
  AmountKeypad,
  Avatar,
  Button,
  Callout,
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

import { CategoryPicker } from '@/components/Category';
import { CurrencyRate } from '@/components/CurrencyRate';
import { DictateButton } from '@/components/DictateButton';
import { scanReceipt, scanReceiptText } from '@/data/api';
import { useGroup } from '@/data/hooks';
import { displayName, groupLabel, isGhost } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { handoverKey } from '@/lib/handover';
import { captureReceipt } from '@/lib/image';
import { recogniseReceipt } from '@/lib/ocr';
import {
  entryValues,
  fillEntries,
  formatEntry,
  parseEntry,
  splitProblem,
  type SplitEntries,
  type SplitKind,
} from '@/lib/split';
import { clearDraft, syncEngine, useDraft, useRestoredDraft, useSync } from '@/sync';

interface ExpenseDraft {
  amount: string;
  description: string;
  splitKind: SplitKind;
  payer: MemberId | null;
  participants: MemberId[];
  /** Kept apart, because a weight of 1 is not one percent. */
  weights: SplitEntries;
  percents: SplitEntries;
  category: CategoryId | null;
  /** Whether the category above was chosen, rather than guessed. */
  categoryChosen: boolean;
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
  // Guessed from the description until somebody picks one themselves, at which
  // point the guess must stop moving it — see `categoryChosen`.
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [categoryChosen, setCategoryChosen] = useState(false);
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
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  /** Set once a scan has read line items, so the offer to itemize is real. */
  const [scannedItems, setScannedItems] = useState(0);

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
      setCategory(draft.category ?? null);
      setCategoryChosen(draft.categoryChosen ?? false);
    } else if (version) {
      setAmount(BigInt(version.amount));
      setDescription(version.description);
      // A saved category is a decision somebody already made. Re-guessing it on
      // open would quietly rewrite their answer.
      setCategory((version.category as CategoryId | null) ?? null);
      setCategoryChosen(version.category !== null);
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

  // The guess follows the description while it is being typed, and stops the
  // moment a chip is tapped. Keyed by the text it was made from so it runs once
  // per description rather than once per render.
  const [guessedFrom, setGuessedFrom] = useState<string | null>(null);
  if (seededFor !== null && !categoryChosen && description !== guessedFrom) {
    setGuessedFrom(description);
    setCategory(guessCategory(description));
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
    {
      amount: amount.toString(),
      description,
      splitKind,
      payer,
      participants,
      weights,
      percents,
      category,
      categoryChosen,
    },
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
        <EmptyState title={t.group.notFound} body={t.group.notFoundArchived} />
      </Screen>
    );
  }

  const submit = async (): Promise<void> => {
    setError(null);
    if (!payer) {
      setError(t.expense.chooseWhoPaid);
      return;
    }
    setSaving(true);
    try {
      // Straight into the durable queue: this returns as soon as the mutation
      // is on disk, so the expense is saved whether or not there is a network.
      await mutate(expenseId ? 'expense.update' : 'expense.create', groupId, {
        expenseId: targetExpenseId,
        // Blank stays blank. Writing the English word "Expense" here made every
        // undescribed row identical in the list, and put a word nobody typed
        // into an append-only ledger, the CSV export and the notification text —
        // in one language, for an app that speaks four.
        description: description.trim(),
        category,
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
    const picked = await captureReceipt();
    if (!picked) return;
    setError(null);
    setScanNote(null);
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScanning(false);
    }
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
            <Text variant="heading">{editing ? t.expense.edit : t.addExpense}</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [], profile?.id)}
            </Text>
          </View>
          {editing ? (
            <View style={{ width: 44 }} />
          ) : (
            <IconButton
              label={t.expense.splitByItem}
              onPress={() => router.replace(`/group/${groupId}/itemize`)}
            >
              <Ionicons name="list-outline" size={20} color={theme.color.brand} />
            </IconButton>
          )}
        </Row>

        {editing ? (
          <Card style={{ backgroundColor: theme.color.brandSoft }}>
            <Text variant="caption" tone="brand">
              {t.expense.editingKeepsVersion}
            </Text>
          </Card>
        ) : null}

        <Card>
          <AmountKeypad currency={currency} value={amount} onChange={setAmount} />
        </Card>

        {/* Below the keypad, not above it. Typing a number is the fast path and
            stays the first thing on the screen; the camera is for the bill that
            is easier to point at than to read. */}
        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">{t.expense.scanBillTitle}</Text>
              <Text variant="caption" tone="muted">
                {t.expense.scanBillBody}
              </Text>
            </View>
            <Button
              label={scanning ? t.expense.reading : t.expense.scan}
              variant="secondary"
              disabled={scanning || saving}
              onPress={() => void scan()}
              icon={<Ionicons name="camera-outline" size={18} color={theme.color.brand} />}
            />
          </Row>
          {scanning ? <ActivityIndicator color={theme.color.brand} /> : null}
          {scanNote ? (
            <Text variant="caption" tone="brand">
              {scanNote}
            </Text>
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
              placeholder={t.expense.descriptionPlaceholder}
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

        {/* Pre-picked from the description, because a menu between somebody and
            saving a dinner is how a column ends up empty — and an empty column
            is a spending chart nobody can draw (TDR §8). */}
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.whatFor}
          </Text>
          <CategoryPicker
            value={category}
            onChange={(picked) => {
              setCategory(picked);
              setCategoryChosen(true);
            }}
          />
        </View>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.expense.howToSplit}
          </Text>
          <ChipRow<SplitKind>
            value={splitKind}
            onChange={setSplitKind}
            options={[
              { value: 'equal', label: t.expense.equally },
              { value: 'shares', label: t.expense.shares },
              { value: 'percent', label: t.expense.percent },
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
              disabled={amount === 0n || participants.length === 0 || splitIssue !== null || saving}
              onPress={() => void submit()}
            />
          </Row>
        </Row>
      </View>
    </Screen>
  );
}
