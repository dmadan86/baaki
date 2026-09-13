/**
 * Bank messages into drafts.
 *
 * This is the SMS feature, and on an iPhone it is the whole of it. iOS has no
 * API that reads Messages at any tier, and Android's `READ_SMS` is restricted —
 * held without an approved core use case it is grounds for removal from Play,
 * not a rejected update (`docs/plan-drafts-and-rules.md` §1). So the honest
 * design is the one where a person hands the messages over, and it is complete
 * on its own rather than a fallback for a reader that is not there.
 *
 * A build made with `WAVES_SMS_READER=1`, on Android, for somebody in the
 * `sms_inbox_read` treatment arm, gets one extra button here: it leads to a
 * disclosure screen (`./messages`), never straight to the system prompt.
 * Everything downstream of that button — the found list, the ticking, the
 * writing — is this screen, unchanged.
 *
 * TWO ROLES, AND THE SCREEN KNOWS WHICH IT IS IN. Where nothing reads the inbox
 * on its own — every iPhone, and any Android build without the reader — this is
 * the feature, the way a bank payment gets into Waves at all, and it opens on a
 * paragraph and three steps because somebody is about to be asked to do work.
 * Where the messages *are* already being read (`useSmsAutoRead`), Review opens
 * on what was found and this screen is the other way in: it is titled "Add
 * another way", and the instruction at the top gives way to a line saying what
 * the reader is doing — the very paragraph Review stopped showing would be a
 * strange thing to meet on the way out of it. The steps stay either way; they
 * are about the paste, which is still the thing being done here.
 *
 * WHO THIS IS FOR. Somebody who has never used an expense app, and may never
 * have deliberately copied text on a phone before. Everything on the screen is
 * measured against that: no codes, no jargon, no rule about blank lines to get
 * wrong, and never a guess dressed up as a fact.
 *
 * - The sender is a telecom routing header (`JM-ICICIT-S`), so it is turned
 *   into "ICICI Bank" by `lib/smsPlain.ts` — and when that table does not know
 *   the id, the line is simply not there. A code on screen is worse than a
 *   blank.
 * - A merchant that is plainly not a name — a phone number, a bare "VPA" —
 *   does not become the title. "Payment from Axis Bank" is less specific and
 *   entirely true, which is the trade this screen always makes.
 * - A row the parser was unsure of says *what* it was unsure of, in a sentence,
 *   and every pasted row can be opened to read the message it was made from.
 *   "Check this" with nothing to check against is not a warning, it is a worry.
 *
 * WHERE THINGS GO. Each ticked payment becomes a `captures` row: an expense
 * with no group yet, which is what the Review tab has held since A34. Not a
 * second inbox (#565 undid that once already), not an expense in a group —
 * nothing here knows who was there, and the parser deliberately does not guess
 * at a split.
 *
 * WHAT IS NOT SENT. Parsing is on-device (ADR-013): a bank message carries an
 * account tail, a balance and sometimes a one-time password. The text of a
 * pasted message rides along as `rawText` the way a scanned receipt's OCR does
 * — a person put it there themselves. The text of a *read* message never does;
 * `lib/smsDrafts.ts` is where that is decided, and a test pins it. The same
 * function decides what may be *shown*, so the message a person can open on a
 * row is exactly the message that will be kept, and a read one is neither. And
 * nothing on this screen reports anything at all: no Sentry event, no Clarity
 * event, not even a count. A paste that parses badly is said to the person in
 * front of it, and to nobody else.
 *
 * WHY IT IS A FLASHLIST. A month of statements is a hundred rows, and this is
 * the screen the plan points the backfill at. The paste box and the intro ride
 * as the list header so there is one scroll region rather than a list nested in
 * a ScrollView, which does not virtualise at all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { Pressable, TextInput, View } from 'react-native';

import {
  proposeFromSms,
  SMS_LOW_CONFIDENCE,
  type ExpenseCandidate,
  type SmsMessage,
} from '@waves/core';
import {
  Badge,
  Button,
  Callout,
  Card,
  Divider,
  EmptyState,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  Text,
  useTheme,
} from '@waves/ui';

import { WatchingLine } from '@/components/WatchingLine';
import { dayHeading } from '@/data/activity';
import { useCaptures, useCreateCapture } from '@/data/hooks';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useBottomClearance } from '@/lib/clearance';
import { friendlyError } from '@/lib/errors';
import { useGuestGuard } from '@/lib/guestGuard';
import { router } from '@/lib/navigation';
import { smsCaptureId } from '@/lib/smsCaptureId';
import {
  bodiesByKey,
  bodyForDisplay,
  planSmsDrafts,
  splitMessages,
  unreadableCount,
  type SmsDraftProvenance,
} from '@/lib/smsDrafts';
import { useSmsAutoRead } from '@/lib/smsAutoRead';
import { useSmsInboxReader } from '@/lib/smsFeature';
import { bankFromSender, bankFromText, merchantName } from '@/lib/smsPlain';
import { takeReadMessages } from '@/lib/smsReadBridge';

/**
 * A day heading, or one payment under it.
 *
 * The body rides on the item rather than being looked up in the renderer, so
 * the rule about which bodies may be seen is applied once, where the list is
 * built, instead of at every recycle.
 */
type FoundItem =
  | { kind: 'day'; key: string; at: string }
  | { kind: 'candidate'; key: string; candidate: ExpenseCandidate; body: string | null };

/** A comfortable target for a thumb that is not aiming carefully. */
const ROW_MIN_HEIGHT = 60;

/**
 * What to call this payment, and who said so.
 *
 * Never the raw sender and never a merchant that is obviously not a merchant —
 * both judgements live in `lib/smsPlain.ts` and are pinned by its test. The
 * order of the fallbacks is the order of decreasing specificity and constant
 * truthfulness: the shop if we have one, otherwise the bank, otherwise the
 * plainest thing that is still certainly true.
 */
function describe(
  candidate: ExpenseCandidate,
  body: string | null,
  t: UiStrings,
): { title: string; from: string | null } {
  const bank = bankFromSender(candidate.sender) ?? bankFromText(body);
  const shop = merchantName(candidate.merchant);
  if (shop) return { title: shop, from: bank };
  if (bank) return { title: t.smsImport.paymentFromBank.replace('{bank}', bank), from: null };
  return { title: t.smsImport.aPayment, from: null };
}

/**
 * Why a row is not already ticked, in words.
 *
 * `preselect` is false for exactly two reasons and this says which: a message
 * that named no day, and a message the parser only half understood. A flag
 * without a reason asks a person to check something they cannot see.
 */
function doubts(candidate: ExpenseCandidate, t: UiStrings): string[] {
  const reasons: string[] = [];
  if (candidate.dateInferred) reasons.push(t.smsImport.dateNotInMessage);
  if (candidate.confidence < SMS_LOW_CONFIDENCE) reasons.push(t.smsImport.hardToRead);
  return reasons;
}

/**
 * One found payment: a tick, who it was, the amount — and, underneath, the
 * message it was made from.
 *
 * The date is not on the row; the day heading above it carries that, which is
 * the point of grouping. The second line carries who the bank says it was and
 * which card, in words rather than in the bank's own shorthand.
 *
 * The whole row toggles the tick, so the target is the row and not the little
 * box. "Read the message" is a separate, smaller target underneath precisely so
 * that reaching for it cannot tick anything by accident.
 */
function FoundRow({
  candidate,
  body,
  picked,
  open,
  locale,
  t,
  onToggle,
  onOpen,
}: {
  candidate: ExpenseCandidate;
  body: string | null;
  picked: boolean;
  open: boolean;
  locale: string;
  t: UiStrings;
  onToggle: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { title, from } = describe(candidate, body, t);
  const parts: string[] = [];
  if (from) parts.push(from);
  if (candidate.accountTail)
    parts.push(t.smsImport.cardEnding.replace('{tail}', candidate.accountTail));
  const subtitle = parts.join(' · ');
  const reasons = doubts(candidate, t);

  return (
    <View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: picked }}
        accessibilityLabel={`${title}, ${picked ? t.smsImport.selected : t.smsImport.notSelected}`}
        onPress={onToggle}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <Row
          style={{
            gap: theme.spacing.md,
            alignItems: 'center',
            paddingVertical: theme.spacing.md,
            minHeight: ROW_MIN_HEIGHT,
          }}
        >
          {/* Never colour alone: the tick is a different glyph, not just a
              different shade, and the a11y state says it a third way (#191). */}
          <Ionicons
            name={picked ? 'checkbox' : 'square-outline'}
            size={iconSize.jumbo}
            color={picked ? theme.color.brand : theme.color.textFaint}
          />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text variant="subheading" numberOfLines={2}>
              {title}
            </Text>
            {subtitle ? (
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
            {/* An icon as well as the words, so the uncertainty is not carried
                by colour (#191) — and the words themselves, so "check this"
                names something a person can actually go and check. */}
            {reasons.map((reason) => (
              <Row key={reason} gap={theme.spacing.xs} style={{ alignItems: 'flex-start' }}>
                <Ionicons
                  name="alert-circle-outline"
                  size={iconSize.sm}
                  color={theme.color.warning}
                  style={{ marginTop: 2 }}
                />
                <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                  {reason}
                </Text>
              </Row>
            ))}
          </View>
          <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
            <MoneyText
              amount={candidate.amount.minor}
              currency={candidate.amount.currency}
              locale={locale}
              variant="subheading"
            />
            {/* A row "select all" swept in is still marked, so nobody is
                carried past a doubt without seeing it. */}
            {candidate.preselect ? null : <Badge label={t.smsImport.checkThis} />}
          </View>
        </Row>
      </Pressable>

      {/* Only ever a pasted message. `bodyForDisplay` is the same function that
          decides what may be stored, so what can be read here is exactly what
          will be kept — and a message read out of the inbox is neither. */}
      {body ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={onOpen}
          hitSlop={8}
          style={({ pressed }) => ({
            alignSelf: 'flex-start',
            paddingVertical: theme.spacing.sm,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Row gap={theme.spacing.xs}>
            <Ionicons
              name={open ? 'chevron-up' : 'chevron-down'}
              size={iconSize.sm}
              color={theme.color.brand}
            />
            <Text variant="caption" tone="brand">
              {open ? t.smsImport.hideMessage : t.smsImport.showMessage}
            </Text>
          </Row>
        </Pressable>
      ) : null}
      {open && body ? (
        <Card flat style={{ padding: theme.spacing.lg, marginBottom: theme.spacing.md }}>
          <Text variant="caption" tone="muted" selectable>
            {body}
          </Text>
        </Card>
      ) : null}
    </View>
  );
}

/** One line of the three-step path in, for somebody who has never done this. */
function Step({ index, text }: { index: number; text: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Row gap={theme.spacing.md} style={{ alignItems: 'flex-start' }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.color.brandSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text variant="micro" tone="brand">
          {String(index)}
        </Text>
      </View>
      <Text variant="caption" style={{ flex: 1 }}>
        {text}
      </Text>
    </Row>
  );
}

export default function PasteMessagesScreen(): React.JSX.Element {
  const theme = useTheme();
  const clearance = useBottomClearance(theme.spacing.xl);
  const { t, locale } = useStrings();
  const { session } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const guard = useGuestGuard();
  const createCapture = useCreateCapture();
  const captures = useCaptures();
  // Both gates, asked once: Android, a build that declares the permission, and
  // the treatment arm. False everywhere else, including every iPhone.
  const readerOffered = useSmsInboxReader();
  // Whether the inbox is being read *without being asked* — which decides what
  // this screen is. With nothing reading it is the feature: the way a spend gets
  // in, and it says how, step by step. With a reader running it is the other
  // way: somebody came here because the automatic path missed something, and a
  // paragraph telling them to go and copy a message would be the very
  // instruction Review just stopped showing. Then the top of this screen says
  // what the reader is doing instead, and the steps stay for the paste itself.
  const auto = useSmsAutoRead();
  // One slow clock, so the "2 min ago" does not need Date.now() in a render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!auto.enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [auto.enabled]);

  const [blob, setBlob] = useState('');
  // Messages read from the inbox, kept apart from the pasted ones so each keeps
  // its real received time — a dateless bank SMS is filed on the day it
  // arrived, which a paste (received "now") cannot know. Held in state for the
  // life of this screen and written to disk by nothing.
  const [readMessages, setReadMessages] = useState<readonly SmsMessage[]>([]);
  // Explicit ticks, over the parser's own pre-selection. Absent means "whatever
  // `preselect` said", so a person who ticks nothing still gets the sensible set.
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  // Which rows have their message open. Per row, and forgotten on leaving.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<number | null>(null);

  // The disclosure screen leaves what it read here and pops. On focus rather
  // than on mount: this screen is never unmounted while the disclosure is up,
  // so a mount effect would have run long before there was anything to collect.
  // `takeReadMessages` reads and clears in one step, so a later visit — or a
  // second focus after nothing happened — picks up nothing.
  useFocusEffect(
    useCallback(() => {
      const handed = takeReadMessages();
      if (handed && handed.length > 0) {
        setReadMessages((current) => [...current, ...handed]);
        setError(null);
      }
    }, []),
  );

  const pastedBlocks = useMemo(() => splitMessages(blob), [blob]);
  const pasted = useMemo(
    () =>
      pastedBlocks.map((body) => ({
        body,
        // A pasted message carries no arrival time of its own, so "now" stands
        // in — and every candidate built from one that named no date is marked
        // `dateInferred`, which the row says out loud.
        receivedAt: new Date().toISOString(),
      })),
    [pastedBlocks],
  );

  // Read first, so that when the same message is both read and pasted the read
  // one wins the dedupe — and therefore the stricter no-body rule applies.
  const candidates = useMemo(
    () => proposeFromSms([...readMessages, ...pasted]),
    [readMessages, pasted],
  );

  // Which of these came out of the inbox. Computed from the read messages alone
  // rather than inferred from what is missing, so a body can never be attached
  // to a read draft by an accident of ordering.
  const readKeys = useMemo(
    () => new Set(proposeFromSms(readMessages).map((item) => item.dedupeKey)),
    [readMessages],
  );

  const bodies = useMemo(() => bodiesByKey(pasted), [pasted]);

  // Drafts already waiting in Review, by the key of the message behind them.
  // Named rather than hidden: a re-paste that silently showed fewer rows than
  // the person pasted would read as the parser having failed.
  //
  // This is the *visible* half of the guarantee and only covers drafts still
  // open — `useCaptures` drops the ones already filed into a group. The durable
  // half is the id: `smsCaptureId` derives it from the message, so a payment
  // that has since become an expense is written again as the same row id, and
  // `capture.create` answers that with the success it already achieved rather
  // than a second draft. Re-pasting a whole month is safe; it just cannot say
  // "already added" about the part of it that has since been filed.
  const alreadyKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of captures.data ?? []) {
      const key = (row.parsed as SmsDraftProvenance | null)?.dedupeKey;
      if (typeof key === 'string') keys.add(key);
    }
    return keys;
  }, [captures.data]);

  const fresh = useMemo(
    () => candidates.filter((item) => !alreadyKeys.has(item.dedupeKey)),
    [candidates, alreadyKeys],
  );
  const alreadyCount = candidates.length - fresh.length;
  // How many pasted blocks produced nothing. Only pasted ones are counted: a
  // read window sweeps up every message in it, most of which are not payments,
  // and "412 of those were not payments" would be noise rather than news.
  const notPayments = useMemo(() => unreadableCount(pastedBlocks), [pastedBlocks]);

  const chosen = useMemo(() => {
    const keys = new Set<string>();
    for (const item of fresh) {
      if (ticks[item.dedupeKey] ?? item.preselect) keys.add(item.dedupeKey);
    }
    return keys;
  }, [fresh, ticks]);

  const allChosen = fresh.length > 0 && chosen.size === fresh.length;

  const feed = useMemo((): FoundItem[] => {
    const items: FoundItem[] = [];
    let day = '';
    for (const candidate of fresh) {
      const candidateDay = candidate.at.slice(0, 10);
      if (candidateDay !== day) {
        day = candidateDay;
        items.push({ kind: 'day', key: `day-${candidateDay}`, at: candidate.at });
      }
      items.push({
        kind: 'candidate',
        key: candidate.dedupeKey,
        candidate,
        body: bodyForDisplay(candidate.dedupeKey, bodies, readKeys),
      });
    }
    return items;
  }, [bodies, fresh, readKeys]);

  const toggle = useCallback((key: string, next: boolean): void => {
    setTicks((current) => ({ ...current, [key]: next }));
  }, []);

  const openMessage = useCallback((key: string): void => {
    setOpened((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  /**
   * One control, two states — the Wallet pattern.
   *
   * "Select all" takes the uncertain rows too. Somebody who asks for all of
   * them has asked for all of them, and quietly holding two back would be the
   * screen overruling a person who said what they wanted. What it must not do
   * is sweep them in *invisibly*, so the "Check this" mark and the sentence
   * under each one stay exactly as they were: still selectable, still
   * questioned, and one tap away from being put back.
   */
  const toggleAll = useCallback((): void => {
    const next: Record<string, boolean> = {};
    for (const item of fresh) next[item.dedupeKey] = !allChosen;
    setTicks((current) => ({ ...current, ...next }));
  }, [allChosen, fresh]);

  /** Typing or pasting again puts the screen back to work, so "done" clears. */
  const edit = useCallback((text: string): void => {
    setBlob(text);
    setAdded(null);
    setError(null);
  }, []);

  const paste = useCallback(async (): Promise<void> => {
    const text = await Clipboard.getStringAsync();
    if (!text.trim()) return;
    // Joined with a blank line, which is the separator this screen no longer
    // asks anybody to know about: `splitMessages` finds the boundaries itself,
    // and the Paste button puts the clearest one in for free.
    setBlob((current) => (current ? `${current}\n\n${text}` : text));
    setAdded(null);
    setError(null);
  }, []);

  /**
   * Write the ticked payments as drafts.
   *
   * Each id is derived from the message (`smsCaptureId`), so pasting the same
   * statement next week produces the same ids and the second run writes nothing
   * — the database is what enforces that, not this screen's memory of it. Each
   * draft is its own attempt: one that refuses does not take the others down,
   * and the count that is reported is the count that actually landed.
   */
  const add = useCallback(async (): Promise<void> => {
    if (saving) return;
    if (guard.blockWrite()) return;
    if (!ownerId) return;

    const drafts = planSmsDrafts({ candidates: fresh, chosen, readKeys, bodies });
    if (drafts.length === 0) return;

    setSaving(true);
    setError(null);
    let placed = 0;
    try {
      for (const draft of drafts) {
        const captureId = await smsCaptureId(ownerId, draft.dedupeKey);
        await createCapture.mutateAsync({
          captureId,
          description: draft.description,
          category: draft.category,
          expenseDate: draft.expenseDate,
          currency: draft.currency,
          amount: draft.amount,
          rawText: draft.rawText,
          parsed: { ...draft.parsed },
        });
        placed += 1;
      }
      setAdded(placed);
      setBlob('');
      setTicks({});
      setOpened({});
      setReadMessages([]);
    } catch (caught) {
      setAdded(placed > 0 ? placed : null);
      setError(friendlyError(caught, t.captures.couldNotSave, 'smsImport.addDrafts'));
    } finally {
      setSaving(false);
    }
  }, [
    bodies,
    chosen,
    createCapture,
    fresh,
    guard,
    ownerId,
    readKeys,
    saving,
    t.captures.couldNotSave,
  ]);

  // Nothing handed over and nothing done yet: the one moment the three steps
  // are worth the room. They go away the instant there is anything to look at.
  const firstRun = blob.length === 0 && readMessages.length === 0 && added === null;
  const done = added !== null && error === null && fresh.length === 0;

  const header = (
    <View style={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
      <Row style={{ paddingTop: theme.spacing.md, alignItems: 'center' }}>
        <IconButton label={t.common.close} onPress={() => router.back()}>
          <Ionicons name="close" size={iconSize.xl} color={theme.color.text} />
        </IconButton>
        {/* Named by the door you came through: "Add another way" when the
            messages are already being read for you, and the feature's own name
            when this is the whole of it. `marginStart`, not `marginLeft`: the
            title sits beside the close button on both sides of the world. */}
        <Text variant="heading" style={{ marginStart: theme.spacing.md, flex: 1 }}>
          {auto.enabled ? t.captures.addAnotherWay : t.smsImport.title}
        </Text>
      </Row>

      <Card style={{ gap: theme.spacing.md }}>
        {/* The instruction, or the state. Never both: with a reader running,
            "open your messages app and copy one" is the sentence a person came
            here having already been spared. */}
        {auto.enabled ? (
          <WatchingLine
            checking={auto.checking}
            lastCheckedAt={auto.lastCheckedAt}
            now={now}
            locale={locale}
            t={t}
            onRefresh={() => void auto.refresh()}
          />
        ) : (
          <Text variant="body">{t.smsImport.howToDrafts}</Text>
        )}
        {firstRun ? (
          <View style={{ gap: theme.spacing.sm }}>
            <Step index={1} text={t.smsImport.howToSteps.open} />
            <Step index={2} text={t.smsImport.howToSteps.copy} />
            <Step index={3} text={t.smsImport.howToSteps.comeBack} />
          </View>
        ) : null}
        {/* Why there is no switch for this. Said only where it is true: a build
            that can read the inbox has the button below instead, and the
            sentence would contradict it. */}
        {readerOffered ? null : (
          <Text variant="caption" tone="muted">
            {t.smsImport.whyNotAutomatic}
          </Text>
        )}
      </Card>

      {readerOffered ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Button
            label={t.smsImport.readMessages}
            variant="secondary"
            onPress={() => router.push('/captures/messages')}
            icon={
              <Ionicons name="chatbubbles-outline" size={iconSize.md} color={theme.color.brand} />
            }
          />
          <Text variant="caption" tone="muted">
            {t.smsImport.readOnAndroid}
          </Text>
          {readMessages.length > 0 ? (
            <Text variant="caption" tone="muted">
              {plural(locale, readMessages.length, t.smsImport.readCount)}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={{ gap: theme.spacing.sm }}>
        <Card style={{ gap: theme.spacing.sm }}>
          <TextInput
            value={blob}
            onChangeText={edit}
            multiline
            autoCapitalize="none"
            accessibilityLabel={t.smsImport.pasteLabel}
            placeholder={t.smsImport.pastePlaceholder}
            placeholderTextColor={theme.color.textFaint}
            style={{
              minHeight: 140,
              fontSize: 16,
              color: theme.color.text,
              textAlignVertical: 'top',
            }}
          />
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="caption" tone="muted">
              {pastedBlocks.length === 0
                ? t.smsImport.nothingPasted
                : plural(locale, pastedBlocks.length, t.smsImport.messageCount)}
            </Text>
            {/* The only control while the box is empty, so it leads rather than
                sits in the corner as a ghost. */}
            <Button
              label={t.smsImport.paste}
              variant={blob.length === 0 ? 'secondary' : 'ghost'}
              onPress={() => void paste()}
            />
          </Row>
        </Card>
        {/* The blank-line rule, demoted. `splitMessages` finds the boundaries
            on its own now, so this is a hint offered once something has
            actually gone unread — never an instruction to get wrong up front. */}
        {notPayments > 0 ? (
          <Text variant="micro" tone="muted">
            {t.smsImport.runTogether}
          </Text>
        ) : null}
      </View>

      {/* Only over a list that has something in it. With nothing found, the
          empty state below carries the same two sentences and this would say
          them twice. */}
      {fresh.length > 0 ? (
        <View style={{ gap: theme.spacing.xs }}>
          {/* The count is the headline and the control sits beside it — one
              button with two labels rather than two buttons (Wallet). The
              count is live, and the button at the foot says the same number
              back as the thing it is about to do. */}
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="title" style={{ flex: 1 }}>
              {chosen.size === 0
                ? t.smsImport.nothingSelected
                : plural(locale, chosen.size, t.smsImport.chosenCount)}
            </Text>
            <Button
              label={allChosen ? t.smsImport.unselectAll : t.smsImport.selectAll}
              variant="ghost"
              onPress={toggleAll}
            />
          </Row>
          <Text variant="caption" tone="muted">
            {plural(locale, fresh.length, t.smsImport.foundCount)}
          </Text>
          {/* Everything the parser could not use, said plainly. A screen that
              quietly shows four rows for six messages reads as broken. */}
          {notPayments > 0 ? (
            <Text variant="caption" tone="muted">
              {plural(locale, notPayments, t.smsImport.someNotParsed)}
            </Text>
          ) : null}
          {alreadyCount > 0 ? (
            <Text variant="caption" tone="muted">
              {plural(locale, alreadyCount, t.smsImport.alreadyAdded)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const footer = (
    <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.lg }}>
      {error ? <Callout tone="negative">{error}</Callout> : null}
      {added !== null ? (
        <Callout tone="positive">{plural(locale, added, t.smsImport.addedDraftCount)}</Callout>
      ) : null}
      {/* Where they went, and a way to go there. A screen that says "added" and
          leaves a person on the same page has told them half of it. */}
      {done ? (
        <Button label={t.smsImport.openReview} onPress={() => router.replace('/captures')} />
      ) : (
        <Button
          label={
            saving
              ? t.smsImport.adding
              : chosen.size === 0
                ? t.smsImport.nothingSelected
                : plural(locale, chosen.size, t.smsImport.addDraftCount)
          }
          onPress={() => void add()}
          disabled={chosen.size === 0 || saving}
        />
      )}
    </View>
  );

  const renderItem = useCallback(
    ({ item }: { item: FoundItem }) => {
      if (item.kind === 'day') {
        return (
          <Text
            variant="micro"
            tone="muted"
            style={{
              textTransform: 'uppercase',
              marginTop: theme.spacing.md,
              marginBottom: theme.spacing.xs,
            }}
          >
            {dayHeading(locale, item.at)}
          </Text>
        );
      }
      const picked = chosen.has(item.candidate.dedupeKey);
      return (
        <View>
          <FoundRow
            candidate={item.candidate}
            body={item.body}
            picked={picked}
            open={opened[item.candidate.dedupeKey] ?? false}
            locale={locale}
            t={t}
            onToggle={() => toggle(item.candidate.dedupeKey, !picked)}
            onOpen={() => openMessage(item.candidate.dedupeKey)}
          />
          <Divider />
        </View>
      );
    },
    [chosen, locale, openMessage, opened, t, theme.spacing.md, theme.spacing.xs, toggle],
  );

  // One object so a tick *or* an opened message re-renders a row FlashList
  // would otherwise recycle unchanged.
  const listState = useMemo(() => ({ chosen, opened }), [chosen, opened]);

  return (
    <Screen edges={['top']}>
      <FlashList
        data={feed}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        getItemType={(item) => item.kind}
        // The group-ledger settings: `extraData` because a tick changes a row
        // that FlashList would otherwise recycle unchanged, and the drop
        // distance so a pasted month scrolls without blanking.
        extraData={listState}
        drawDistance={1500}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
        }}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={
          // Nothing handed over yet is not an empty result; it is a screen
          // waiting to be used, and the paste box above already says so. Nor is
          // a finished run: the footer is already saying where those went.
          (pastedBlocks.length === 0 && readMessages.length === 0) || done ? null : (
            <EmptyState
              title={t.smsImport.nothingToImport}
              // Why there is nothing, in the honest order: because you have
              // them already, or because none of it was a payment. Never a
              // blank list with no account of itself.
              body={
                alreadyCount > 0
                  ? plural(locale, alreadyCount, t.smsImport.alreadyAdded)
                  : t.smsImport.nothingLikeAPayment
              }
            />
          )
        }
      />
    </Screen>
  );
}
