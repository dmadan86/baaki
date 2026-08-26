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

import { useCallback, useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { computeShares, minorUnitScale, type ExpenseLocation, type SplitParams } from '@waves/core';
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
  useAddGhostMember,
  useCreateCapture,
  useCreateGroup,
  useGroup,
  useGroups,
  usePeopleBalances,
  useWriteExpense,
} from '@/data/hooks';
import { groupLabel, GroupType, type GroupRow } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useDefaultCurrency } from '@/lib/currency';
import { aiEnabled, useAiAccess } from '@/lib/aiAccess';
import { friendlyError } from '@/lib/errors';
import { VoiceMicPanel } from '@/components/VoiceMicPanel';
import { LocationField } from '@/components/LocationField';
import { captureLocation, locationAvailable } from '@/lib/location';
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
  | { kind: 'create'; groupId: string; memberId: string; name: string }
  // A brand-new individual: a 1:1 group named after them, created with a ghost
  // for the person, on save. An *existing* person is a plain `existing` pointing
  // at their 1:1 group — no new kind needed. `groupId`/`memberId` are minted up
  // front so the create and the expense can name them in the same offline batch,
  // the same pattern the Add-person screen uses.
  | { kind: 'person'; groupId: string; memberId: string; name: string };

/** A person the batch can be assigned to on the review — an existing friend
 *  (reuses their 1:1 group) surfaced by name in the picker. */
interface PersonChoice {
  personKey: string;
  name: string;
  groupId: string;
}

const EQUAL: SplitParams = { kind: 'equal' };

/** Today as `YYYY-MM-DD` — the expense date a spoken expense is filed under. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A major-unit amount string to minor units in the given currency, or null when
 * it is not a number. The scale is the currency's own — 100 for rupees and
 * dollars, but 1 for yen and 1000 for dinar — so a "¥3000" expense is ¥3000, not
 * a hundredfold ¥300000. (Was a flat ×100, which only held for two-decimal
 * currencies.)
 */
function toMinor(amount: string, currency: string): bigint | null {
  const value = Number.parseFloat(amount.replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.round(value * Number(minorUnitScale(currency))));
}

export default function VoiceScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const insets = useSafeAreaInsets();
  const { t, locale } = useStrings();
  const { profile } = useAuth();
  const dc = useDefaultCurrency();
  const access = useAiAccess();
  const groups = useGroups();
  // Opened from a group's own screens (the raised mic passes its id), so a
  // spoken expense lands in that group by default rather than the unassigned
  // inbox. The reader can still switch the destination on the review; and a
  // sentence that names a different group ("…for the Goa trip") still wins.
  const params = useLocalSearchParams<{ group?: string }>();
  const launchGroupId = typeof params.group === 'string' ? params.group : null;

  const createCapture = useCreateCapture();
  const createGroup = useCreateGroup();
  // Existing people, by name, so a spoken expense can be pointed at an
  // individual — not only a group. Each is a pairwise balance the viewer has;
  // the ones explained by a single group (`only_group_id`) are their 1:1 group,
  // which the picker reuses. Computed from the mirror, so it works offline.
  const people = usePeopleBalances(profile?.id ?? null);
  const peopleChoices: PersonChoice[] = (() => {
    const byGroup = new Map<string, PersonChoice>();
    for (const row of people.data ?? []) {
      if (!row.only_group_id) continue;
      // One entry per 1:1 group (a person has one row per currency); newest name
      // wins, which is fine — they share a display name.
      byGroup.set(row.only_group_id, {
        personKey: row.person_key,
        name: row.display_name,
        groupId: row.only_group_id,
      });
    }
    return [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();

  // 'listening' → the mic; 'thinking' → the model is reading; 'review' → the
  // heard expenses, editable, awaiting a destination and a Save.
  const [phase, setPhase] = useState<'listening' | 'thinking' | 'review'>('listening');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // One place for the whole spoken batch — a run of "coffee, then the taxi" all
  // happened where you are standing (A43). Optional and opt-in; null until the
  // reader taps "Add location" on the review.
  const [location, setLocation] = useState<ExpenseLocation | null>(null);
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
  // The ghost for a brand-new person, minted once on the first save and reused
  // on a retry (so a partial failure does not add a second ghost). Reset with a
  // fresh parse or a change of destination.
  const ghostMemberId = useRef<string | null>(null);
  // A Save (or a close that persists the batch as a draft) has already taken
  // over navigation — so the leave-guard below stands aside instead of writing
  // the captures a second time.
  const committed = useRef(false);
  // The review reads the current location once, on its own, so the batch is
  // filed where it happened without the reader having to ask for it — a spoken
  // expense is nearly always logged on the spot. Latched so the read fires once
  // per batch (not on every render, and not again after the reader clears or
  // adjusts the pin); reset when a fresh parse opens a new review.
  const autoLocated = useRef(false);
  // Guards the async auto-read from clobbering a later truth. `locationGen`
  // ticks once per parsed batch, so a fix that arrives after a new utterance is
  // dropped; `locationTouched` flips the moment the reader sets or clears the
  // pin by hand, so an in-flight auto-read never overrides their choice.
  const locationGen = useRef(0);
  const locationTouched = useRef(false);

  const navigation = useNavigation();

  const groupRows = groups.data ?? [];
  const groupRefs: VoiceGroupRef[] = groupRows.map((group) => ({ id: group.id, name: group.name }));
  const hints = groupRows.map((group) => group.name ?? '').filter(Boolean);

  // Members and currency of the chosen group, read from the local mirror. Empty
  // id (the unassigned/create cases) reads nothing, which is what we want.
  const targetGroupId = dest.kind === 'existing' ? dest.groupId : '';
  const target = useGroup(targetGroupId);
  const writeExpense = useWriteExpense(dest.kind === 'unassigned' ? '' : dest.groupId);
  // Bound to the new person's minted group id; only ever fired when saving a
  // `person` destination, so the empty id in every other case is inert.
  const addGhost = useAddGhostMember(dest.kind === 'person' ? dest.groupId : '');

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
    // A fresh parse is a fresh group to create, and a fresh location to read.
    groupCreated.current = false;
    ghostMemberId.current = null;
    autoLocated.current = false;
    locationGen.current += 1;
    locationTouched.current = false;
    setLocation(null);
    // Default the destination to what was heard: a new group to make, an
    // existing group named, else the capture inbox.
    if (result.group?.kind === 'create') {
      const created = { groupId: randomUUID(), memberId: randomUUID(), name: result.group.name };
      setRequested(created);
      setDest({ kind: 'create', ...created });
    } else if (result.group?.kind === 'existing') {
      setRequested(null);
      setDest({ kind: 'existing', groupId: result.group.groupId });
    } else if (
      launchGroupId &&
      (groups.data == null || groupRows.some((group) => group.id === launchGroupId))
    ) {
      // No group named in the sentence, but the mic was opened from a group —
      // default to it. The id came from a real group route, so it is trusted
      // while the group mirror is still loading (`groups.data` null): a
      // transcript that resolves before hydration must not fall to the inbox and
      // then never re-evaluate. Once the mirror has loaded, a stale id (a group
      // left or deleted since the screen opened) is no longer among the rows and
      // falls through to the inbox below.
      setRequested(null);
      setDest({ kind: 'existing', groupId: launchGroupId });
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
          defaultCurrency: dc,
        }).catch(() => null);
      }
      applyResult(result ?? parseVoiceExpenses(transcript, groupRefs));
    })();
  };

  const editDraft = (key: string, patch: Partial<Draft>): void => {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  };
  const removeDraft = (key: string): void => {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
  };

  // The reader set or cleared the pin by hand. Latch it so a still-pending
  // auto-read cannot come back and overwrite their choice.
  const handleLocationChange = (next: ExpenseLocation | null): void => {
    locationTouched.current = true;
    setLocation(next);
  };

  // Write the heard expenses into the capture inbox — the app's draft holding
  // area. Each draft's own id is the capture id, so a retry (or the leave-guard
  // firing after a Save that half-finished) re-uses it rather than minting a
  // duplicate. Shared by the "Save as draft" button and the close-intercept, so
  // the two land the same rows.
  const persistDraftsToInbox = useCallback(async (): Promise<void> => {
    const date = today();
    const fallback = t.voice.anExpense;
    for (const draft of drafts) {
      const currency = draft.currency ?? dc;
      const amount = toMinor(draft.amount, currency);
      if (amount === null) continue;
      await createCapture.mutateAsync({
        captureId: draft.key,
        description: draft.note.trim() || fallback,
        expenseDate: date,
        currency,
        amount,
        location,
      });
    }
  }, [drafts, dc, location, t.voice.anExpense, createCapture]);

  // Leaving the review with a draft batch and no group chosen must not throw the
  // expenses away — an unassigned batch is a draft, and a draft survives a close
  // (the user's rule). So intercept every way off the screen (the ✕, the OS back
  // gesture, the hardware back key) and file the batch in the inbox first. A
  // group destination is left to the explicit Save; closing it discards, as
  // before. `committed` stands the guard down once a Save is already navigating.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (event) => {
      if (committed.current) return;
      if (phase !== 'review' || dest.kind !== 'unassigned') return;
      if (drafts.length === 0) return;
      // A draft is only kept if the whole batch is savable. Persisting only the
      // valid rows would silently drop the rest; leaving with an all-invalid
      // batch would lose it entirely. So if any row lacks a real amount, hold
      // the reader on the review with the batch intact and say why — they fix
      // the amount or remove the row (dropping to an empty batch, which leaves
      // freely). This mirrors the Save button, which is disabled on the same
      // condition.
      const allSavable = drafts.every(
        (draft) => toMinor(draft.amount, draft.currency ?? dc) !== null,
      );
      if (!allSavable) {
        event.preventDefault();
        setError(t.voice.draftNeedsAmounts);
        return;
      }
      event.preventDefault();
      committed.current = true;
      void (async () => {
        try {
          await persistDraftsToInbox();
          navigation.dispatch(event.data.action);
        } catch (caught) {
          // Keep the reader on the review with their batch intact rather than
          // navigating away having lost it.
          committed.current = false;
          setError(friendlyError(caught, t.couldNotSave, 'voice.persistDraft'));
        }
      })();
    });
    return unsub;
  }, [
    navigation,
    phase,
    dest,
    drafts,
    dc,
    persistDraftsToInbox,
    t.couldNotSave,
    t.voice.draftNeedsAmounts,
  ]);

  // On opening the review, read the current location once and pin the batch to
  // it — so the map shows and the place is saved by default, no tap needed. It
  // asks for permission just-in-time; a refusal or an unavailable fix leaves the
  // field on its manual "Add location" / "Pick on map" buttons rather than
  // failing loudly. Never overrides a pin the reader has since set or cleared:
  // the latch runs it exactly once per parsed batch.
  useEffect(() => {
    if (phase !== 'review' || autoLocated.current) return;
    autoLocated.current = true;
    if (!locationAvailable()) return;
    const gen = locationGen.current;
    void (async () => {
      const result = await captureLocation();
      if (!result.ok) return;
      // Drop a fix that lost its race: the reader has since set or cleared the
      // pin by hand, or a fresh utterance moved on to a new batch.
      if (locationGen.current !== gen || locationTouched.current) return;
      setLocation(result.location);
    })();
  }, [phase]);

  const save = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const date = today();
      const fallback = t.voice.anExpense;

      if (dest.kind === 'unassigned') {
        // No group chosen: keep the batch as a draft in the capture inbox.
        await persistDraftsToInbox();
        committed.current = true;
        router.replace('/captures');
        return;
      }

      // A group destination. Make the group first if it is a new one — its id
      // and the reader's member id were chosen up front, so an expense can name
      // them in the same breath (the offline-first pattern used elsewhere). The
      // ref guards a second create on a retry: the group exists after the first.
      if ((dest.kind === 'create' || dest.kind === 'person') && !groupCreated.current) {
        await createGroup.mutateAsync({
          groupId: dest.groupId,
          creatorMemberId: dest.memberId,
          name: dest.name,
          type: GroupType.Other,
          currency: dc,
        });
        groupCreated.current = true;
      }

      // A brand-new person needs a ghost to be the other half of the 1:1 —
      // minted once, reused on a retry so a partial failure adds no second one.
      if (dest.kind === 'person' && !ghostMemberId.current) {
        ghostMemberId.current = await addGhost.mutateAsync(dest.name);
      }

      const groupCurrency =
        dest.kind === 'existing' ? (target.group.data?.default_currency ?? dc) : dc;
      const participants =
        dest.kind === 'existing'
          ? (target.members.data ?? []).map((member) => member.id)
          : dest.kind === 'person'
            ? [dest.memberId, ghostMemberId.current!]
            : [dest.memberId];
      const payer =
        dest.kind === 'existing'
          ? ((target.members.data ?? []).find((member) => member.profile_id === profile?.id)?.id ??
            participants[0])
          : dest.memberId;

      if (participants.length === 0 || !payer) throw new Error('no members to split among');

      for (const draft of drafts) {
        const amount = toMinor(draft.amount, groupCurrency);
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
          location,
        });
      }
      committed.current = true;
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
    drafts.length > 0 &&
    !saving &&
    drafts.every((draft) => toMinor(draft.amount, draft.currency ?? dc) !== null);

  // The footer total must read in the same currency the Save will persist, or
  // it lies about what lands. A group save writes every expense in the group's
  // own currency (see `save`), so the footer totals in that one currency too;
  // the unassigned inbox keeps each capture's spoken currency, so there the
  // total is per-currency and a mixed batch shows its count instead — there is
  // no total across currencies (ADR-004).
  const destCurrency =
    dest.kind === 'unassigned'
      ? null
      : dest.kind === 'existing'
        ? (target.group.data?.default_currency ?? dc)
        : dc;
  const draftTotals = new Map<string, bigint>();
  for (const draft of drafts) {
    const currency = destCurrency ?? draft.currency ?? dc;
    const minor = toMinor(draft.amount, currency);
    if (minor === null) continue;
    draftTotals.set(currency, (draftTotals.get(currency) ?? 0n) + minor);
  }
  const singleTotal = draftTotals.size === 1 ? [...draftTotals.entries()][0] : null;

  const current = describeDest(dest, groupRows, t);

  // With no group chosen the batch is a draft (it lands in the capture inbox),
  // so the button says so; once a group is picked it writes real expenses and
  // the label counts them.
  const isDraft = dest.kind === 'unassigned';
  const saveLabel = isDraft ? t.voice.saveDraft : plural(locale, drafts.length, t.voice.save);

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
          {/* The heading wears a receipt glyph in ink — the review is an expense
              draft to check over, not the mic that started it. */}
          <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
            <Ionicons name="receipt-outline" size={iconSize.lg} color={theme.color.buttonPrimary} />
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
            {/* The expenses are the hero, laid out the way the Activity feed
                lays out its events: a soft tinted rounded-square node on the
                left, the line beside it, hairlines between rows in one grouped
                card — not a stack of separate cards. The tint is `sky`, the same
                the feed gives a newly-added expense, so a draft here reads as the
                same thing it will become once saved. */}
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
                {t.voice.review.toUpperCase()}
              </Text>
              <Card padded={false} flat style={{ overflow: 'hidden' }}>
                {drafts.map((draft, index) => (
                  <View key={draft.key}>
                    <DraftRow
                      draft={draft}
                      onEdit={editDraft}
                      onRemove={removeDraft}
                      removeLabel={t.captures.delete}
                      amountLabel={t.captures.amount}
                      noteLabel={t.captures.description}
                      notePlaceholder={t.captures.descriptionPlaceholder}
                      theme={theme}
                    />
                    {index < drafts.length - 1 ? <Divider /> : null}
                  </View>
                ))}
              </Card>
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
                      backgroundColor: theme.color.buttonPrimary,
                    }}
                  >
                    {current.emoji ? (
                      <Text style={{ fontSize: 18 }}>{current.emoji}</Text>
                    ) : (
                      <Ionicons
                        name={current.icon}
                        size={iconSize.md}
                        color={theme.color.onBrand}
                      />
                    )}
                  </View>
                  <Text numberOfLines={1} style={{ flex: 1, color: theme.color.text }}>
                    {current.label}
                  </Text>
                  <Ionicons name="chevron-down" size={iconSize.md} color={theme.color.textMuted} />
                </Pressable>
              </Card>
            </View>

            {/* One place for the whole batch (A43) — opt-in, never a background
                track. It rides onto every expense saved from this review. */}
            <LocationField value={location} onChange={handleLocationChange} />
          </View>
        ) : (
          // Listening — the mic panel owns the whole capture surface, the miss
          // included. A heard-but-amountless try comes back as `missed`; the mic
          // is the retry, and tapping it (via `onListen`) clears the miss. No
          // warning banner and no separate button stacked around it.
          <View style={{ gap: theme.spacing.lg, paddingTop: theme.spacing.xxl }}>
            <VoiceMicPanel
              key={attempt}
              onDone={handleTranscript}
              hints={hints}
              missed={noAmount}
              autoStart={!noAmount}
              onListen={() => setNoAmount(false)}
            />
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
          <Button label={saveLabel} onPress={() => void save()} disabled={!canSave} />
        </View>
      ) : null}

      {/* The destination picker, as a dismissible bottom sheet, matching the
          overflow menu. */}
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
              // Never taller than most of the screen: a long group list scrolls
              // inside the sheet rather than pushing the rows off the top.
              maxHeight: '80%',
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
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <DestinationPicker
                dest={dest}
                requested={requested}
                onChoose={(next) => {
                  // A change of destination is a change of group/ghost to make,
                  // so drop the once-only latches for the new one.
                  groupCreated.current = false;
                  ghostMemberId.current = null;
                  setDest(next);
                  setPickerOpen(false);
                }}
                onAddPerson={(name) => {
                  groupCreated.current = false;
                  ghostMemberId.current = null;
                  setDest({
                    kind: 'person',
                    groupId: randomUUID(),
                    memberId: randomUUID(),
                    name,
                  });
                  setPickerOpen(false);
                }}
                people={peopleChoices}
                groups={groupRows}
                t={t}
                theme={theme}
              />
            </ScrollView>
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
  if (dest.kind === 'person') {
    return { label: dest.name, icon: 'person-outline' };
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
  [GroupType.Friends]: 'people-circle',
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
  onAddPerson,
  people,
  groups,
  t,
  theme,
}: {
  dest: Dest;
  requested: { groupId: string; memberId: string; name: string } | null;
  onChoose: (dest: Dest) => void;
  onAddPerson: (name: string) => void;
  people: PersonChoice[];
  groups: GroupRow[];
  t: ReturnType<typeof useStrings>['t'];
  theme: ReturnType<typeof useTheme>;
}) {
  // The name typed into the "add a person" row — a brand-new individual, no
  // group needed up front.
  const [newName, setNewName] = useState('');
  const addNewPerson = (): void => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNewName('');
    onAddPerson(trimmed);
  };
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

  // People: existing friends by name, each reusing their 1:1 group. A person the
  // reader has just added by name (a `person` dest, no group yet) rides at the
  // top as the selected row so the choice reads back.
  const peopleRows: Row[] = people.map((person) => ({
    key: `person-${person.groupId}`,
    label: person.name,
    icon: 'person-outline',
    selected: dest.kind === 'existing' && dest.groupId === person.groupId,
    onPress: () => onChoose({ kind: 'existing', groupId: person.groupId }),
  }));
  if (dest.kind === 'person') {
    peopleRows.unshift({
      key: 'person-new',
      label: dest.name,
      icon: 'person-outline',
      selected: true,
      onPress: () => {},
    });
  }

  const renderRow = (row: Row, showDivider: boolean): React.JSX.Element => (
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
      {showDivider ? <Divider /> : null}
    </View>
  );

  return (
    <View style={{ gap: theme.spacing.lg }}>
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
          {t.voice.saveTo.toUpperCase()}
        </Text>
        {/* One grouped card, hairlines between rows — the destination is a single
            choice, so it reads as a single control (Expensify "To", Monzo lists)
            rather than a stack of floating pills. Selection is a leading glyph
            that lights to brand plus a filled radio, not a full-width purple fill. */}
        <Card padded={false} flat style={{ overflow: 'hidden' }}>
          {rows.map((row, index) => renderRow(row, index < rows.length - 1))}
        </Card>
      </View>

      {/* People: assign to an individual instead of a group. Existing friends by
          name (reusing their 1:1 group), plus a row to add someone new by name —
          which makes the 1:1 group and the ghost on save. */}
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
          {t.voice.people.toUpperCase()}
        </Text>
        <Card padded={false} flat style={{ overflow: 'hidden' }}>
          {peopleRows.map((row) => renderRow(row, true))}
          {/* Add a new person by name — a 1:1 IOU without leaving the review. */}
          <Row
            style={{
              gap: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.lg,
              alignItems: 'center',
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.color.surfaceMuted,
              }}
            >
              <Ionicons
                name="person-add-outline"
                size={iconSize.md}
                color={theme.color.textMuted}
              />
            </View>
            <TextInput
              value={newName}
              onChangeText={setNewName}
              placeholder={t.voice.addPersonPlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.voice.addPerson}
              onSubmitEditing={addNewPerson}
              returnKeyType="done"
              style={{ flex: 1, fontSize: 15, color: theme.color.text, paddingVertical: 0 }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.voice.addPerson}
              disabled={!newName.trim()}
              onPress={addNewPerson}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed || !newName.trim() ? 0.4 : 1 })}
            >
              <Ionicons name="add-circle" size={iconSize.lg} color={theme.color.brand} />
            </Pressable>
          </Row>
        </Card>
      </View>
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
  // The Activity feed's row shape: a soft rounded-square tile (radius md, not a
  // full circle) in the `sky` tint the feed gives an added expense, the line
  // beside it, a quiet trailing control. Here the line is editable — the amount
  // is the hero with its currency, the note the muted line beneath — but the
  // frame is the feed's, so review and activity read as one design.
  const tile = theme.tint.sky;
  return (
    <Row
      style={{
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: theme.radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tile.bg,
        }}
      >
        <Ionicons name="receipt-outline" size={iconSize.lg} color={tile.ink} />
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
  );
}
