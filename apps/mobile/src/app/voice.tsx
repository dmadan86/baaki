/**
 * Speak an expense — one or several, in any language, with an optional new group.
 *
 * Reached from the raised mic. The phone turns speech into text on-device (see
 * VoiceMicPanel). What that text means is worked out by the pure
 * {@link parseVoiceExpenses} heuristic — amounts, currencies, a named group,
 * several expenses in a breath, a spoken "make a group called X", and a
 * "just for me" that routes to the personal ledger — all with no network and no
 * model.
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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  computeShares,
  encodeTxn,
  guessCategory,
  minorUnitScale,
  peopleSignatureKey,
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
  Text,
  useTheme,
} from '@waves/ui';

import {
  useAddGhostMember,
  useCreateCapture,
  useCreateGroup,
  useGroup,
  useGroupLedger,
  useGroupPeopleSignatures,
  useGroups,
  useOneToOneGroupIds,
  usePeopleBalances,
  useRecordSettlement,
  useWriteExpense,
} from '@/data/hooks';
import { nudgeToSettle } from '@/data/api';
import { useUpsertPersonalRecord } from '@/data/personal';
import { displayName, groupLabel, GroupType, isViewer, type GroupRow } from '@/data/types';
import { isRtl, plural, useStrings } from '@/i18n';
import { useViewerId } from '@/lib/auth';
import { useBottomClearance } from '@/lib/clearance';
import { useDefaultCurrency } from '@/lib/currency';
import { friendlyError } from '@/lib/errors';
import {
  DestinationPicker,
  GROUP_TYPE_ICON,
  type DestinationSelection,
  type PersonChoice,
} from '@/components/DestinationPicker';
import { VoiceMicPanel } from '@/components/VoiceMicPanel';
import { LocationField } from '@/components/LocationField';
import { CategoryBadge } from '@/components/Category';
import { captureLocation, locationAvailable } from '@/lib/location';
import { router } from '@/lib/navigation';
import { pushToTalk } from '@/lib/pushToTalk';
import { useToast } from '@/lib/toast';
import {
  detectAddMember,
  detectBalanceQuery,
  detectMoneyIntent,
  matchMemberNames,
  parseVoiceExpenses,
  resolveVoiceParticipants,
  toVoiceMinorUnits,
  voiceAutoAction,
  type VoiceGroupRef,
  type VoiceParseResult,
} from '@/lib/voiceExpense';
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
  // Just me: a private personal expense, no group and nobody to split with. Each
  // draft is written to the personal ledger (A48) as an expense txn.
  | { kind: 'me' }
  | { kind: 'existing'; groupId: string }
  | { kind: 'create'; groupId: string; memberId: string; name: string }
  // One or more people with no existing group between them — a fresh group made
  // on save, named after them the way WhatsApp names a new group, with a ghost
  // per person. One person is the 1:1 case; several is a real group. When those
  // same people already share a group, the picker resolves to `existing` instead
  // and this kind is never used. `groupId`/`memberId` (mine) are minted up front
  // so the create and the expense name them in the same offline batch.
  | {
      kind: 'people';
      groupId: string;
      memberId: string;
      name: string;
      ghostNames: string[];
    }
  // A spoken settle-up ("settle up with Ravi"): record a payment that clears the
  // 1:1 balance. `toMemberId` is the other person; my member id is read from the
  // group at save. `iPay` (I owe them) sets the direction; `amount` is the whole
  // balance, or a spoken partial. Not an expense — it rides the settlement path.
  | {
      kind: 'settle';
      groupId: string;
      toMemberId: string;
      amount: bigint;
      currency: string;
      iPay: boolean;
      name: string;
    }
  // A spoken reminder ("remind Ravi"): a nudge to settle. The server decides the
  // amount and wording and rate-limits it; the client sends only who and where.
  | { kind: 'remind'; groupId: string; toMemberId: string; currency: string; name: string }
  // A spoken "add Ravi to the latest group": one or more ghosts added to an
  // existing group by name. Not an expense — nothing is spent. Names already in
  // the group are skipped at save, so re-speaking adds no duplicate.
  | { kind: 'add-member'; groupId: string; names: string[]; groupName: string };

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
  // The one canonical foot. `Screen` below takes only the top edge, so nothing
  // else has added the bottom inset — this is where it comes from, once.
  const clearance = useBottomClearance();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // The keyboard's height, measured — used to lift the destination sheet above
  // it (a KeyboardAvoidingView does not resize inside an Android Modal).
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const { t, locale } = useStrings();

  // Identity for "which member am I", from the session rather than the profile:
  // the session is on the device at launch, the profile is a fetch that lands
  // later, and in the gap `profile?.id` is undefined — which `isViewer` refuses
  // to match, but only if it is given the right thing to compare. See
  // `lib/auth.useViewerId`.
  const viewerId = useViewerId();
  const dc = useDefaultCurrency();
  // "That worked", said over whichever screen the save leaves you on — see the
  // note on the landings in `save` below.
  const toast = useToast();
  const groups = useGroups();
  // Opened from a group's own screens (the raised mic passes its id), so a
  // spoken expense lands in that group by default rather than the unassigned
  // inbox. The reader can still switch the destination on the review; and a
  // sentence that names a different group ("…for the Goa trip") still wins.
  const params = useLocalSearchParams<{ group?: string; heard?: string; hn?: string }>();
  const launchGroupId = typeof params.group === 'string' ? params.group : null;
  // A transcript captured by the home-screen voice widget's own recogniser and
  // handed in on the deep link — the mic already ran outside the app, so this
  // screen skips listening and goes straight to interpreting it (see the effect
  // below). `hn` is a per-tap nonce so a fresh widget capture re-runs on a warm
  // screen that already consumed an earlier one.
  const widgetHeard = typeof params.heard === 'string' ? params.heard.trim() : '';

  const createCapture = useCreateCapture();
  const createGroup = useCreateGroup();
  const upsertPersonal = useUpsertPersonalRecord();
  // "Who is in this" for every group I am in — used to tell whether a set of
  // selected people already share a group (assign to it) or not (make one).
  const signatures = useGroupPeopleSignatures(viewerId);
  // Existing people, by name, so a spoken expense can be pointed at an
  // individual — not only a group. Each is a pairwise balance the viewer has;
  // the ones explained by a single group (`only_group_id`) are their 1:1 group,
  // which the picker reuses. Computed from the mirror, so it works offline.
  const people = usePeopleBalances(viewerId);
  // Groups that are a true 1:1 (you + one other) — these are the People-tab
  // contacts, and the only groups the Groups tab hides. A multi-person group is
  // never treated as a person, even when it is your sole shared group with
  // someone, so it always stays listed under Groups.
  const oneToOne = useOneToOneGroupIds();
  const peopleChoices: PersonChoice[] = (() => {
    const byGroup = new Map<string, PersonChoice>();
    for (const row of people.data ?? []) {
      // A contact is a real 1:1 group, not merely the one group you happen to
      // share with them — otherwise a whole trip would masquerade as a person.
      if (!row.only_group_id || !oneToOne.data.has(row.only_group_id)) continue;
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
  // heard expenses, editable, awaiting a destination and a Save; 'committing' →
  // a confident command is writing itself after a short Undo window (see
  // {@link voiceAutoAction}), the banner counting down over the review; 'answer'
  // → a read-only balance question, its answer shown (nothing written).
  const [phase, setPhase] = useState<'listening' | 'thinking' | 'review' | 'committing' | 'answer'>(
    widgetHeard ? 'thinking' : 'listening',
  );
  // The answer shown in the 'answer' phase. `text` is a ready line (a person
  // balance, or "couldn't find X"); `group` is answered live from the group's
  // ledger once it loads, since that read is async.
  const [answer, setAnswer] = useState<
    { kind: 'text'; text: string } | { kind: 'group'; groupName: string; currency: string } | null
  >(null);
  // The group a balance question is about — read by the ledger hook below.
  const [queryGroupId, setQueryGroupId] = useState('');
  // The auto-act banner shown during 'committing': the line to read and whether
  // Undo drops to the review (a single expense to edit) or back to the mic (a
  // bare create-group, nothing to review). Cleared the moment the window ends.
  const [autoBanner, setAutoBanner] = useState<{
    label: string;
    fallback: 'review' | 'listening';
  } | null>(null);
  // What the next transcript does — set the moment the mic is opened (opening
  // capture, "add more", or a single row's re-dictation), read when it returns.
  const [micMode, setMicMode] = useState<MicMode>('replace');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [voicePeopleText, setVoicePeopleText] = useState<string | null>(null);
  const [voiceSplitCount, setVoiceSplitCount] = useState<number | null>(null);
  const [voiceExpenseDate, setVoiceExpenseDate] = useState<string | null>(null);
  // One place for the whole spoken batch — a run of "coffee, then the taxi" all
  // happened where you are standing (A43). The current place is read on its own
  // when the review opens and pinned by default; the reader can still clear or
  // move it. A spoken expense is nearly always logged on the spot, so filing it
  // there without a tap is the point.
  const [location, setLocation] = useState<ExpenseLocation | null>(null);
  // The up-front read of the current place is in flight — the field shows a
  // "getting location" state rather than empty buttons while it lands.
  const [locating, setLocating] = useState(false);
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
  // The ghosts for the brand-new people, minted once on the first save (one per
  // name) and reused on a retry, so a partial failure adds no second set. Reset
  // with a fresh parse or a change of destination.
  const ghostMemberIds = useRef<string[] | null>(null);
  // The pending auto-commit timer, so Undo (or a fresh parse, or unmount) can
  // cancel the write before it fires. Holds a real id only during 'committing'.
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest `save`, kept in a ref so the auto-commit timer runs the current
  // one — reading the destination and drafts as they stand when the window ends,
  // not as they were when the timer was armed.
  const commitRef = useRef<(() => Promise<void>) | null>(null);
  // A Save (or a close that persists the batch as a draft) has already taken
  // over navigation — so the leave-guard below stands aside instead of writing
  // the captures a second time.
  const committed = useRef(false);
  // The review reads the current location once per batch and pins it. Latched so
  // the read fires once (not on every render, and not again after the reader
  // clears or moves the pin); reset when a fresh parse opens a new review.
  const autoLocated = useRef(false);
  // Guards the async read from clobbering a later truth. `locationGen` ticks once
  // per parsed batch, so a fix arriving after a new utterance is dropped;
  // `locationTouched` flips the moment the reader sets or clears the pin by hand,
  // so an in-flight read never overrides their choice.
  const locationGen = useRef(0);
  const locationTouched = useRef(false);
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
  // id (the unassigned/create cases) reads nothing, which is what we want. A
  // settle also needs the group's members — my own member id is read from them.
  const targetGroupId =
    dest.kind === 'existing' || dest.kind === 'settle' || dest.kind === 'add-member'
      ? dest.groupId
      : '';
  const target = useGroup(targetGroupId);
  // Only the group destinations carry a group id to write into; unassigned and
  // "just me" have none, so the write hook reads the empty id and stays inert.
  const writeGroupId =
    dest.kind === 'existing' || dest.kind === 'create' || dest.kind === 'people'
      ? dest.groupId
      : '';
  const writeExpense = useWriteExpense(writeGroupId);
  // Bound to the new people's minted group id (a `people` batch) or the target
  // of a spoken "add Ravi to …"; inert (empty id) in every other case.
  const addGhost = useAddGhostMember(
    dest.kind === 'people' || dest.kind === 'add-member' ? dest.groupId : '',
  );
  // A spoken settle-up records against the person's 1:1 group; inert otherwise.
  const recordSettlement = useRecordSettlement(dest.kind === 'settle' ? dest.groupId : '');
  // The ledger behind a spoken "what's my balance in <group>". Empty id (no such
  // question pending) reads nothing, so it stays inert until one is asked.
  const queryLedger = useGroupLedger(queryGroupId, viewerId);

  // A confident command writes itself after this many ms, unless Undo is tapped.
  const AUTO_COMMIT_MS = 4000;

  // Arm the auto-act window: show the banner, hold in 'committing', and fire the
  // current `save` when it elapses. A fresh parse, Undo, or unmount cancels it.
  const beginAutoCommit = (banner: { label: string; fallback: 'review' | 'listening' }): void => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    setNoAmount(false);
    setAutoBanner(banner);
    setPhase('committing');
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      setAutoBanner(null);
      void (async () => {
        await commitRef.current?.();
        // save() navigates on success (committed=true). If it failed it set an
        // error and left us on the spinner — drop to the fallback so the error
        // is readable: the review (a batch to retry) or the mic (nothing to).
        if (committed.current) return;
        if (banner.fallback === 'listening') {
          setRequested(null);
          setDest({ kind: 'unassigned' });
          setDrafts([]);
          setPhase('listening');
        } else {
          setPhase('review');
        }
      })();
    }, AUTO_COMMIT_MS);
  };

  // Undo the pending write. A single expense drops to the review so it can be
  // edited and saved by hand; a bare create-group has nothing to review, so it
  // goes back to the mic with the minted group discarded.
  const cancelAutoCommit = (): void => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = null;
    const fallback = autoBanner?.fallback ?? 'review';
    setAutoBanner(null);
    if (fallback === 'listening') {
      setRequested(null);
      setDest({ kind: 'unassigned' });
      setDrafts([]);
      setPhase('listening');
    } else {
      setPhase('review');
    }
  };

  // Reset the per-parse bookkeeping — a fresh parse is a fresh group to create,
  // fresh ghosts to mint, and a fresh location to read.
  const resetForNewParse = (): void => {
    groupCreated.current = false;
    ghostMemberIds.current = null;
    autoLocated.current = false;
    locationGen.current += 1;
    locationTouched.current = false;
    setLocation(null);
  };

  const applyResult = (result: VoiceParseResult): void => {
    const auto = voiceAutoAction(result);

    // A bare "make a group called X" carries no amount, so it would trip the
    // no-amount guard below. Handle it first: mint the group and auto-create it
    // after the Undo window, with no expense to write and nothing to review.
    if (auto?.kind === 'create-group') {
      const created = { groupId: randomUUID(), memberId: randomUUID(), name: auto.name };
      resetForNewParse();
      setDrafts([]);
      setVoicePeopleText(null);
      setVoiceSplitCount(null);
      setVoiceExpenseDate(null);
      setRequested(created);
      setDest({ kind: 'create', ...created });
      beginAutoCommit({
        label: t.voice.autoCreating.replace('{name}', auto.name),
        fallback: 'listening',
      });
      return;
    }

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
    resetForNewParse();
    // Default the destination to what was heard: a new group to make, an
    // existing group named, else the capture inbox.
    if (result.group?.kind === 'create') {
      const created = { groupId: randomUUID(), memberId: randomUUID(), name: result.group.name };
      setRequested(created);
      setDest({ kind: 'create', ...created });
    } else if (result.group?.kind === 'existing') {
      setRequested(null);
      setDest({ kind: 'existing', groupId: result.group.groupId });
    } else if (result.personal) {
      // "Just for me" — a private expense on the Me ledger. This beats the
      // launch-group context below: an explicit solo marker is a clear choice.
      setRequested(null);
      setDest({ kind: 'me' });
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

    // Confident single expense to an existing, named group — write it after a
    // short Undo window rather than asking for a tap that would only confirm the
    // group's own currency and an equal split (the defaults the review applies).
    // Only when the group has a name to show, so the banner can say where it
    // lands; an unnamed 1:1 falls to the review instead.
    if (auto?.kind === 'commit-expense') {
      const groupName = groupRows.find((group) => group.id === auto.groupId)?.name?.trim();
      if (groupName) {
        const item = result.items[0];
        const currency = item.currency ?? dc;
        beginAutoCommit({
          label: t.voice.autoAdding
            .replace('{amount}', `${item.amountMajor} ${currency}`)
            .replace('{group}', groupName),
          fallback: 'review',
        });
        return;
      }
    }

    setPhase('review');
  };

  // The heard batch, read by the pure heuristic — amounts, currencies, a named
  // group, several expenses in a breath, a spoken new group, "just for me".
  const interpret = useCallback(
    async (transcript: string): Promise<VoiceParseResult> => {
      const final = parseVoiceExpenses(transcript, groupRefs);
      // Report what was heard when nothing usable came back, so the parser can be
      // improved against a real miss. Best-effort: the lib decides whether to send
      // (only failures, only with consent) and never throws — see lib/voiceLog.
      void logVoiceAttempt({
        transcript,
        itemCount: final.items.length,
        usedModel: false,
        locale,
      });
      return final;
    },
    [groupRefs, locale],
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

  // A spoken money-movement command — "settle up with Ravi", "remind Priya" —
  // rather than an expense. Resolves the named person against the reader's 1:1
  // contacts and, when exactly one fits and the balance makes the action mean
  // something, arms the auto-act window for it. Returns true when it took the
  // command; false leaves the sentence to the ordinary expense parse. The one
  // thing that acts without a review is still cancellable for 4s (Undo), which
  // is what makes a money-out or an outward nudge safe to trigger by voice.
  const tryMoneyIntent = (transcript: string): boolean => {
    const intent = detectMoneyIntent(transcript);
    if (!intent) return false;

    // Only true 1:1 contacts can be settled or reminded — the same rows the
    // People picker offers. A name must match exactly one of them.
    const rows = (people.data ?? []).filter(
      (row) => row.only_group_id && oneToOne.data.has(row.only_group_id),
    );
    const contacts = [
      ...new Map(rows.map((row) => [row.person_key, row.display_name])).entries(),
    ].map(([id, name]) => ({ id, name }));
    const matched = matchMemberNames(intent.who, contacts);
    if (matched.length !== 1) return false;
    const personKey = matched[0];
    const personRows = rows.filter((row) => row.person_key === personKey);
    const name = personRows[0]?.display_name ?? '';

    if (intent.kind === 'remind') {
      // A nudge only means something when they owe me — in exactly one currency,
      // so there is one unambiguous debt to point at.
      const owing = personRows.filter((row) => BigInt(row.net) > 0n && row.only_group_id);
      if (owing.length !== 1) return false;
      const row = owing[0];
      setRequested(null);
      setDest({
        kind: 'remind',
        groupId: row.only_group_id as string,
        toMemberId: row.member_id,
        currency: row.currency,
        name,
      });
      beginAutoCommit({
        label: t.voice.autoReminding.replace('{name}', name),
        fallback: 'listening',
      });
      return true;
    }

    // Settle: one non-zero balance to clear (either direction), one currency.
    const owed = personRows.filter((row) => BigInt(row.net) !== 0n && row.only_group_id);
    if (owed.length !== 1) return false;
    const row = owed[0];
    const net = BigInt(row.net);
    const iPay = net < 0n;
    const whole = net < 0n ? -net : net;
    // A spoken partial ("settle 200 with Ravi") never exceeds what is owed.
    const spoken = intent.amount != null ? toVoiceMinorUnits(intent.amount, row.currency) : null;
    const amount = spoken != null && spoken < whole ? spoken : whole;
    if (amount <= 0n) return false;
    const major = Number(amount) / Number(minorUnitScale(row.currency));
    setRequested(null);
    setDest({
      kind: 'settle',
      groupId: row.only_group_id as string,
      toMemberId: row.member_id,
      amount,
      currency: row.currency,
      iPay,
      name,
    });
    beginAutoCommit({
      label: t.voice.autoSettling
        .replace('{amount}', `${major} ${row.currency}`)
        .replace('{name}', name),
      fallback: 'listening',
    });
    return true;
  };

  // A spoken "add Ravi to the latest group" — add a ghost (or several) to an
  // existing group by name. The group is resolved by the ordinary parse (a named
  // or relative one); a group that does not resolve, or an unnamed one with no
  // label to show, falls through to the expense parse rather than guessing.
  const tryAddMember = (transcript: string): boolean => {
    const add = detectAddMember(transcript);
    if (!add) return false;
    const parsed = parseVoiceExpenses(transcript, groupRefs);
    if (parsed.group?.kind !== 'existing') return false;
    const groupId = parsed.group.groupId;
    const groupName = groupRows.find((group) => group.id === groupId)?.name?.trim();
    if (!groupName) return false;
    setRequested(null);
    setDest({ kind: 'add-member', groupId, names: add.names, groupName });
    const who = add.names.join(', ');
    beginAutoCommit({
      label: t.voice.autoAddingPerson.replace('{name}', who).replace('{group}', groupName),
      fallback: 'listening',
    });
    return true;
  };

  // A spoken read-only question — "how much does Ravi owe me", "what's my
  // balance in Goa". Nothing is written: the number is looked up and shown on an
  // answer card. A person is resolved against the reader's 1:1 contacts; a group
  // question is resolved by the ordinary parse and answered from its ledger. An
  // overall (no target) question falls through — voice does not sum across
  // currencies (ADR-003). Returns true when it took and answered the question.
  const tryBalanceQuery = (transcript: string): boolean => {
    const query = detectBalanceQuery(transcript);
    if (!query) return false;

    const fmt = (minor: bigint, currency: string): string =>
      `${Number(minor) / Number(minorUnitScale(currency))} ${currency}`;

    if (query.kind === 'person') {
      const rows = (people.data ?? []).filter(
        (row) => row.only_group_id && oneToOne.data.has(row.only_group_id),
      );
      const contacts = [
        ...new Map(rows.map((row) => [row.person_key, row.display_name])).entries(),
      ].map(([id, name]) => ({ id, name }));
      const matched = matchMemberNames(query.who, contacts);
      if (matched.length !== 1) {
        setAnswer({ kind: 'text', text: t.voice.ansNoPerson.replace('{name}', query.who) });
        setPhase('answer');
        return true;
      }
      const personRows = rows.filter((row) => row.person_key === matched[0]);
      const name = personRows[0]?.display_name ?? query.who;
      // The currency with the biggest balance is the headline; a person with no
      // open balance in any currency reads as settled.
      const top = personRows
        .map((row) => {
          const net = BigInt(row.net);
          return { row, net, mag: net < 0n ? -net : net };
        })
        .sort((a, b) => (b.mag > a.mag ? 1 : b.mag < a.mag ? -1 : 0))[0];
      if (!top || top.mag === 0n) {
        setAnswer({ kind: 'text', text: t.voice.ansSettled.replace('{name}', name) });
      } else {
        const amount = fmt(top.mag, top.row.currency);
        setAnswer({
          kind: 'text',
          text:
            top.net > 0n
              ? t.voice.ansTheyOweYou.replace('{name}', name).replace('{amount}', amount)
              : t.voice.ansYouOwe.replace('{name}', name).replace('{amount}', amount),
        });
      }
      setPhase('answer');
      return true;
    }

    // A group balance question — resolve the group the ordinary way. Overall
    // (no group named) is not answered by voice, so it falls through.
    const parsed = parseVoiceExpenses(transcript, groupRefs);
    if (parsed.group?.kind !== 'existing') return false;
    const groupId = parsed.group.groupId;
    const group = groupRows.find((candidate) => candidate.id === groupId);
    const groupName = group?.name?.trim();
    if (!groupName) return false;
    setQueryGroupId(groupId);
    setAnswer({ kind: 'group', groupName, currency: group?.default_currency ?? dc });
    setPhase('answer');
    return true;
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
    // A settle/remind/add-member command, or a read-only balance question, only
    // makes sense as a fresh utterance, never as an expense appended to a batch.
    // When one takes the utterance it drives its own phase (an auto-act window,
    // or an answer card), so there is nothing more to interpret here.
    if (
      mode !== 'append' &&
      (tryMoneyIntent(transcript) || tryAddMember(transcript) || tryBalanceQuery(transcript))
    )
      return;
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

  // A widget-supplied transcript: the voice widget captured speech on the home
  // screen and deep-linked it here, so feed it straight into the interpret
  // pipeline — no mic, no cold-launch-then-listen. Consumed once per nonce, so a
  // fresh widget tap on an already-open screen is re-read while a re-delivery of
  // the same intent (Android sends some twice) is dropped.
  const consumedHn = useRef<string | null>(null);
  useEffect(() => {
    if (!widgetHeard) return;
    const nonce = typeof params.hn === 'string' && params.hn ? params.hn : widgetHeard;
    if (consumedHn.current === nonce) return;
    consumedHn.current = nonce;
    captureActive.current = true;
    setMicMode('replace');
    handleTranscript(widgetHeard);
    // handleTranscript is a fresh closure each render but reads live refs/state;
    // running it once per nonce is the whole intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetHeard, params.hn]);

  // The reader set or cleared the pin by hand. Latch it so a still-pending
  // auto-read cannot come back and overwrite their choice.
  const handleLocationChange = (next: ExpenseLocation | null): void => {
    locationTouched.current = true;
    setLocation(next);
  };

  // A set of people → the group they already share, if any. First match wins;
  // it only ever answers "these exact people already have a group together".
  const groupBySignature = useMemo(() => {
    const map = new Map<string, string>();
    for (const sig of signatures.data) {
      const key = peopleSignatureKey(sig.names);
      if (!map.has(key)) map.set(key, sig.groupId);
    }
    return map;
  }, [signatures.data]);

  // A multi-person choice on the People tab. If the selected people already
  // share a group, land the batch there; otherwise make a fresh group named
  // after them (WhatsApp-style) with a ghost each, on save. One person is the
  // 1:1 case and rides the same path — a lone name reuses their group if it
  // exists, else opens a new 1:1.
  const resolvePeople = (names: string[]): void => {
    const clean = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (clean.length === 0) return;
    groupCreated.current = false;
    ghostMemberIds.current = null;
    const match = groupBySignature.get(peopleSignatureKey(clean));
    if (match) {
      setDest({ kind: 'existing', groupId: match });
    } else {
      setDest({
        kind: 'people',
        groupId: randomUUID(),
        memberId: randomUUID(),
        name: clean.join(', '),
        ghostNames: clean,
      });
    }
    setPickerOpen(false);
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

  // Push-to-talk. The raised mic in the bottom bar can be held rather than
  // tapped, and holding it pushed this screen the instant the finger landed —
  // which is why the mic here is already listening by the time anybody reads
  // this. What the bar cannot do is end the sentence, because the recogniser is
  // on this side; so the gesture is left in a small store (`lib/pushToTalk`) and
  // picked up here.
  // The ending lives on the store rather than in local state, and the mic panel
  // clears it by taking it once it has acted. That way an ending is never
  // applied twice, and — because the store keeps it rather than firing it — a
  // hold short enough to finish before this screen mounted is still picked up on
  // arrival instead of being missed.
  const hold = useSyncExternalStore(pushToTalk.subscribe, pushToTalk.getSnapshot);
  // Slid away: nothing was meant by it, so leave. The panel's own unmount gives
  // the microphone back and drops the audio with it, which is exactly what a
  // cancel wants. Not routed through `dismiss`: a cancel can only reach a
  // listening screen with nothing on it, so there is no batch to fold back to —
  // only the flag that makes the mic's parting `onDone` be ignored, and the way
  // out.
  const cancelledHold = hold.ended?.mode === 'cancel' ? hold.ended.seq : 0;
  useEffect(() => {
    if (cancelledHold === 0) return;
    captureActive.current = false;
    router.back();
    pushToTalk.take({ seq: cancelledHold, mode: 'cancel' });
  }, [cancelledHold]);

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

  // On opening the review, read the current location once and pin the batch to
  // it — so the place is saved by default, no tap needed. It asks permission
  // just-in-time; a refusal or an unavailable fix leaves the field on its manual
  // "Add location" / "Pick on map" buttons rather than failing loudly. Never
  // overrides a pin the reader has since set or cleared: the latch runs it
  // exactly once per parsed batch.
  useEffect(() => {
    if (phase !== 'review' || autoLocated.current) return;
    autoLocated.current = true;
    if (!locationAvailable()) return;
    const gen = locationGen.current;
    void (async () => {
      // Set inside the async body, not the effect body, so it does not read as a
      // synchronous cascading setState (react-hooks/set-state-in-effect).
      setLocating(true);
      try {
        const result = await captureLocation();
        if (!result.ok) return;
        // Drop a fix that lost its race: the reader has since set or cleared the
        // pin by hand, or a fresh utterance moved on to a new batch.
        if (locationGen.current !== gen || locationTouched.current) return;
        setLocation(result.location);
      } finally {
        setLocating(false);
      }
    })();
  }, [phase]);

  // Track the keyboard's height so the picker sheet can be lifted above it.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  /**
   * Say the save worked, once, wherever it leaves the reader.
   *
   * Every write below used to end by replacing this screen with its
   * destination, and for a group that is right: the ledger the expense has just
   * joined is the receipt, and the split is the thing worth a glance. "Just me"
   * is the one destination where it was not — a private tab, nothing to check,
   * and a save that dropped somebody into it left them navigating back out of a
   * screen they never asked for. That one returns to the dashboard, and the
   * confirmation carries what the screen would have said. The capture inbox
   * keeps its landing for the opposite reason to the group's: what was filed
   * there is unfinished and still wants assigning, so showing the queue is the
   * point. Every path says it worked, so the jump is never the only signal.
   */
  const confirmSaved = (): void => {
    toast.show(plural(locale, drafts.length, t.voice.savedCount));
  };

  const save = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      const date = voiceExpenseDate ?? today();
      const fallback = t.voice.anExpense;

      if (dest.kind === 'settle') {
        // A spoken settle-up. The other member is on the dest; my own member id
        // is read from the group now that it has loaded. `iPay` (I owe them)
        // sets the direction; the amount is the whole balance or a partial. Cash
        // is the neutral default rail — the reader can change it on the ledger.
        const members = target.members.data ?? [];
        const myMemberId = members.find((member) => isViewer(member, viewerId))?.id;
        if (!myMemberId) throw new Error('no member to settle as');
        await recordSettlement.mutateAsync({
          groupId: dest.groupId,
          fromMemberId: dest.iPay ? myMemberId : dest.toMemberId,
          toMemberId: dest.iPay ? dest.toMemberId : myMemberId,
          amount: dest.amount,
          rail: 'cash',
          currency: dest.currency,
        });
        committed.current = true;
        router.replace({ pathname: '/group/[id]', params: { id: dest.groupId } });
        return;
      }

      if (dest.kind === 'remind') {
        // A nudge to settle. The server decides the amount, the wording, and
        // whether to send at all (only a real debt, once a day). A rate-limit is
        // a normal "already reminded today", not a failure — swallow just that.
        try {
          await nudgeToSettle({
            groupId: dest.groupId,
            toMemberId: dest.toMemberId,
            currency: dest.currency,
          });
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : '';
          if (!/NUDGE_RATE_LIMIT/i.test(message)) throw caught;
        }
        committed.current = true;
        router.replace({ pathname: '/group/[id]', params: { id: dest.groupId } });
        return;
      }

      if (dest.kind === 'add-member') {
        // Add a ghost per spoken name. Names already in the group are skipped —
        // so a retry after a partial failure, or re-speaking the command, adds no
        // duplicate (there is no member id to reuse the way a `people` batch has).
        const existing = new Set(
          (target.members.data ?? []).map((member) =>
            displayName(member, viewerId).trim().toLowerCase(),
          ),
        );
        for (const name of dest.names) {
          if (existing.has(name.trim().toLowerCase())) continue;
          await addGhost.mutateAsync(name);
        }
        committed.current = true;
        router.replace({ pathname: '/group/[id]', params: { id: dest.groupId } });
        return;
      }

      if (dest.kind === 'unassigned') {
        // No group chosen: keep the batch as a draft in the capture inbox.
        await persistDraftsToInbox();
        committed.current = true;
        confirmSaved();
        router.replace('/captures');
        return;
      }

      if (dest.kind === 'me') {
        // Just me: each draft is a private personal expense (A48), in its own
        // spoken currency. The draft's stable id is the record id, so a retry
        // after a partial failure re-uses it rather than writing a duplicate.
        for (const draft of drafts) {
          const currency = draft.currency ?? dc;
          const amount = toMinor(draft.amount, currency);
          if (amount === null) continue;
          const description = draft.note.trim() || fallback;
          await upsertPersonal.mutateAsync({
            recordId: draft.key,
            recordKind: 'txn',
            data: encodeTxn({
              kind: 'expense',
              amount,
              currency,
              category: draft.category ?? guessCategory(description),
              note: description,
              date,
              loanId: null,
              recurringId: null,
            }),
          });
        }
        committed.current = true;
        confirmSaved();
        // Home, not the personal tab. Nothing there needs looking at — the
        // expense is private, split with nobody and complete on save — so
        // opening it only cost the reader the walk back.
        router.replace('/');
        return;
      }

      // A group destination. Make the group first if it is a new one — its id
      // and the reader's member id were chosen up front, so an expense can name
      // them in the same breath (the offline-first pattern used elsewhere). The
      // ref guards a second create on a retry: the group exists after the first.
      if ((dest.kind === 'create' || dest.kind === 'people') && !groupCreated.current) {
        await createGroup.mutateAsync({
          groupId: dest.groupId,
          creatorMemberId: dest.memberId,
          name: dest.name,
          type: GroupType.Other,
          currency: dc,
        });
        groupCreated.current = true;
      }

      // The brand-new people each need a ghost in the group — minted once (one
      // per name, in order) and reused on a retry, so a partial failure adds no
      // second set. A lone name is the 1:1 case; several is a real group.
      if (dest.kind === 'people' && !ghostMemberIds.current) {
        const ids: string[] = [];
        for (const ghostName of dest.ghostNames) {
          ids.push(await addGhost.mutateAsync(ghostName));
        }
        ghostMemberIds.current = ids;
      }

      const groupCurrency =
        dest.kind === 'existing' ? (target.group.data?.default_currency ?? dc) : dc;
      const groupMembers = target.members.data ?? [];
      const payer =
        dest.kind === 'existing'
          ? (groupMembers.find((member) => isViewer(member, viewerId))?.id ?? groupMembers[0]?.id)
          : dest.memberId;
      if (!payer) throw new Error('no members to split among');
      const participants =
        dest.kind === 'existing'
          ? resolveVoiceParticipants({
              all: groupMembers.map((member) => member.id),
              payer,
              members: groupMembers.map((member) => ({
                id: member.id,
                name: displayName(member, viewerId),
              })),
              peopleText: voicePeopleText,
              splitCount: voiceSplitCount,
            })
          : dest.kind === 'people'
            ? [dest.memberId, ...(ghostMemberIds.current ?? [])]
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
      confirmSaved();
      router.replace({ pathname: '/group/[id]', params: { id: dest.groupId } });
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'voice.save'));
    } finally {
      setSaving(false);
    }
  };

  // The auto-commit timer fires whatever `save` is current when the window ends,
  // so the write reads the destination and drafts as they finally stand. Kept in
  // a ref via an effect (not a render-time assignment) so it tracks each render.
  useEffect(() => {
    commitRef.current = save;
  });

  // A pending auto-commit must not outlive the screen: clear it on unmount so a
  // timer never fires save() after the component is gone.
  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    },
    [],
  );

  // Every draft must carry a real amount — an empty or non-numeric field would
  // otherwise be silently skipped, and a screenful of them would "save" nothing
  // while still navigating away.
  const canSave =
    drafts.length > 0 &&
    !saving &&
    // Hold Save while the location fix is still in flight, so an expense is not
    // persisted with location === null a moment before the read would have filled
    // it in. captureLocation races a short timeout, so this is a brief wait.
    !locating &&
    drafts.every((draft) => toMinor(draft.amount, draft.currency ?? dc) !== null);

  // The footer total must read in the same currency the Save will persist, or
  // it lies about what lands. A group save writes every expense in the group's
  // own currency (see `save`), so the footer totals in that one currency too;
  // the unassigned inbox keeps each capture's spoken currency, so there the
  // total is per-currency and a mixed batch shows its count instead — there is
  // no total across currencies (ADR-004).
  const destCurrency =
    dest.kind === 'unassigned' || dest.kind === 'me'
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

  // The destination as the picker reads it. The picker only needs to know which
  // row carries the check, so the kinds it has no row for — a spoken settle-up,
  // a nudge, "add Ravi to the trip" — read as nothing selected. (It is never
  // opened over one of those; the answer card is.)
  const pickerSelection: DestinationSelection =
    dest.kind === 'unassigned' ||
    dest.kind === 'me' ||
    dest.kind === 'create' ||
    dest.kind === 'existing'
      ? dest.kind === 'existing'
        ? { kind: 'existing', groupId: dest.groupId }
        : { kind: dest.kind }
      : dest.kind === 'people'
        ? { kind: 'people', names: dest.ghostNames }
        : { kind: 'none' };

  // With no group chosen the batch is a draft (it lands in the capture inbox),
  // so the button says so; once a group is picked it writes real expenses and
  // the label counts them.
  const isDraft = dest.kind === 'unassigned';
  const saveLabel = isDraft ? t.voice.saveDraft : plural(locale, drafts.length, t.voice.save);

  // The line the answer card shows. A `text` answer is ready; a `group` one is
  // composed from its ledger and shows a spinner until the balance has loaded.
  const answerLine = (): { text: string } | { loading: true } => {
    if (!answer) return { text: '' };
    if (answer.kind === 'text') return { text: answer.text };
    if (queryLedger.loading) return { loading: true };
    const balance = queryLedger.myBalance;
    const amount = (minor: bigint): string =>
      `${Number(minor) / Number(minorUnitScale(answer.currency))} ${answer.currency}`;
    if (balance === 0n)
      return { text: t.voice.ansGroupSettled.replace('{group}', answer.groupName) };
    if (balance > 0n)
      return {
        text: t.voice.ansGroupOwed
          .replace('{group}', answer.groupName)
          .replace('{amount}', amount(balance)),
      };
    return {
      text: t.voice.ansGroupOwe
        .replace('{group}', answer.groupName)
        .replace('{amount}', amount(-balance)),
    };
  };

  // Ask another question: clear the answer and reopen the mic.
  const askAgain = (): void => {
    setAnswer(null);
    setQueryGroupId('');
    setMicMode('replace');
    setNoAmount(false);
    setAttempt((current) => current + 1);
    setPhase('listening');
  };

  return (
    <Screen>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: phase === 'review' ? theme.spacing.xl : clearance,
          gap: theme.spacing.xl,
          // Fill the viewport when the capture surface is shorter than it, so the
          // mic panel's own footer (the offline-voice offer) can sit at the foot of
          // the screen rather than tucked under the mic. `flexGrow` only ever sets a
          // *minimum* — a panel taller than the window still scrolls, where `flex`
          // would have squeezed it. The review lays itself out and keeps its own
          // pinned action bar, so it is left alone.
          ...(phase === 'review' ? null : { flexGrow: 1 }),
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
            <Text variant="title">
              {phase === 'review'
                ? t.voice.review
                : phase === 'answer'
                  ? t.voice.ansTitle
                  : t.voice.title}
            </Text>
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

            {/* One place for the whole batch (A43) — read once when the review
                opens and pinned by default; the reader can clear or move it. It
                rides onto every expense saved from this review. */}
            <LocationField value={location} onChange={handleLocationChange} busy={locating} />
          </View>
        ) : phase === 'committing' ? (
          // The Undo window. A confident command is about to write itself; the
          // banner says what and where, a spinner marks the wait, and Undo is the
          // one escape — no other choice competes with it here.
          <View
            style={{ alignItems: 'center', gap: theme.spacing.xl, paddingTop: theme.spacing.xxl }}
          >
            <ActivityIndicator color={theme.color.brand} />
            <Text variant="title" style={{ textAlign: 'center' }}>
              {autoBanner?.label ?? ''}
            </Text>
            <Button label={t.voice.autoUndo} variant="secondary" onPress={cancelAutoCommit} />
          </View>
        ) : phase === 'answer' ? (
          // A read-only answer to a spoken balance question. One line, and a mic
          // to ask another — nothing to save, nothing to undo.
          <View
            style={{ alignItems: 'center', gap: theme.spacing.xl, paddingTop: theme.spacing.xxl }}
          >
            {(() => {
              const line = answerLine();
              return 'loading' in line ? (
                <ActivityIndicator color={theme.color.brand} />
              ) : (
                <Text variant="title" style={{ textAlign: 'center' }}>
                  {line.text}
                </Text>
              );
            })()}
            <Button label={t.voice.askAgain} variant="secondary" onPress={askAgain} />
          </View>
        ) : (
          // Listening — the mic panel owns the whole capture surface, the miss
          // included. A heard-but-amountless try comes back as `missed`; the mic
          // is the retry, and tapping it (via `onListen`) clears the miss. No
          // warning banner and no separate button stacked around it.
          <View style={{ flexGrow: 1, gap: theme.spacing.lg, paddingTop: theme.spacing.xxl }}>
            <VoiceMicPanel
              key={attempt}
              onDone={handleTranscript}
              hints={hints}
              missed={noAmount}
              autoStart={!noAmount}
              endSignal={hold.ended}
              onEndConsumed={() => pushToTalk.take()}
              onListen={() => {
                // A capture the reader actually started — mark it live so its
                // transcript is accepted (and a dismissed one's is not).
                captureActive.current = true;
                setNoAmount(false);
              }}
            />
            {/* Only while a finger is actually on the bar's mic. It says the one
                thing a held button has to say and the tapped one does not: there
                is a way out that is not "finish the sentence". The chevron points
                the way the finger should go, which is the way the language runs
                backwards — leftwards in English, rightwards in Arabic. */}
            {hold.holding ? (
              <Row gap={theme.spacing.xs} style={{ justifyContent: 'center' }}>
                <Ionicons
                  name={isRtl() ? 'chevron-forward' : 'chevron-back'}
                  size={iconSize.sm}
                  color={theme.color.textMuted}
                />
                <Text variant="caption" tone="muted">
                  {t.voice.slideToCancel}
                </Text>
              </Row>
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
          {/* Lift the sheet by the keyboard's own height. A KeyboardAvoidingView
              does not work inside an Android Modal (its own window never resizes),
              so the height is measured (see keyboardHeight) and the sheet is
              pushed up above the keyboard — with its cap lowered to the space
              that remains, so a long list scrolls inside rather than clipping off
              the top. */}
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: theme.color.bg,
              borderTopLeftRadius: theme.radius.xxl,
              borderTopRightRadius: theme.radius.xxl,
              paddingHorizontal: theme.spacing.xl,
              paddingTop: theme.spacing.lg,
              paddingBottom:
                keyboardHeight > 0 ? theme.spacing.xl : insets.bottom + theme.spacing.xl,
              gap: theme.spacing.lg,
              marginBottom: keyboardHeight,
              // Never taller than the space left above the keyboard (or 80% of
              // the screen when it is closed): the list scrolls inside the sheet
              // rather than pushing rows off the top.
              maxHeight: Math.min(
                windowHeight * 0.8,
                windowHeight - keyboardHeight - insets.top - theme.spacing.xl,
              ),
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
                // Remount each time the sheet opens, so the tab and the picked
                // people re-seed from the current destination rather than keeping
                // stale state from the last open.
                key={pickerOpen ? 'open' : 'closed'}
                selection={pickerSelection}
                eyebrow={t.voice.saveTo}
                // The "new group" row is offered whenever a name was heard,
                // whatever the destination now stands at.
                createRow={
                  requested
                    ? { label: t.voice.newGroupNamed.replace('{name}', requested.name) }
                    : null
                }
                onChoose={(choice) => {
                  // A change of destination is a change of group/ghost to make,
                  // so drop the once-only latches for the new one.
                  groupCreated.current = false;
                  ghostMemberIds.current = null;
                  // 'create' is the picker naming a row, not a destination: the
                  // group id and my member id were minted when the name was
                  // heard, and this screen holds them.
                  if (choice.kind === 'create') {
                    if (requested) setDest({ kind: 'create', ...requested });
                  } else {
                    setDest(choice);
                  }
                  setPickerOpen(false);
                }}
                onResolvePeople={resolvePeople}
                people={peopleChoices}
                groups={groupRows}
                t={t}
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
  if (dest.kind === 'me') {
    return { label: t.voice.justMe, icon: 'person-circle-outline' };
  }
  if (dest.kind === 'create') {
    return {
      label: t.voice.newGroupNamed.replace('{name}', dest.name),
      icon: 'add-circle-outline',
    };
  }
  if (dest.kind === 'people') {
    return {
      label: dest.name,
      icon: dest.ghostNames.length > 1 ? 'people-outline' : 'person-outline',
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
        {/* The icon reads the description: a coffee cup for a chai, a car for the
            cab — guessed from the note, tinted by its category, so the line is
            recognisable at a glance instead of a row of identical receipts. */}
        <CategoryBadge category={draft.category} description={draft.note} size={36} />
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
        <CategoryBadge category={draft.category} description={draft.note} size={40} />
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
