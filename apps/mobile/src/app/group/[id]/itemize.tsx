import { useMemo, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  computeShares,
  currencySymbol,
  format,
  minorUnitScale,
  type ItemizedParams,
  type MemberId,
  type ParsedReceipt,
} from '@baaki/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { captureReceipt } from '@/lib/image';
import { scanReceipt, scanReceiptText } from '@/data/api';
import { recogniseReceipt } from '@/lib/ocr';
import { useGroup, useWriteExpense } from '@/data/hooks';
import { displayName, groupLabel, isGhost } from '@/data/types';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { handoverIsFresh, handoverKey, type ReceiptHandover } from '@/lib/handover';
import { clearDraft, useRestoredDraft } from '@/sync';

interface DraftItem {
  key: string;
  label: string;
  /** Minor units. */
  total: bigint;
  claimers: MemberId[];
}

/**
 * Itemized split (ADR-008 §3.1). Each line is claimed by whoever ate it, a line
 * claimed by several splits equally between them, and tax/service/tip are
 * prorated by each person's item subtotal — never split equally, which is the
 * thing that makes people argue.
 *
 * This is the screen the AI receipt scan fills in for you in M5; today you type
 * the lines, and the maths is already exact.
 */
export default function ItemizeScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const writeExpense = useWriteExpense(groupId);

  const [description, setDescription] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [label, setLabel] = useState('');
  const [amountText, setAmountText] = useState('');
  const [taxText, setTaxText] = useState('');
  const [tipText, setTipText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  /**
   * ADR-008: the model proposes, the person confirms. Everything it read lands
   * in the same editable list somebody would have typed by hand, so correcting
   * a misread line is just editing — there is no separate "AI mode" to leave.
   */
  const fillFromReceipt = (parsed: ParsedReceipt): void => {
    setItems(
      parsed.items.map((item, index) => ({
        key: `scan-${index}-${randomUUID()}`,
        label: item.label,
        total: BigInt(item.total),
        claimers: [],
      })),
    );
    const taxes = parsed.taxes.reduce((sum, tax) => sum + tax.amount, 0);
    if (taxes > 0) setTaxText((taxes / 100).toString());
    if (parsed.tip) setTipText((parsed.tip / 100).toString());
    if (parsed.merchant) {
      setDescription((current) => (current.trim() ? current : (parsed.merchant ?? '')));
    }
  };

  // A bill scanned on the add-expense screen, followed here. Taken once and
  // cleared: nobody should be asked to photograph the same receipt twice, and
  // nobody who came here to type should find last week's dinner waiting.
  const handover = useRestoredDraft<ReceiptHandover>(handoverKey(groupId));
  const [tookHandover, setTookHandover] = useState(false);
  if (!handover.loading && handover.draft && !tookHandover) {
    setTookHandover(true);
    void clearDraft(handoverKey(groupId));
    if (handoverIsFresh(handover.draft)) {
      fillFromReceipt(handover.draft.parsed);
      setScanNote('Carried over from the scan. Check the lines, then tap who had what.');
    }
  }

  const scan = async (): Promise<void> => {
    const picked = await captureReceipt();
    if (!picked) return;
    setError(null);
    setScanNote(null);
    setScanning(true);
    try {
      // Read the text on the phone first. When it works the photograph never
      // leaves the device, and the scan costs about a tenth as much because a
      // receipt image is one to two thousand tokens before a word is read.
      // When it does not — a dark or blurred photo — the image path reads such
      // a receipt far better, so it is worth the upload.
      const recognised = await recogniseReceipt(picked.uri);
      const result = recognised
        ? await scanReceiptText({
            groupId,
            rawText: recognised.text,
            currency,
            source: 'camera',
          })
        : await scanReceipt({
            groupId,
            base64: picked.base64,
            mimeType: picked.mimeType,
            currency,
          });

      fillFromReceipt(result.parsed);

      // The arithmetic decides what the person is asked to look at. Saying
      // "scanned!" and leaving them to notice a wrong total is the failure
      // this whole path exists to avoid.
      setScanNote(
        result.check.reconciles && result.check.problems.length === 0
          ? `Read ${result.parsed.items.length} items. Check them, then tap who had what.`
          : (result.check.problems[0]?.message ??
              'Some lines need checking before this can be saved.'),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScanning(false);
    }
  };

  const currency = group.data?.default_currency ?? 'INR';
  const scale = minorUnitScale(currency);

  const toMinor = (text: string): bigint => {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
    if (!match) return 0n;
    const [, whole = '0', fraction = ''] = match;
    return BigInt(whole) * scale + BigInt(fraction.padEnd(2, '0') || '0');
  };

  const taxes = toMinor(taxText);
  const tip = toMinor(tipText);
  const itemsTotal = items.reduce((total, item) => total + item.total, 0n);
  const grandTotal = itemsTotal + taxes + tip;

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
  );

  const unclaimed = items.filter((item) => item.claimers.length === 0);
  // Memoised: a fresh array each render would re-run the split preview forever.
  const participants = useMemo(() => [...new Set(items.flatMap((item) => item.claimers))], [items]);

  const splitParams: ItemizedParams = useMemo(
    () => ({
      kind: 'itemized',
      items: items.map((item) => ({ label: item.label, total: item.total })),
      claims: Object.fromEntries(items.map((item, index) => [index, item.claimers])),
      taxes,
      tip,
    }),
    [items, taxes, tip],
  );

  const preview = useMemo(() => {
    if (items.length === 0 || unclaimed.length > 0 || participants.length === 0) return null;
    try {
      return computeShares({
        amount: grandTotal,
        currency,
        params: splitParams,
        participants,
        seed: 'itemize-draft',
      });
    } catch {
      return null;
    }
  }, [items, unclaimed.length, participants, grandTotal, currency, splitParams]);

  if (group.isLoading || members.isLoading) {
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

  const addItem = (): void => {
    const total = toMinor(amountText);
    if (total <= 0n) return;
    setItems((current) => [
      ...current,
      {
        key: `${Date.now()}-${current.length}`,
        label: label.trim() || `Item ${current.length + 1}`,
        total,
        // Whoever is adding the bill usually had something on it.
        claimers: myMemberId ? [myMemberId] : [],
      },
    ]);
    setLabel('');
    setAmountText('');
  };

  const toggleClaim = (itemKey: string, memberId: MemberId): void => {
    setItems((current) =>
      current.map((item) =>
        item.key === itemKey
          ? {
              ...item,
              claimers: item.claimers.includes(memberId)
                ? item.claimers.filter((claimer) => claimer !== memberId)
                : [...item.claimers, memberId],
            }
          : item,
      ),
    );
  };

  const save = async (): Promise<void> => {
    setError(null);
    if (!myMemberId) {
      setError('You are not a member of this group');
      return;
    }
    try {
      await writeExpense.mutateAsync({
        description: description.trim() || 'Itemized bill',
        expenseDate: new Date().toISOString().slice(0, 10),
        currency,
        amount: grandTotal,
        splitParams,
        participants,
        payers: { [myMemberId]: grandTotal },
        expectedShares: preview ? Object.fromEntries(preview) : undefined,
      });
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
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
            <Text variant="heading">Split by item</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">Scan the receipt</Text>
              <Text variant="caption" tone="muted">
                Scan the bill and the items come out filled in. Check them before saving — entering
                them by hand is always free.
              </Text>
            </View>
            <Button
              label={scanning ? 'Reading…' : 'Scan'}
              variant="secondary"
              disabled={scanning}
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
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            What was the bill for?
          </Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Dinner at Anjappar"
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel="Bill description"
            style={{
              fontSize: 17,
              fontWeight: '600',
              color: theme.color.text,
              paddingVertical: theme.spacing.sm,
            }}
          />
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            Add a line
          </Text>
          <Row>
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Biryani"
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel="Item name"
              style={{
                flex: 1,
                fontSize: 16,
                fontWeight: '600',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
            <TextInput
              value={amountText}
              onChangeText={setAmountText}
              placeholder="320"
              keyboardType="decimal-pad"
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel="Item amount"
              onSubmitEditing={addItem}
              style={{
                width: 90,
                fontSize: 16,
                fontWeight: '700',
                textAlign: 'right',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
            <Button
              label="Add"
              size="sm"
              variant="secondary"
              disabled={toMinor(amountText) <= 0n}
              onPress={addItem}
            />
          </Row>
        </Card>

        {items.map((item) => (
          <Card key={item.key} style={{ gap: theme.spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="subheading" style={{ flex: 1 }} numberOfLines={1}>
                {item.label}
              </Text>
              <MoneyText amount={item.total} currency={currency} locale={locale} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${item.label}`}
                onPress={() => setItems((current) => current.filter((row) => row.key !== item.key))}
              >
                <Ionicons name="trash-outline" size={18} color={theme.color.textFaint} />
              </Pressable>
            </Row>

            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.md }}>
              {(members.data ?? []).map((member) => {
                const claimed = item.claimers.includes(member.id);
                return (
                  <Pressable
                    key={member.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: claimed }}
                    accessibilityLabel={`${displayName(member, profile?.id)} had ${item.label}`}
                    onPress={() => toggleClaim(item.key, member.id)}
                    style={{ alignItems: 'center', gap: 4, opacity: claimed ? 1 : 0.35 }}
                  >
                    <Avatar name={displayName(member)} ghost={isGhost(member)} size={38} />
                    <Text variant="micro" tone={claimed ? 'brand' : 'muted'}>
                      {displayName(member, profile?.id)}
                    </Text>
                  </Pressable>
                );
              })}
            </Row>

            {item.claimers.length === 0 ? (
              <Badge label="nobody has claimed this" tone="negative" />
            ) : item.claimers.length > 1 ? (
              <Text variant="micro" tone="muted">
                {`split ${item.claimers.length} ways`}
              </Text>
            ) : null}
          </Card>
        ))}

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            Tax and tip — prorated by what each person ordered
          </Text>
          <Row>
            <Text variant="body" style={{ flex: 1 }}>
              Tax / service
            </Text>
            <Text variant="body" tone="muted">
              {currencySymbol(currency, locale)}
            </Text>
            <TextInput
              value={taxText}
              onChangeText={setTaxText}
              placeholder="0"
              keyboardType="decimal-pad"
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel="Tax amount"
              style={{
                width: 90,
                fontSize: 16,
                fontWeight: '700',
                textAlign: 'right',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
          </Row>
          <Row>
            <Text variant="body" style={{ flex: 1 }}>
              Tip
            </Text>
            <Text variant="body" tone="muted">
              {currencySymbol(currency, locale)}
            </Text>
            <TextInput
              value={tipText}
              onChangeText={setTipText}
              placeholder="0"
              keyboardType="decimal-pad"
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel="Tip amount"
              style={{
                width: 90,
                fontSize: 16,
                fontWeight: '700',
                textAlign: 'right',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
          </Row>
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">Total</Text>
            <MoneyText amount={grandTotal} currency={currency} locale={locale} variant="heading" />
          </Row>

          {preview ? (
            [...preview].map(([memberId, share]) => {
              const member = members.data?.find((row) => row.id === memberId);
              return (
                <Row key={memberId} style={{ justifyContent: 'space-between' }}>
                  <Row style={{ flex: 1 }}>
                    <Avatar
                      name={member ? displayName(member) : '?'}
                      ghost={member ? isGhost(member) : false}
                      size={30}
                    />
                    <Text variant="body">
                      {member ? displayName(member, profile?.id) : 'Someone'}
                    </Text>
                  </Row>
                  <MoneyText amount={share} currency={currency} locale={locale} variant="caption" />
                </Row>
              );
            })
          ) : (
            <Text variant="caption" tone="muted">
              {items.length === 0
                ? 'Add the lines from the bill and tap who had what.'
                : unclaimed.length > 0
                  ? `${unclaimed.length} line${unclaimed.length === 1 ? '' : 's'} still unclaimed — nobody pays for a dish nobody ordered.`
                  : 'Tap who had each line to see the split.'}
            </Text>
          )}

          {preview ? (
            <Text variant="micro" tone="faint">
              {`Tax and tip of ${format({ minor: taxes + tip, currency }, { locale, compactFraction: true })} are shared in proportion to each person's items.`}
            </Text>
          ) : null}
        </Card>

        {error ? (
          <Text variant="caption" tone="negative">
            {error}
          </Text>
        ) : null}

        <Button
          label={t.save}
          size="lg"
          fullWidth
          disabled={!preview || writeExpense.isPending}
          onPress={() => void save()}
        />
        {writeExpense.isPending ? <ActivityIndicator color={theme.color.brand} /> : null}
      </ScrollView>
    </Screen>
  );
}
