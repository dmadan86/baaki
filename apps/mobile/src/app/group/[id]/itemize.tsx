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
  Callout,
  Card,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { captureReceipt } from '@/lib/image';
import { publishReceiptItems, scanReceipt, scanReceiptText, setItemClaim } from '@/data/api';
import { recogniseReceipt } from '@/lib/ocr';
import { useGroup, useItemClaims, useReceipt, useWriteExpense } from '@/data/hooks';
import { displayName, groupLabel, isGhost } from '@/data/types';
import { fill, plural, useStrings } from '@/i18n';
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
 *
 * **Two modes, and the difference is who is holding a phone.**
 *
 * On your own, this is a list in React state: you type the lines, tap who had
 * what, save. Nothing is shared and nothing needs to be.
 *
 * Round a table it is a shared document. Whoever scanned the bill checks the
 * lines the model read — ADR-008 is that the model proposes and a person
 * confirms — and then hands them over with one button. From that moment the
 * lines are fixed and everybody claims their own, live, on their own phone.
 * The lines freeze because a claim is stored against a line's *index*: deleting
 * the second of six afterwards would move four people's dinners onto somebody
 * else's bill.
 *
 * Claims go through `baaki_set_item_claim`, which resolves who you are from
 * your session and refuses to take a member as an argument — the same rule as
 * `actor_member_id`. The single exception is a ghost member, who has no phone
 * to tap with, and whom therefore anybody may claim for.
 */
export default function ItemizeScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id, receipt: receiptParam } = useLocalSearchParams<{ id: string; receipt?: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();

  const { group, members } = useGroup(groupId);
  const writeExpense = useWriteExpense(groupId);

  // Arriving with `?receipt=` means somebody else scanned this and shared it;
  // there is nothing to correct and nothing to publish, only lines to claim.
  const [sharedId, setSharedId] = useState<string | null>(receiptParam ?? null);
  const shared = useReceipt(sharedId);
  const claims = useItemClaims(sharedId);
  const [publishing, setPublishing] = useState(false);

  const [description, setDescription] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [label, setLabel] = useState('');
  const [amountText, setAmountText] = useState('');
  const [taxText, setTaxText] = useState('');
  const [tipText, setTipText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  /** A bill that has been scanned but not yet handed to the table. */
  const [scanId, setScanId] = useState<string | null>(null);

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
      if (handover.draft.receiptId) setScanId(handover.draft.receiptId);
      setScanNote(t.itemize.carriedOver);
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
      setScanId(result.receiptId);

      // The arithmetic decides what the person is asked to look at. Saying
      // "scanned!" and leaving them to notice a wrong total is the failure
      // this whole path exists to avoid.
      setScanNote(
        result.check.reconciles && result.check.problems.length === 0
          ? plural(locale, result.parsed.items.length, t.itemize.scanReadItems)
          : (result.check.problems[0]?.message ?? t.itemize.scanCheckLines),
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

  const myMemberId = useMemo(
    () => (members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ?? null,
    [members.data, profile?.id],
  );

  const isShared = sharedId !== null;

  const ghostIds = useMemo(
    () => new Set((members.data ?? []).filter(isGhost).map((member) => member.id)),
    [members.data],
  );

  /**
   * The shared bill: lines from the receipt everybody is looking at, claimers
   * from the CRDT. Nothing here comes from local state — a line list that
   * differed between two phones would put the same claim on two different
   * dishes.
   */
  const sharedItems: DraftItem[] = useMemo(() => {
    const lines = shared.data?.parsed?.items ?? [];
    const byIndex = new Map<number, MemberId[]>();
    for (const row of claims.data ?? []) {
      byIndex.set(row.item_index, [...(byIndex.get(row.item_index) ?? []), row.member_id]);
    }
    return lines.map((line, index) => ({
      key: `shared-${index}`,
      label: line.label,
      total: BigInt(line.total),
      claimers: byIndex.get(index) ?? [],
    }));
  }, [shared.data, claims.data]);

  const shown = isShared ? sharedItems : items;

  const taxes = toMinor(taxText);
  const tip = toMinor(tipText);
  const itemsTotal = shown.reduce((total, item) => total + item.total, 0n);
  const grandTotal = itemsTotal + taxes + tip;

  const unclaimed = shown.filter((item) => item.claimers.length === 0);
  // Memoised: a fresh array each render would re-run the split preview forever.
  const participants = useMemo(() => [...new Set(shown.flatMap((item) => item.claimers))], [shown]);

  const splitParams: ItemizedParams = useMemo(
    () => ({
      kind: 'itemized',
      items: shown.map((item) => ({ label: item.label, total: item.total })),
      claims: Object.fromEntries(shown.map((item, index) => [index, item.claimers])),
      taxes,
      tip,
    }),
    [shown, taxes, tip],
  );

  const preview = useMemo(() => {
    if (shown.length === 0 || unclaimed.length > 0 || participants.length === 0) return null;
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
  }, [shown, unclaimed.length, participants, grandTotal, currency, splitParams]);

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
        <EmptyState title={t.group.notFound} body={t.group.notFoundArchived} />
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
        label: label.trim() || fill(t.itemize.itemFallback, { n: current.length + 1 }),
        total,
        // Whoever is adding the bill usually had something on it.
        claimers: myMemberId ? [myMemberId] : [],
      },
    ]);
    setLabel('');
    setAmountText('');
  };

  /**
   * Whether this phone may speak for that person.
   *
   * Yourself, always. A ghost, because they have no phone and somebody has to.
   * Anybody else with the app, never — the server refuses it too, and the
   * refusal is the point: a claim is a fact its owner asserted, not a guess
   * somebody else made on their behalf.
   */
  const mayClaimFor = (memberId: MemberId): boolean =>
    !isShared || memberId === myMemberId || ghostIds.has(memberId);

  const toggleClaim = async (itemKey: string, memberId: MemberId): Promise<void> => {
    if (!isShared) {
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
      return;
    }

    const index = shown.findIndex((item) => item.key === itemKey);
    const item = shown[index];
    if (index < 0 || !item) return;
    if (!mayClaimFor(memberId)) {
      setError(t.itemize.notYours);
      return;
    }

    setError(null);
    try {
      await setItemClaim({
        receiptId: sharedId,
        itemIndex: index,
        claimed: !item.claimers.includes(memberId),
        forMemberId: memberId === myMemberId ? null : memberId,
      });
      await claims.refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  /**
   * Hand the lines to the table.
   *
   * This is the moment the bill stops being one person's list and becomes a
   * shared document. It is also the last moment a misread line can be fixed,
   * which is why the button says what it does.
   */
  const publish = async (): Promise<void> => {
    if (!scanId || items.length === 0) return;
    setError(null);
    setPublishing(true);
    try {
      await publishReceiptItems(
        scanId,
        items.map((item) => ({ label: item.label, total: Number(item.total) })),
      );
      setSharedId(scanId);
      setScanNote(t.itemize.sharedNow);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPublishing(false);
    }
  };

  const save = async (): Promise<void> => {
    setError(null);
    if (!myMemberId) {
      setError(t.itemize.notAMember);
      return;
    }
    try {
      await writeExpense.mutateAsync({
        description: description.trim() || t.itemize.defaultDescription,
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
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.itemize.title}</Text>
            <Text variant="micro" tone="muted">
              {groupLabel(group.data, members.data ?? [])}
            </Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {isShared ? (
          /* A shared bill: the lines are settled, and the only thing left to do
             is say who had what. Everybody sees everybody else's taps. */
          <Card style={{ gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Ionicons name="people-outline" size={iconSize.md} color={theme.color.brand} />
              <Text variant="subheading" style={{ flex: 1 }}>
                {t.itemize.splittingTogether}
              </Text>
              {claims.isFetching ? <ActivityIndicator color={theme.color.brand} /> : null}
            </Row>
            <Text variant="caption" tone="muted">
              {t.itemize.splittingTogetherNote}
            </Text>
          </Card>
        ) : (
          <Card style={{ gap: theme.spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
                <Text variant="subheading">{t.itemize.scanTitle}</Text>
                <Text variant="caption" tone="muted">
                  {t.itemize.scanBody}
                </Text>
              </View>
              <Button
                label={scanning ? t.expense.reading : t.expense.scan}
                variant="secondary"
                disabled={scanning}
                onPress={() => void scan()}
                icon={
                  <Ionicons name="camera-outline" size={iconSize.md} color={theme.color.brand} />
                }
              />
            </Row>
            {scanning ? <ActivityIndicator color={theme.color.brand} /> : null}
            {scanNote ? (
              <Text variant="caption" tone="brand">
                {scanNote}
              </Text>
            ) : null}
          </Card>
        )}

        {/* The one-way door: correcting a misread line is a before-sharing job,
            so the button says what it costs as well as what it does. */}
        {!isShared && scanId && items.length > 0 ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">{t.itemize.everyoneHasAPhone}</Text>
            <Text variant="caption" tone="muted">
              {t.itemize.handOverNote}
            </Text>
            <Button
              label={publishing ? t.itemize.sharing : t.itemize.splitTogether}
              variant="secondary"
              disabled={publishing}
              onPress={() => void publish()}
              icon={<Ionicons name="people-outline" size={iconSize.md} color={theme.color.brand} />}
            />
          </Card>
        ) : null}

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.itemize.whatWasTheBillFor}
          </Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder={t.itemize.descriptionPlaceholder}
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel={t.itemize.descriptionLabel}
            style={{
              fontSize: 17,
              fontWeight: '600',
              color: theme.color.text,
              paddingVertical: theme.spacing.sm,
            }}
          />
        </Card>

        {/* Adding a line renumbers nothing, but removing one would — and the
            two belong together, so both wait until the bill is shared. */}
        {isShared ? null : (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {t.itemize.addALine}
            </Text>
            <Row>
              <TextInput
                value={label}
                onChangeText={setLabel}
                placeholder={t.itemize.itemPlaceholder}
                placeholderTextColor={theme.color.textFaint}
                accessibilityLabel={t.itemize.itemName}
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
                accessibilityLabel={t.itemize.itemAmount}
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
                label={t.add}
                size="sm"
                variant="secondary"
                disabled={toMinor(amountText) <= 0n}
                onPress={addItem}
              />
            </Row>
          </Card>
        )}

        {shown.map((item) => (
          <Card key={item.key} style={{ gap: theme.spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="subheading" style={{ flex: 1 }} numberOfLines={1}>
                {item.label}
              </Text>
              <MoneyText amount={item.total} currency={currency} locale={locale} />
              {isShared ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={fill(t.itemize.removeItem, { label: item.label })}
                  onPress={() =>
                    setItems((current) => current.filter((row) => row.key !== item.key))
                  }
                >
                  <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.textFaint} />
                </Pressable>
              )}
            </Row>

            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.md }}>
              {(members.data ?? []).map((member) => {
                const claimed = item.claimers.includes(member.id);
                const mine = mayClaimFor(member.id);
                return (
                  <Pressable
                    key={member.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: claimed }}
                    accessibilityLabel={fill(t.itemize.hadItem, {
                      name: displayName(member, profile?.id),
                      label: item.label,
                    })}
                    // Deliberately still tappable when it is not yours to
                    // change. `disabled` made it a silent no-op: tapping a
                    // friend's face on a shared bill did nothing at all and
                    // never reached the sentence explaining why — which, on
                    // two phones round a table, reads as the app being broken
                    // rather than as a rule.
                    onPress={() => void toggleClaim(item.key, member.id)}
                    style={{
                      alignItems: 'center',
                      gap: 4,
                      // Somebody else's claim still shows — that is the point of
                      // doing this together — it just is not yours to change.
                      // Unclaimed stays legible (you must be able to read who you
                      // would assign an item to); claimed gets the strongest ink.
                      opacity: claimed ? 1 : mine ? 0.6 : 0.5,
                    }}
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
              <Badge label={t.itemize.unclaimed} tone="negative" />
            ) : item.claimers.length > 1 ? (
              <Text variant="micro" tone="muted">
                {plural(locale, item.claimers.length, t.itemize.splitWays)}
              </Text>
            ) : null}
          </Card>
        ))}

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.itemize.taxAndTipNote}
          </Text>
          <Row>
            <Text variant="body" style={{ flex: 1 }}>
              {t.itemize.taxRow}
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
              accessibilityLabel={t.itemize.taxAmount}
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
              {t.itemize.tipRow}
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
              accessibilityLabel={t.itemize.tipAmount}
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
            <Text variant="subheading">{t.itemize.total}</Text>
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
                      {member ? displayName(member, profile?.id) : t.itemize.someone}
                    </Text>
                  </Row>
                  <MoneyText amount={share} currency={currency} locale={locale} variant="caption" />
                </Row>
              );
            })
          ) : (
            <Text variant="caption" tone="muted">
              {shown.length === 0
                ? isShared
                  ? t.itemize.waitingForLines
                  : t.itemize.addTheLines
                : unclaimed.length > 0
                  ? plural(locale, unclaimed.length, t.itemize.stillUnclaimed)
                  : t.itemize.tapWhoHadEach}
            </Text>
          )}

          {preview ? (
            <Text variant="micro" tone="muted">
              {t.itemize.taxAndTipShared.replace(
                '{amount}',
                format({ minor: taxes + tip, currency }, { locale, compactFraction: true }),
              )}
            </Text>
          ) : null}
        </Card>

        {error ? <Callout tone="negative">{error}</Callout> : null}

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
