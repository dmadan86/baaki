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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  computeShares,
  guessCategory,
  minorUnitScale,
  type ExpenseLocation,
  type SplitParams,
} from '@waves/core';
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
  SegmentedTabs,
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
import { displayName, groupLabel, GroupType, type GroupRow } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useDefaultCurrency } from '@/lib/currency';
import { aiEnabled, useAiAccess } from '@/lib/aiAccess';
import { friendlyError } from '@/lib/errors';
import { VoiceMicPanel } from '@/components/VoiceMicPanel';
import { LocationField } from '@/components/LocationField';
import {
  parseVoiceExpenses,
  resolveVoiceParticipants,
  type VoiceGroupRef,
  type VoiceParseResult,
} from '@/lib/voiceExpense';
import { interpretVoiceExpenses } from '@/lib/voiceLlm';
import { logVoiceAttempt } from '@/lib/voiceLog';

/** One editable line on the review screen. */
interface Draft {
  key: string;
  amount: string;
  note: string;
  currency: string | null;
  category: string | null;
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

/**
 * What a returning transcript does — the full-screen mic is reused for two jobs,
 * and the job is fixed the moment the mic is opened, not read off the transcript.
 *  - 'replace'   the opening capture: the heard batch becomes the review list.
 *  - 'append'    "+ Add another": the heard expenses are pushed onto the current
 *                list, keeping the existing items and the chosen destination.
 *
 * There is no third mode: the full-screen mic is the only way to speak an
 * expense here. A row's note is corrected by typing, not dictation — the whole
 * screen is already voice, so a mic in every row was clutter doing an unclear
 * job, and it is gone.
 */
type MicMode = 'replace' | 'append';

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
  // What the next transcript does — set the moment the mic is opened (opening
  // capture, "add more", or a single row's re-dictation), read when it returns.
  const [micMode, setMicMode] = useState<MicMode>('replace');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [voicePeopleText, setVoicePeopleText] = useState<string | null>(null);
  const [voiceSplitCount, setVoiceSplitCount] = useState<number | null>(null);
  const [voiceExpenseDate, setVoiceExpenseDate] = useState<string | null>(null);
  // One place for the whole spoken batch — a run of "coffee, then the taxi" all
  // happened where you are standing (A43). Strictly opt-in: null until the reader
  // taps "Add location" on the review. Nothing is read in the background — a
  // spoken expense is about money, not place, so the pin is only ever the
  // reader's own deliberate tap (the roast's ask, and A43's stated intent).
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
  // One interpretation at a time. Bumped when a capture is sent to be read, and
  // again the moment the reader backs out of the 'thinking' phase — so a result
  // that lands after they have returned to the review (a cancelled append) is
  // dropped rather than mutating the batch they went back to.
  const interpretToken = useRef(0);
  // True only while a mic capture the reader actually started is live. The mic's
  // `abort()` on unmount (a dismiss, or the switch back to the review) fires a
  // final `end` that calls `onDone` with the last transcript — so a dismissed
  // capture would otherwise still append its words to a row or replace the batch.
  // Set on every real listen start (via `onListen`), cleared on dismiss and the
  // moment a transcript is consumed, so a post-dismiss `onDone` is ignored.
  const captureActive = useRef(false);

  const navigation = useNavigation();

  const groupRows = useMemo(() => groups.data ?? [], [groups.data]);
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
        category: item.category,
      })),
    );
    setVoicePeopleText(result.peopleText);
    setVoiceSplitCount(result.splitCount);
    setVoiceExpenseDate(result.expenseDate);
    // A fresh parse is a fresh group to create, and a cleared location pin.
    groupCreated.current = false;
    ghostMemberId.current = null;
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

  // The heard batch, read the same way whichever job it is for: with a key the
  // model reads it (several expenses, other languages, a spoken new group); with
  // none, or on a failure, the pure heuristic takes over.
  const interpret = useCallback(
    async (transcript: string): Promise<VoiceParseResult> => {
      let result: VoiceParseResult | null = null;
      if (aiEnabled(access)) {
        result = await interpretVoiceExpenses(transcript, {
          groups: groupRefs,
          locale,
          defaultCurrency: dc,
        }).catch(() => null);
      }
      const final = result ?? parseVoiceExpenses(transcript, groupRefs);
      // Report what was heard when nothing usable came back, so the parser can be
      // improved against a real miss. Best-effort: the lib decides whether to send
      // (only failures, only with consent) and never throws — see lib/voiceLog.
      void logVoiceAttempt({
        transcript,
        itemCount: final.items.length,
        usedModel: result !== null,
        locale,
      });
      return final;
    },
    [access, groupRefs, locale, dc],
  );

  // Drafts minted from heard expenses — the shared shape for the opening batch
  // and the appended ones, so an added expense reads and saves exactly like an
  // original (same category-less default, same batch folding at save time).
  const toDrafts = (result: VoiceParseResult): Draft[] =>
    result.items.map((item) => ({
      key: randomUUID(),
      amount: String(item.amountMajor),
      note: item.note,
      currency: item.currency,
      category: item.category,
    }));

  const editDraft = (key: string, patch: Partial<Draft>): void => {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
    );
  };
  const removeDraft = (key: string): void => {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
  };

  // "+ Add more": the heard expenses are pushed onto the current list, keeping
  // every existing row and the chosen destination. A miss (nothing with an
  // amount) drops back to the mic in the same append mode, so the retry still
  // appends rather than silently replacing the batch.
  const appendResult = (result: VoiceParseResult): void => {
    if (result.items.length === 0) {
      setNoAmount(true);
      setAttempt((current) => current + 1);
      setPhase('listening');
      return;
    }
    setDrafts((current) => [...current, ...toDrafts(result)]);
    if (result.peopleText) setVoicePeopleText(result.peopleText);
    if (result.splitCount !== null) setVoiceSplitCount(result.splitCount);
    if (result.expenseDate) setVoiceExpenseDate(result.expenseDate);
    setNoAmount(false);
    setMicMode('replace');
    setPhase('review');
  };

  const handleTranscript = (transcript: string): void => {
    // Ignore a callback from a capture the reader has already dismissed: the
    // mic's abort-on-unmount emits a final `end` → `onDone`, and without this a
    // stale transcript would land after the dismiss. Consuming one live capture
    // also clears the flag, so a second `end` from the same abort cannot
    // double-apply.
    if (!captureActive.current) return;
    captureActive.current = false;
    const mode = micMode;
    setPhase('thinking');
    const token = (interpretToken.current += 1);
    void (async () => {
      const parsed = await interpret(transcript);
      // Dropped if the reader has since backed out of 'thinking' (which bumps the
      // token), or a newer capture superseded this one — a late append must not
      // land on the review they returned to.
      if (interpretToken.current !== token) return;
      if (mode === 'append') appendResult(parsed);
      else applyResult(parsed);
    })();
  };

  // "+ Add another" — reopen the mic to speak another expense (or several). The
  // returning batch is appended, not replaced; the destination is untouched.
  const startAddMore = (): void => {
    setMicMode('append');
    setNoAmount(false);
    setAttempt((current) => current + 1);
    setPhase('listening');
  };

  // The ✕. An "add more" sub-capture opened over a review that already has a
  // batch — backing out of it returns to the review with the batch intact,
  // rather than leaving the screen. Otherwise it leaves as before (the
  // leave-guard below still files an unassigned batch as a draft on the way).
  const dismiss = (): void => {
    // Abandon any live capture: the mic's abort-on-unmount will fire a final
    // `onDone`, and this flag makes handleTranscript drop it.
    captureActive.current = false;
    // A sub-capture over an existing batch — the mic (listening) or its pending
    // interpretation (thinking). Either way, back out to the review with the
    // batch intact and cancel any interpretation still in flight, rather than
    // leaving the screen. The opening capture (no batch yet) leaves as before.
    if ((phase === 'listening' || phase === 'thinking') && drafts.length > 0) {
      interpretToken.current += 1;
      setNoAmount(false);
      setMicMode('replace');
      setPhase('review');
      return;
    }
    router.back();
  };

  // Write the heard expenses into the capture inbox — the app's draft holding
  // area. Each draft's own id is the capture id, so a retry (or the leave-guard
  // firing after a Save that half-finished) re-uses it rather than minting a
  // duplicate. Shared by the "Save as draft" button and the close-intercept, so
  // the two land the same rows.
  const persistDraftsToInbox = useCallback(async (): Promise<void> => {
    const date = voiceExpenseDate ?? today();
    const fallback = t.voice.anExpense;
    // Several expenses spoken in one breath stay one thing in the inbox: they
    // share a batch id (carried in the capture's `parsed`, so no schema change),
    // and the inbox folds them into one collapsible total. A lone capture gets
    // none — there is nothing to group.
    const batchId = drafts.length > 1 ? randomUUID() : null;
    for (const draft of drafts) {
      const currency = draft.currency ?? dc;
      const amount = toMinor(draft.amount, currency);
      if (amount === null) continue;
      // Give the draft a guessed category from its description, the same read the
      // typed capture and add-expense forms do — so a voiced expense lands with a
      // sensible bucket rather than uncategorised. Null (unrecognised text) is fine.
      const description = draft.note.trim() || fallback;
      await createCapture.mutateAsync({
        captureId: draft.key,
        description,
        category: draft.category ?? guessCategory(description),
        expenseDate: date,
        currency,
        amount,
        location,
        parsed: batchId ? { voiceBatchId: batchId } : undefined,
      });
    }
  }, [drafts, dc, location, voiceExpenseDate, t.voice.anExpense, createCapture]);

  // Leaving the review with a draft batch and no group chosen must not throw the
  // expenses away — an unassigned batch is a draft, and a draft survives a close
  // (the user's rule). So intercept every way off the screen (the ✕, the OS back
  // gesture, the hardware back key) and file the batch in the inbox first. A
  // group destination is left to the explicit Save; closing it discards, as
  // before. `committed` stands the guard down once a Save is already navigating.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (event) => {
      if (committed.current) return;
      // Backing out of an "add more" sub-capture — the OS back gesture or
      // hardware key, not only the ✕ — returns to the review with the
      // batch intact, whether the mic is still listening or its interpretation is
      // pending ('thinking'). A late interpretation is cancelled with the token.
      if ((phase === 'listening' || phase === 'thinking') && drafts.length > 0) {
        event.preventDefault();
        captureActive.current = false;
        interpretToken.current += 1;
        setNoAmount(false);
        setMicMode('replace');
        setPhase('review');
        return;
      }
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

  const save = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const date = voiceExpenseDate ?? today();
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
      const groupMembers = target.members.data ?? [];
      const payer =
        dest.kind === 'existing'
          ? (groupMembers.find((member) => member.profile_id === profile?.id)?.id ??
            groupMembers[0]?.id)
          : dest.memberId;
      if (!payer) throw new Error('no members to split among');
      const participants =
        dest.kind === 'existing'
          ? resolveVoiceParticipants({
              all: groupMembers.map((member) => member.id),
              payer,
              members: groupMembers.map((member) => ({
                id: member.id,
                name: displayName(member, profile?.id),
              })),
              peopleText: voicePeopleText,
              splitCount: voiceSplitCount,
            })
          : dest.kind === 'person'
            ? [dest.memberId, ghostMemberId.current!]
            : [dest.memberId];

      if (participants.length === 0) throw new Error('no members to split among');

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
        // Same category guess as the inbox path: a voiced expense carries a bucket
        // read from its description, which the reader can still change afterwards.
        const description = draft.note.trim() || fallback;
        await writeExpense.mutateAsync({
          expenseId,
          description,
          category: draft.category ?? guessCategory(description),
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
          {/* The Activity screen's header shape — a left-aligned brand glyph and a
              big bold title — so the review reads as the same family of screen.
              Here the glyph is the mic that started the capture. */}
          <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
            <Ionicons name="mic" size={iconSize.xl} color={theme.color.brand} />
            <Text variant="title">{phase === 'review' ? t.voice.review : t.voice.title}</Text>
          </Row>
          {/* Just the ✕. Speaking another expense is one job with one home — the
              "+ Add another" pill under the list — so the header carries no second
              mic competing with it. */}
          <IconButton label={t.common.close} onPress={dismiss}>
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
            {/* Confirmation, not an edit form. Each expense reads as a quiet
                summary line — what we heard, and the amount — inside one grouped
                card, the way a receipt lists what it charged. Tapping a line opens
                it to correct the amount or the note; it is closed again by
                default. The parser is not put on trial the moment you land here. */}
            <Card padded={false} style={{ overflow: 'hidden' }}>
              {drafts.map((draft, index) => (
                <View key={draft.key}>
                  {index > 0 ? <Divider /> : null}
                  <DraftRow
                    draft={draft}
                    // The currency the row shows must be the one Save will persist:
                    // a group destination writes in the group's currency, so a USD
                    // draft dropped into an EUR group reads EUR here, matching the
                    // footer total and the saved expense. The inbox (no group)
                    // keeps the draft's own spoken currency.
                    currency={destCurrency ?? draft.currency ?? dc}
                    onEdit={editDraft}
                    onRemove={removeDraft}
                    fallbackNote={t.voice.anExpense}
                    editLabel={t.common.edit}
                    doneLabel={t.common.done}
                    removeLabel={t.captures.delete}
                    amountLabel={t.captures.amount}
                    noteLabel={t.captures.description}
                    notePlaceholder={t.captures.descriptionPlaceholder}
                    theme={theme}
                  />
                </View>
              ))}
            </Card>

            {/* Speak again and append — another expense (or several) onto the
                batch, keeping the ones already here and the chosen destination.
                The one and only "add another"; the header carries no rival mic. */}
            <Pressable
              onPress={startAddMore}
              accessibilityRole="button"
              accessibilityLabel={t.voice.addMore}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.spacing.xs,
                paddingVertical: theme.spacing.md,
                borderRadius: theme.radius.lg,
                borderWidth: 1,
                borderColor: theme.color.brand,
                borderStyle: 'dashed',
                backgroundColor: theme.color.brandSoft,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Ionicons name="mic-outline" size={iconSize.md} color={theme.color.brand} />
              <Text variant="caption" style={{ color: theme.color.brand, fontWeight: '600' }}>
                {t.voice.addMore}
              </Text>
            </Pressable>

            {/* One opinionated destination row: "Save to <where>" with a single
                Change. No chips, no badges, no tabs out here — the taxonomy of
                groups and people only appears once the reader taps Change and the
                picker sheet opens. The answer to "where does this go?" is one
                line, not a wall. */}
            <Card padded={false} style={{ overflow: 'hidden' }}>
              <Pressable
                onPress={() => setPickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`${t.voice.saveTo}: ${current.label}. ${t.voice.change}`}
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
                    <Ionicons name={current.icon} size={iconSize.md} color={theme.color.onBrand} />
                  )}
                </View>
                <View style={{ flex: 1, gap: 1 }}>
                  <Text variant="micro" tone="faint" style={{ letterSpacing: 0.6 }}>
                    {t.voice.saveTo.toUpperCase()}
                  </Text>
                  <Text numberOfLines={1} style={{ color: theme.color.text, fontWeight: '600' }}>
                    {current.label}
                  </Text>
                </View>
                <Text variant="caption" style={{ color: theme.color.brand, fontWeight: '600' }}>
                  {t.voice.change}
                </Text>
              </Pressable>
            </Card>

            {/* One place for the whole batch (A43) — strictly opt-in, read only
                when the reader taps it, never in the background. It rides onto
                every expense saved from this review. */}
            <LocationField value={location} onChange={setLocation} />
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
              onListen={() => {
                // A capture the reader actually started — mark it live so its
                // transcript is accepted (and a dismissed one's is not).
                captureActive.current = true;
                setNoAmount(false);
              }}
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
          {/* Quiet running total on the left — the count when a mixed-currency
              batch has no single sum. No check, no ledger flourish; the Save
              button is the confirmation. */}
          <View style={{ gap: 1 }}>
            {drafts.length > 1 ? (
              <Text variant="micro" tone="muted">
                {plural(locale, drafts.length, t.voice.count)}
              </Text>
            ) : null}
            {singleTotal ? (
              <MoneyText
                amount={singleTotal[1]}
                currency={singleTotal[0]}
                locale={locale}
                mode="plain"
                variant="subheading"
              />
            ) : (
              <Text variant="subheading">{plural(locale, drafts.length, t.voice.count)}</Text>
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

type PickerRow = {
  key: string;
  label: string;
  // A row wears either the group's own cover emoji or, lacking one, an Ionicon
  // — the inbox and "new group" rows only ever use an icon.
  icon: React.ComponentProps<typeof Ionicons>['name'];
  emoji?: string | null;
  selected: boolean;
  onPress: () => void;
};

/**
 * The one choice a Save needs: where the expenses land. Split into two tabs —
 * Groups and People — under a pinned "Unassigned" default, because a flat list of
 * groups then people grew long enough to bury one under the other. No recency or
 * frequency badges: they made the reader read the row twice; the plain name is the
 * signal. The selected row carries a check.
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
  // Open on whichever tab the current destination lives in, so the choice reads
  // back; a fresh review with no destination opens on Groups.
  const [tab, setTab] = useState<'groups' | 'people'>(dest.kind === 'person' ? 'people' : 'groups');
  // The name typed into the "add a person" row — a brand-new individual, no
  // group needed up front.
  const [newName, setNewName] = useState('');
  const addNewPerson = (): void => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setNewName('');
    onAddPerson(trimmed);
  };

  // Always-present default: the capture inbox, pinned above the tabs. It is
  // neither a group nor a person, and it is where a Save with no destination
  // lands, so it stays in view whichever tab is open.
  const unassignedRow: PickerRow = {
    key: 'unassigned',
    label: t.captures.unassigned,
    // The inbox row wears the dashboard's captures glyph, so "Unassigned" here
    // and the captures card on Home read as the same place.
    icon: 'file-tray-full-outline',
    selected: dest.kind === 'unassigned',
    onPress: () => onChoose({ kind: 'unassigned' }),
  };

  const groupRows: PickerRow[] = [];
  // Driven by the persisted request, not the current destination, so the "new
  // group" row stays offered after the reader switches to the inbox or a group.
  if (requested) {
    groupRows.push({
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
  // A person's 1:1 group is their row on the People tab, not a group in its own
  // right — showing it in both tabs lists the same conversation twice. So the
  // groups the People tab already represents are dropped here.
  const personGroupIds = new Set(people.map((person) => person.groupId));
  const sorted = [...groups]
    .filter((group) => !personGroupIds.has(group.id))
    .sort((a, b) => {
      // Newest first by creation time; when two groups share a timestamp (made
      // in the same request), fall back to id so the order is stable across
      // renders rather than flipping on every re-sort.
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  for (const group of sorted) {
    groupRows.push({
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
  const peopleRows: PickerRow[] = people.map((person) => ({
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

  const renderRow = (row: PickerRow, showDivider: boolean): React.JSX.Element => (
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
      <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
        {t.voice.saveTo.toUpperCase()}
      </Text>

      {/* The default, pinned above the tabs — one grouped card, the same control
          shape the rest of the picker uses. */}
      <Card padded={false} flat style={{ overflow: 'hidden' }}>
        {renderRow(unassignedRow, false)}
      </Card>

      {/* Groups and People are their own tab: a flat list of every group then
          every person grew long enough to bury one under the other. */}
      <SegmentedTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'groups', label: t.voice.groupsTab },
          { value: 'people', label: t.voice.peopleTab },
        ]}
      />

      {tab === 'groups' ? (
        groupRows.length > 0 ? (
          <Card padded={false} flat style={{ overflow: 'hidden' }}>
            {groupRows.map((row, index) => renderRow(row, index < groupRows.length - 1))}
          </Card>
        ) : (
          <Text tone="muted" align="center" style={{ paddingVertical: theme.spacing.lg }}>
            {t.voice.noGroups}
          </Text>
        )
      ) : (
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
      )}
    </View>
  );
}

/**
 * One heard expense as a confirmation line, not an edit form. Closed, it reads
 * as a quiet row: what we heard on the left, the amount on the right, the way a
 * receipt lists a charge — a faint pencil the only hint it can be opened. Tapping
 * it (or its pencil) opens the amount and note to correct, and Done closes it
 * back to a line. Inline note dictation is gone: the whole screen is already
 * voice; a mic in every row was clutter doing an unclear job.
 *
 * No card of its own — the review stacks these inside one grouped card, divided
 * by hairlines, so several spoken expenses read as one list rather than a tower
 * of mini-forms.
 */
function DraftRow({
  draft,
  currency,
  onEdit,
  onRemove,
  fallbackNote,
  editLabel,
  doneLabel,
  removeLabel,
  amountLabel,
  noteLabel,
  notePlaceholder,
  theme,
}: {
  draft: Draft;
  /** The currency Save will persist this row in — the group's when a group is
   *  the destination, else the draft's own spoken currency (or the default). */
  currency: string;
  onEdit: (key: string, patch: Partial<Draft>) => void;
  onRemove: (key: string) => void;
  /** Shown as the row's title when the spoken note came back empty. */
  fallbackNote: string;
  editLabel: string;
  doneLabel: string;
  removeLabel: string;
  amountLabel: string;
  noteLabel: string;
  notePlaceholder: string;
  theme: ReturnType<typeof useTheme>;
}) {
  // Closed by default: you land on a confirmation, and only open a row if the
  // parser got something wrong. A fresh parse remounts every row (new keys), so
  // this resets to closed for each new batch.
  const [editing, setEditing] = useState(false);
  const tile = theme.tint.sky;
  const title = draft.note.trim() || fallbackNote;
  const amountText = draft.amount.trim();

  if (!editing) {
    return (
      <Pressable
        onPress={() => setEditing(true)}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${amountText} ${currency}. ${editLabel}`}
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
            borderRadius: theme.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tile.bg,
          }}
        >
          <Ionicons name="receipt-outline" size={iconSize.md} color={tile.ink} />
        </View>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.color.text }}>
          {title}
        </Text>
        <Text style={{ fontWeight: '700', color: theme.color.text }}>
          {amountText ? `${amountText} ${currency}` : currency}
        </Text>
        <Ionicons name="pencil" size={iconSize.sm} color={theme.color.textFaint} />
      </Pressable>
    );
  }

  // Opened for a correction: the amount is the one field worth making big, with
  // the currency as a chip and the note beneath. Done folds it back to a line.
  return (
    <View
      style={{
        gap: theme.spacing.sm,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
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
        <TextInput
          value={draft.amount}
          onChangeText={(value) => onEdit(draft.key, { amount: value })}
          keyboardType="decimal-pad"
          accessibilityLabel={amountLabel}
          autoFocus
          style={{
            flex: 1,
            fontSize: 26,
            fontWeight: '700',
            color: theme.color.text,
            paddingVertical: 0,
          }}
        />
        {currency ? (
          <View
            style={{
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: 4,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.color.surfaceMuted,
            }}
          >
            <Text variant="caption" tone="muted" style={{ fontWeight: '700' }}>
              {currency}
            </Text>
          </View>
        ) : null}
        <IconButton label={removeLabel} onPress={() => onRemove(draft.key)}>
          <Ionicons name="close" size={iconSize.md} color={theme.color.textFaint} />
        </IconButton>
      </Row>

      <Divider />

      <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Ionicons name="create-outline" size={iconSize.sm} color={theme.color.textFaint} />
        <TextInput
          value={draft.note}
          onChangeText={(value) => onEdit(draft.key, { note: value })}
          placeholder={notePlaceholder}
          placeholderTextColor={theme.color.textFaint}
          accessibilityLabel={noteLabel}
          style={{ flex: 1, fontSize: 15, color: theme.color.text, paddingVertical: 0 }}
        />
        <Pressable
          onPress={() => setEditing(false)}
          accessibilityRole="button"
          accessibilityLabel={doneLabel}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text variant="caption" style={{ color: theme.color.brand, fontWeight: '600' }}>
            {doneLabel}
          </Text>
        </Pressable>
      </Row>
    </View>
  );
}
