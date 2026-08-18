/**
 * Speak an expense — one or several, in any language, with an optional new group.
 *
 * Reached from the raised mic. The phone turns speech into text on-device (see
 * VoiceMicPanel). What that text means is worked out in two tiers: when the
 * reader has connected their own model key, {@link interpretVoiceExpenses} asks
 * the model — which handles several expenses in a breath, other languages, and a
 * spoken "make a group called X" far better than rules can; with no key, or if
 * the call fails, the pure {@link parseVoiceExpenses} heuristic does the certain
 * part (amounts, currencies, a named group) on its own.
 *
 * Either way the last step is a review, never a blind write: the heard expenses
 * are listed, each editable, with a destination to choose — the capture inbox
 * (unassigned, the default), an existing group, or a new group the sentence
 * asked for. Only then does Save write them.
 *
 * The route imports nothing native directly: the microphone is reached through
 * VoiceMicPanel, which loads the native module inside a try, so an older binary
 * shows a message instead of crashing.
 */

import { useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { computeShares, type SplitParams } from '@waves/core';
import {
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
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import {
  useCreateCapture,
  useCreateGroup,
  useGroup,
  useGroups,
  useWriteExpense,
} from '@/data/hooks';
import { groupLabel, GroupType, type GroupRow } from '@/data/types';
import { deviceDefaultCurrency, plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { aiEnabled, useAiAccess } from '@/lib/aiAccess';
import { friendlyError } from '@/lib/errors';
import { VoiceMicPanel } from '@/components/VoiceMicPanel';
import { parseVoiceExpenses, type VoiceGroupRef, type VoiceParseResult } from '@/lib/voiceExpense';
import { interpretVoiceExpenses } from '@/lib/voiceLlm';

/** One editable line on the review screen. */
interface Draft {
  key: string;
  amount: string;
  note: string;
  currency: string | null;
}

/** Where the reviewed expenses will be written. */
type Dest =
  | { kind: 'unassigned' }
  | { kind: 'existing'; groupId: string }
  | { kind: 'create'; groupId: string; memberId: string; name: string };

const EQUAL: SplitParams = { kind: 'equal' };

/** Today as `YYYY-MM-DD` — the expense date a spoken expense is filed under. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A major-unit amount string to minor units, or null when it is not a number. */
function toMinor(amount: string): bigint | null {
  const value = Number.parseFloat(amount.replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.round(value * 100));
}

export default function VoiceScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const insets = useSafeAreaInsets();
  const { t, locale } = useStrings();
  const { profile } = useAuth();
  const access = useAiAccess();
  const groups = useGroups();

  const createCapture = useCreateCapture();
  const createGroup = useCreateGroup();

  // 'listening' → the mic; 'thinking' → the model is reading; 'review' → the
  // heard expenses, editable, awaiting a destination and a Save.
  const [phase, setPhase] = useState<'listening' | 'thinking' | 'review'>('listening');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dest, setDest] = useState<Dest>({ kind: 'unassigned' });
  // The destination folds into a single row that opens this sheet, so the
  // expenses — not a wall of group rows — are the first thing on the review.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [noAmount, setNoAmount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Remounts the mic to start a fresh utterance after a miss.
  const [attempt, setAttempt] = useState(0);
  // The "make a new group" the sentence asked for, kept apart from the current
  // destination so its row stays selectable after the reader picks the inbox or
  // an existing group instead.
  const [requested, setRequested] = useState<{
    groupId: string;
    memberId: string;
    name: string;
  } | null>(null);
  // A new group is created once, not again on a save retry after a partial
  // failure. Flipped true after the create lands; reset when a fresh parse comes.
  const groupCreated = useRef(false);

  const groupRows = groups.data ?? [];
  const groupRefs: VoiceGroupRef[] = groupRows.map((group) => ({ id: group.id, name: group.name }));
  const hints = groupRows.map((group) => group.name ?? '').filter(Boolean);

  // Members and currency of the chosen group, read from the local mirror. Empty
  // id (the unassigned/create cases) reads nothing, which is what we want.
  const targetGroupId = dest.kind === 'existing' ? dest.groupId : '';
  const target = useGroup(targetGroupId);
  const writeExpense = useWriteExpense(dest.kind === 'unassigned' ? '' : dest.groupId);

  const applyResult = (result: VoiceParseResult): void => {
    if (result.items.length === 0) {
      setNoAmount(true);
      setAttempt((current) => current + 1);
      setPhase('listening');
      return;
    }
    setDrafts(
      result.items.map((item) => ({
        key: randomUUID(),
        amount: String(item.amountMajor),
        note: item.note,
        currency: item.currency,
      })),
    );
    // A fresh parse is a fresh group to create.
    groupCreated.current = false;
    // Default the destination to what was heard: a new group to make, an
    // existing group named, else the capture inbox.
    if (result.group?.kind === 'create') {
      const created = { groupId: randomUUID(), memberId: randomUUID(), name: result.group.name };
      setRequested(created);
      setDest({ kind: 'create', ...created });
    } else if (result.group?.kind === 'existing') {
      setRequested(null);
      setDest({ kind: 'existing', groupId: result.group.groupId });
    } else {
      setRequested(null);
      setDest({ kind: 'unassigned' });
    }
    setNoAmount(false);
    setPhase('review');
  };

  const handleTranscript = (transcript: string): void => {
    setPhase('thinking');
    void (async () => {
      // With a key, let the model read it (several expenses, other languages, a
      // spoken new group). It self-guards on the key and returns null when there
      // is none or the call fails — then the pure heuristic takes over.
      let result: VoiceParseResult | null = null;
      if (aiEnabled(access)) {
        result = await interpretVoiceExpenses(transcript, {
          groups: groupRefs,
          locale,
          defaultCurrency: deviceDefaultCurrency(),
        }).catch(() => null);
      }
      applyResult(result ?? parseVoiceExpenses(transcript, groupRefs));
    })();
  };

  const retry = (): void => {
    setNoAmount(false);
    setError(null);
    setRequested(null);
    groupCreated.current = false;
    setPhase('listening');
    setAttempt((current) => current + 1);
  };

  const editDraft = (key: string, patch: Partial<Draft>): void => {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  };
  const removeDraft = (key: string): void => {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
  };

  const save = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const date = today();
      const fallback = t.voice.anExpense;

      if (dest.kind === 'unassigned') {
        for (const draft of drafts) {
          const amount = toMinor(draft.amount);
          if (amount === null) continue;
          // The draft's own id is the capture id, so a save retried after a
          // partial failure re-uses it rather than minting a second capture.
          await createCapture.mutateAsync({
            captureId: draft.key,
            description: draft.note.trim() || fallback,
            expenseDate: date,
            currency: draft.currency ?? deviceDefaultCurrency(),
            amount,
          });
        }
        router.replace('/captures');
        return;
      }

      // A group destination. Make the group first if it is a new one — its id
      // and the reader's member id were chosen up front, so an expense can name
      // them in the same breath (the offline-first pattern used elsewhere). The
      // ref guards a second create on a retry: the group exists after the first.
      if (dest.kind === 'create' && !groupCreated.current) {
        await createGroup.mutateAsync({
          groupId: dest.groupId,
          creatorMemberId: dest.memberId,
          name: dest.name,
          type: GroupType.Other,
          currency: deviceDefaultCurrency(),
        });
        groupCreated.current = true;
      }

      const groupCurrency =
        dest.kind === 'create'
          ? deviceDefaultCurrency()
          : (target.group.data?.default_currency ?? deviceDefaultCurrency());
      const participants =
        dest.kind === 'create'
          ? [dest.memberId]
          : (target.members.data ?? []).map((member) => member.id);
      const payer =
        dest.kind === 'create'
          ? dest.memberId
          : ((target.members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ??
            participants[0]);

      if (participants.length === 0 || !payer) throw new Error('no members to split among');

      for (const draft of drafts) {
        const amount = toMinor(draft.amount);
        if (amount === null) continue;
        // Every spoken expense is "I paid, split it equally" — the group's own
        // currency, everyone in, me as payer. The reader can refine any of it on
        // the expense afterwards; this is the sane default, not a guess to hide.
        // The draft's stable id is the expense id (and the split seed), so a
        // retry appends no duplicate.
        const expenseId = draft.key;
        const shares = computeShares({
          amount,
          currency: groupCurrency,
          params: EQUAL,
          participants,
          seed: expenseId,
        });
        await writeExpense.mutateAsync({
          expenseId,
          description: draft.note.trim() || fallback,
          category: null,
          expenseDate: date,
          currency: groupCurrency,
          amount,
          splitParams: EQUAL,
          participants,
          payers: { [payer]: amount },
          // ShareMap is a Map; the write input wants a plain record.
          expectedShares: Object.fromEntries(shares),
        });
      }
      router.replace({ pathname: '/group/[id]', params: { id: dest.groupId } });
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'voice.save'));
    } finally {
      setSaving(false);
    }
  };

  // Every draft must carry a real amount — an empty or non-numeric field would
  // otherwise be silently skipped, and a screenful of them would "save" nothing
  // while still navigating away.
  const canSave =
    drafts.length > 0 && !saving && drafts.every((draft) => toMinor(draft.amount) !== null);

  // The footer shows a running total, but only when every draft is in one
  // currency — there is no total across currencies (ADR-004), so a mixed batch
  // shows its count instead of a number that would not mean anything.
  const draftTotals = new Map<string, bigint>();
  for (const draft of drafts) {
    const minor = toMinor(draft.amount);
    if (minor === null) continue;
    const currency = draft.currency ?? deviceDefaultCurrency();
    draftTotals.set(currency, (draftTotals.get(currency) ?? 0n) + minor);
  }
  const singleTotal = draftTotals.size === 1 ? [...draftTotals.entries()][0] : null;

  const current = describeDest(dest, groupRows, t);

  return (
    <Screen>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: phase === 'review' ? theme.spacing.xl : clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row
          style={{
            paddingTop: theme.spacing.md,
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          {/* The heading wears the voice glyph so the screen reads as "the thing
              you spoke", not a generic form — the same mic that started the
              flow, carried through to the review. */}
          <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
            <Ionicons name="mic" size={iconSize.lg} color={theme.color.brand} />
            <Text variant="heading">{phase === 'review' ? t.voice.review : t.voice.title}</Text>
          </Row>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
        </Row>

        {error ? <Callout tone="negative">{error}</Callout> : null}

        {phase === 'thinking' ? (
          <View
            style={{ alignItems: 'center', gap: theme.spacing.lg, paddingTop: theme.spacing.xxl }}
          >
            <ActivityIndicator color={theme.color.brand} />
            <Text tone="muted">{t.voice.thinking}</Text>
          </View>
        ) : phase === 'review' ? (
          <View style={{ gap: theme.spacing.xl }}>
            {/* The expenses are the hero: the receipt cards sit at the top, so
                the first thing on the review is what you actually said, not a
                column of destinations. */}
            <View style={{ gap: theme.spacing.md }}>
              {drafts.map((draft) => (
                <DraftRow
                  key={draft.key}
                  draft={draft}
                  onEdit={editDraft}
                  onRemove={removeDraft}
                  removeLabel={t.captures.delete}
                  amountLabel={t.captures.amount}
                  noteLabel={t.captures.description}
                  notePlaceholder={t.captures.descriptionPlaceholder}
                  theme={theme}
                />
              ))}
            </View>

            {/* Destination folded to one selector row — the whole group list
                would otherwise dwarf the expenses. Tapping opens the picker as
                a sheet. */}
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
                {t.voice.saveTo.toUpperCase()}
              </Text>
              <Card padded={false} style={{ overflow: 'hidden' }}>
                <Pressable
                  onPress={() => setPickerOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.voice.saveTo}: ${current.label}`}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing.md,
                    paddingVertical: theme.spacing.md,
                    paddingHorizontal: theme.spacing.lg,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.color.brandSoft,
                    }}
                  >
                    {current.emoji ? (
                      <Text style={{ fontSize: 18 }}>{current.emoji}</Text>
                    ) : (
                      <Ionicons name={current.icon} size={iconSize.md} color={theme.color.brand} />
                    )}
                  </View>
                  <Text numberOfLines={1} style={{ flex: 1, color: theme.color.text }}>
                    {current.label}
                  </Text>
                  <Ionicons name="chevron-down" size={iconSize.md} color={theme.color.textMuted} />
                </Pressable>
              </Card>
            </View>
          </View>
        ) : (
          // Listening.
          <View style={{ gap: theme.spacing.lg, paddingTop: theme.spacing.xxl }}>
            {noAmount ? <Callout tone="warning">{t.voice.noAmount}</Callout> : null}
            <VoiceMicPanel key={attempt} onDone={handleTranscript} hints={hints} />
            {noAmount ? (
              <Button
                label={t.voice.tryAgain}
                variant="secondary"
                onPress={retry}
                style={{ alignSelf: 'center' }}
              />
            ) : null}
          </View>
        )}
      </ScrollView>

      {/* Sticky action bar: the running total on the left, Save on the right —
          anchored to the foot so it is reachable no matter how the list grows,
          the pattern every checkout and expense-review screen settles on. */}
      {phase === 'review' ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.lg,
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            paddingBottom: insets.bottom + theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.color.border,
            backgroundColor: theme.color.surface,
          }}
        >
          <View style={{ gap: 2 }}>
            <Text variant="micro" tone="muted">
              {t.itemize.total}
            </Text>
            {singleTotal ? (
              <MoneyText
                amount={singleTotal[1]}
                currency={singleTotal[0]}
                locale={locale}
                mode="plain"
                variant="subheading"
              />
            ) : (
              <Text variant="subheading">{plural(locale, drafts.length, t.voice.save)}</Text>
            )}
          </View>
          <Button
            label={plural(locale, drafts.length, t.voice.save)}
            onPress={() => void save()}
            disabled={!canSave}
          />
        </View>
      ) : null}

      {/* The destination picker, as a dismissible bottom sheet. */}
      <Modal
        transparent
        visible={pickerOpen}
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          onPress={() => setPickerOpen(false)}
          accessibilityLabel={t.common.close}
          style={{
            flex: 1,
            backgroundColor: 'rgba(10, 10, 26, 0.55)',
            justifyContent: 'flex-end',
          }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: theme.color.bg,
              borderTopLeftRadius: theme.radius.xxl,
              borderTopRightRadius: theme.radius.xxl,
              paddingHorizontal: theme.spacing.xl,
              paddingTop: theme.spacing.lg,
              paddingBottom: insets.bottom + theme.spacing.xl,
              gap: theme.spacing.lg,
              ...theme.shadow.lifted,
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
            <DestinationPicker
              dest={dest}
              requested={requested}
              onChoose={(next) => {
                setDest(next);
                setPickerOpen(false);
              }}
              groups={groupRows}
              t={t}
              theme={theme}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

/** The current destination as a label plus a leading emoji or icon — what the
 * folded "Save to" selector shows before the picker sheet is opened. */
function describeDest(
  dest: Dest,
  groups: GroupRow[],
  t: ReturnType<typeof useStrings>['t'],
): { label: string; emoji?: string | null; icon: React.ComponentProps<typeof Ionicons>['name'] } {
  if (dest.kind === 'unassigned') {
    return { label: t.captures.unassigned, icon: 'file-tray-full-outline' };
  }
  if (dest.kind === 'create') {
    return {
      label: t.voice.newGroupNamed.replace('{name}', dest.name),
      icon: 'add-circle-outline',
    };
  }
  const group = groups.find((candidate) => candidate.id === dest.groupId);
  if (!group) return { label: t.captures.unassigned, icon: 'people-outline' };
  return {
    label: groupLabel(group),
    emoji: group.cover_emoji,
    icon: GROUP_TYPE_ICON[group.type] ?? 'people-outline',
  };
}

/** One Ionicon per group type, the fallback when a group has no cover emoji —
 * echoing the new-group picker and the dashboard's category glyphs. */
const GROUP_TYPE_ICON: Record<GroupType, React.ComponentProps<typeof Ionicons>['name']> = {
  [GroupType.Trip]: 'airplane',
  [GroupType.Home]: 'home',
  [GroupType.Couple]: 'heart',
  [GroupType.Event]: 'sparkles',
  [GroupType.Other]: 'people-outline',
};

/**
 * The one choice a Save needs: where the expenses land. The capture inbox is
 * always offered and is the default; a "new group" row appears when the sentence
 * asked for one; then every existing group. The selected row carries a check.
 */
function DestinationPicker({
  dest,
  requested,
  onChoose,
  groups,
  t,
  theme,
}: {
  dest: Dest;
  requested: { groupId: string; memberId: string; name: string } | null;
  onChoose: (dest: Dest) => void;
  groups: GroupRow[];
  t: ReturnType<typeof useStrings>['t'];
  theme: ReturnType<typeof useTheme>;
}) {
  type Row = {
    key: string;
    label: string;
    // A row wears either the group's own cover emoji or, lacking one, an Ionicon
    // — the inbox and "new group" rows only ever use an icon.
    icon: React.ComponentProps<typeof Ionicons>['name'];
    emoji?: string | null;
    selected: boolean;
    onPress: () => void;
  };
  const rows: Row[] = [
    {
      key: 'unassigned',
      label: t.captures.unassigned,
      // The inbox row wears the dashboard's captures glyph, so "Unassigned" here
      // and the captures card on Home read as the same place.
      icon: 'file-tray-full-outline',
      selected: dest.kind === 'unassigned',
      onPress: () => onChoose({ kind: 'unassigned' }),
    },
  ];
  // Driven by the persisted request, not the current destination, so the "new
  // group" row stays offered after the reader switches to the inbox or a group.
  if (requested) {
    rows.push({
      key: 'create',
      label: t.voice.newGroupNamed.replace('{name}', requested.name),
      icon: 'add-circle-outline',
      selected: dest.kind === 'create',
      onPress: () => onChoose({ kind: 'create', ...requested }),
    });
  }
  // Newest group first: the one you just made is the one you are most likely
  // saving into, so it sits at the top of the list rather than lost in creation
  // order. Every row carries its own cover emoji (or a type glyph as a fallback)
  // so a trip, a home and an event are told apart at a glance instead of a
  // column of identical people icons.
  const sorted = [...groups].sort((a, b) => {
    // Newest first by creation time; when two groups share a timestamp (made in
    // the same request), fall back to id so the order is stable across renders
    // rather than flipping on every re-sort.
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const group of sorted) {
    rows.push({
      key: group.id,
      label: groupLabel(group),
      icon: GROUP_TYPE_ICON[group.type] ?? 'people-outline',
      emoji: group.cover_emoji,
      selected: dest.kind === 'existing' && dest.groupId === group.id,
      onPress: () => onChoose({ kind: 'existing', groupId: group.id }),
    });
  }

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
        {t.voice.saveTo.toUpperCase()}
      </Text>
      {/* One grouped card, hairlines between rows — the destination is a single
          choice, so it reads as a single control (Expensify "To", Monzo lists)
          rather than a stack of floating pills. Selection is a leading glyph
          that lights to brand plus a filled radio, not a full-width purple fill. */}
      <Card padded={false} style={{ overflow: 'hidden' }}>
        {rows.map((row, index) => (
          <View key={row.key}>
            <Pressable
              onPress={row.onPress}
              accessibilityRole="button"
              accessibilityState={{ selected: row.selected }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.md,
                paddingVertical: theme.spacing.md,
                paddingHorizontal: theme.spacing.lg,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: row.selected ? theme.color.brandSoft : theme.color.surfaceMuted,
                }}
              >
                {row.emoji ? (
                  <Text style={{ fontSize: 18 }}>{row.emoji}</Text>
                ) : (
                  <Ionicons
                    name={row.icon}
                    size={iconSize.md}
                    color={row.selected ? theme.color.brand : theme.color.textMuted}
                  />
                )}
              </View>
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  color: row.selected ? theme.color.brand : theme.color.text,
                  fontWeight: row.selected ? '600' : '400',
                }}
              >
                {row.label}
              </Text>
              <Ionicons
                name={row.selected ? 'checkmark-circle' : 'ellipse-outline'}
                size={iconSize.md}
                color={row.selected ? theme.color.brand : theme.color.border}
              />
            </Pressable>
            {index < rows.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card>
    </View>
  );
}

/** One editable expense line: an amount, a note, and a way to drop it. */
function DraftRow({
  draft,
  onEdit,
  onRemove,
  removeLabel,
  amountLabel,
  noteLabel,
  notePlaceholder,
  theme,
}: {
  draft: Draft;
  onEdit: (key: string, patch: Partial<Draft>) => void;
  onRemove: (key: string) => void;
  removeLabel: string;
  amountLabel: string;
  noteLabel: string;
  notePlaceholder: string;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    // A receipt-glyph node (the same one the feeds use), the amount as the hero
    // with its currency, and the note on the line beneath — a card that reads as
    // one expense at a glance (Copilot / Expensify review rows), editable in
    // place. Remove is a quiet trailing control, not a heavy grey disc.
    <Card>
      <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.brandSoft,
          }}
        >
          <Ionicons name="receipt-outline" size={iconSize.lg} color={theme.color.brand} />
        </View>

        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            {draft.currency ? (
              <Text variant="caption" tone="muted" style={{ fontWeight: '600' }}>
                {draft.currency}
              </Text>
            ) : null}
            <TextInput
              value={draft.amount}
              onChangeText={(value) => onEdit(draft.key, { amount: value })}
              keyboardType="decimal-pad"
              accessibilityLabel={amountLabel}
              style={{
                flex: 1,
                fontSize: 24,
                fontWeight: '700',
                color: theme.color.text,
                paddingVertical: 0,
              }}
            />
          </Row>
          <TextInput
            value={draft.note}
            onChangeText={(value) => onEdit(draft.key, { note: value })}
            placeholder={notePlaceholder}
            placeholderTextColor={theme.color.textFaint}
            accessibilityLabel={noteLabel}
            style={{ fontSize: 15, color: theme.color.textMuted, paddingVertical: 0 }}
          />
        </View>

        <IconButton label={removeLabel} onPress={() => onRemove(draft.key)}>
          <Ionicons name="close" size={iconSize.md} color={theme.color.textFaint} />
        </IconButton>
      </Row>
    </Card>
  );
}
