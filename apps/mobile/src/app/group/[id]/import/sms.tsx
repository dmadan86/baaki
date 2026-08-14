/**
 * Bank messages into expenses.
 *
 * The obvious version of this screen reads the inbox by itself. It cannot:
 * iOS has no API that lets an app read SMS at all, and on Android `READ_SMS`
 * is a restricted permission that Google Play grants only to apps that are the
 * user's default SMS handler. Baaki is not going to be somebody's SMS app, so
 * the honest design is the one where they hand over the messages.
 *
 * What is imported still goes nowhere near a server. Parsing is on-device
 * (packages/core/src/sms) because a bank message carries an account tail, a
 * balance, and sometimes a one-time password — sending that anywhere to be
 * read would be a worse trade than the feature is worth (ADR-013).
 *
 * Nothing here writes on its own. Every candidate is confirmed by a person
 * before it becomes an expense, which is also what makes the parser's refusals
 * safe: when it cannot tell a payment from a reminder it drops the message,
 * and a dropped message costs a person one manual entry rather than putting an
 * expense nobody made into a shared ledger.
 */

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import {
  Badge,
  Button,
  Callout,
  Card,
  Chip,
  EmptyState,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import {
  MutationKind,
  proposeFromSms,
  type ExpenseCandidate,
  type MemberId,
  type SmsMessage,
} from '@baaki/core';

import { useGroup, useGroupLedger } from '@/data/hooks';
import { planFromSms, toMutationPayload } from '@/data/importPlan';
import { smsWindowFor } from '@/data/smsWindow';
import { displayName } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useFlagEnabled } from '@/lib/flags';
import { readSms, SmsReadFailure } from '@/lib/smsReader';
import { useAuth } from '@/lib/auth';
import { importMutationId } from '@/lib/importId';
import { useImported } from '@/lib/imported';
import { useSync } from '@/sync/provider';

/**
 * Messages are separated by a blank line. A single SMS wraps over several
 * lines of its own, so splitting on every newline would cut most of them in
 * half — and half a message parses to either nothing or, worse, a smaller
 * amount. The count is shown before anything is parsed so a bad paste is
 * visible rather than silently producing two candidates from six messages.
 */
function splitMessages(blob: string): string[] {
  return blob
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export default function ImportSmsScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  const { mutate } = useSync();

  const { group, members, expenses } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const { keys: alreadyImported, remember } = useImported(groupId);

  const [blob, setBlob] = useState('');
  // The window defaults to the trip's own dates (smsWindowFor) and is overridden
  // only by an explicit edit. Derived during render rather than stored, so it
  // follows the group loading in without an effect that has to race it — "track
  // the expenses between the dates of the travel" is simply the default state.
  const trip = useMemo(() => smsWindowFor(group.data, expenses.data), [group.data, expenses.data]);
  const [fromEdit, setFromEdit] = useState<string | null>(null);
  const [toEdit, setToEdit] = useState<string | null>(null);
  const from = fromEdit ?? trip.from;
  const to = toEdit ?? trip.to;

  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [payer, setPayer] = useState<MemberId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  // Messages read from the Android inbox, kept apart from the pasted ones so
  // each keeps its real received time — a dateless bank SMS is filed on the day
  // it arrived, which the paste flow (received "now") cannot know.
  const [readMessages, setReadMessages] = useState<SmsMessage[]>([]);
  const [reading, setReading] = useState(false);
  // The inbox reader is off until this flag is switched on from the console: the
  // READ_SMS permission and the native reader ship dormant, so the store build
  // is paste-only and the capability rolls out to a cohort without a release.
  const smsReadEnabled = useFlagEnabled('sms_inbox_read');

  const groupCurrency = group.data?.default_currency ?? 'INR';
  const memberRows = useMemo(() => members.data ?? [], [members.data]);
  const myMemberId = ledger.myMemberId ?? null;
  const effectivePayer = payer ?? myMemberId;
  const participants = useMemo(() => memberRows.map((member) => member.id), [memberRows]);

  const messages = useMemo(() => splitMessages(blob), [blob]);

  // The read inbox first (real timestamps), then anything pasted. proposeFromSms
  // dedupes across the two, so a message that was both read and pasted collapses.
  const allMessages = useMemo(
    () => [
      ...readMessages,
      ...messages.map((body) => ({ body, receivedAt: new Date().toISOString() })),
    ],
    [readMessages, messages],
  );

  const candidates = useMemo(
    () => proposeFromSms(allMessages, { from, to, alreadyImported }),
    [allMessages, from, to, alreadyImported],
  );

  const readInbox = async (): Promise<void> => {
    setError(null);
    setReading(true);
    try {
      const result = await readSms({ from, to });
      if (result.ok) {
        setReadMessages(result.messages);
        setError(result.messages.length === 0 ? t.smsImport.readNothing : null);
      } else {
        setError(readFailureMessage(result.reason, t));
      }
    } finally {
      setReading(false);
    }
  };

  // A message in another currency needs a rate, and the rate is not in the
  // message. Rather than invent one, these are named and left for the add
  // screen, which can ask for a rate and record where it came from (ADR-003).
  const importable = candidates.filter((item) => item.amount.currency === groupCurrency);
  const otherCurrency = candidates.filter((item) => item.amount.currency !== groupCurrency);

  const selected = importable.filter((item) => chosen[item.dedupeKey] ?? item.preselect);

  const paste = async (): Promise<void> => {
    const text = await Clipboard.getStringAsync();
    setBlob((current) => (current ? `${current}\n\n${text}` : text));
  };

  const confirm = async (): Promise<void> => {
    if (!effectivePayer) {
      setError(t.expense.chooseWhoPaid);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      for (const candidate of selected) {
        const plan = planFromSms(candidate, {
          payer: effectivePayer,
          participants,
        });
        // Both ids come from the message itself, so importing the same message
        // twice produces the same mutation — which the write path answers with
        // the expense it already wrote, not a second one.
        const expenseId = await importMutationId(groupId, `expense:${plan.seed}`);
        const clientMutationId = await importMutationId(groupId, plan.seed);
        await mutate(
          MutationKind.ExpenseCreate,
          groupId,
          toMutationPayload(plan, { expenseId }),
          clientMutationId,
        );
      }
      await remember(selected.map((item) => item.dedupeKey));
      setSaved(selected.length);
      setBlob('');
      setChosen({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (group.isLoading || members.isLoading) {
    return (
      <Screen>
        <View style={{ padding: theme.spacing.xl }}>
          <ActivityIndicator color={theme.color.brand} />
        </View>
      </Screen>
    );
  }

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
            <Ionicons name="close" size={iconSize.xl} color={theme.color.text} />
          </IconButton>
          <Text variant="subheading" style={{ marginLeft: theme.spacing.md }}>
            {t.smsImport.title}
          </Text>
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.smsImport.howTo}
          </Text>
          <Text variant="micro" tone="muted">
            {t.smsImport.whyNotAutomatic}
          </Text>
        </Card>

        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.smsImport.messagesSection} />
          <Card style={{ gap: theme.spacing.sm }}>
            <TextInput
              value={blob}
              onChangeText={setBlob}
              multiline
              autoCapitalize="none"
              accessibilityLabel={t.smsImport.pasteLabel}
              placeholder={t.smsImport.pastePlaceholder}
              placeholderTextColor={theme.color.textFaint}
              style={{
                minHeight: 140,
                fontSize: 15,
                color: theme.color.text,
                textAlignVertical: 'top',
              }}
            />
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="micro" tone="muted">
                {messages.length === 0
                  ? t.smsImport.nothingPasted
                  : plural(locale, messages.length, t.smsImport.messageCount)}
              </Text>
              <Button label={t.smsImport.paste} variant="ghost" onPress={() => void paste()} />
            </Row>

            {/* Android + flag on: read the inbox for this window instead of
                pasting. Absent everywhere else (iOS, Expo Go, any build without
                the reader, or the flag off) — smsReader answers a build that
                cannot read with a sentence, not a crash. */}
            {Platform.OS === 'android' && smsReadEnabled ? (
              <View style={{ gap: theme.spacing.sm }}>
                <View style={{ height: 1, backgroundColor: theme.color.border }} />
                <Button
                  label={reading ? t.smsImport.reading : t.smsImport.readMessages}
                  variant="secondary"
                  disabled={reading}
                  onPress={() => void readInbox()}
                  icon={
                    <Ionicons
                      name="chatbubbles-outline"
                      size={iconSize.md}
                      color={theme.color.brand}
                    />
                  }
                />
                <Text variant="micro" tone="muted">
                  {t.smsImport.readOnAndroid}
                </Text>
                {readMessages.length > 0 ? (
                  <Text variant="micro" tone="muted">
                    {plural(locale, readMessages.length, t.smsImport.readCount)}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Card>
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.smsImport.datesSection} />
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="micro" tone="muted">
              {t.smsImport.datesNote}
            </Text>
            <Row style={{ gap: theme.spacing.md }}>
              <DateField label={t.smsImport.from} value={from} onChange={setFromEdit} />
              <DateField label={t.smsImport.to} value={to} onChange={setToEdit} />
            </Row>
            <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
              <Chip
                label={t.smsImport.last7}
                onPress={() => {
                  setFromEdit(daysAgo(7));
                  setToEdit(today());
                }}
              />
              <Chip
                label={t.smsImport.last30}
                onPress={() => {
                  setFromEdit(daysAgo(30));
                  setToEdit(today());
                }}
              />
            </Row>
          </Card>
        </View>

        {allMessages.length > 0 ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title={t.smsImport.foundSection} />
            {importable.length === 0 ? (
              <EmptyState
                title={t.smsImport.nothingToImport}
                body={
                  candidates.length === 0
                    ? t.smsImport.nothingLikeAPayment
                    : t.smsImport.allAnotherCurrency
                }
              />
            ) : (
              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {importable.map((candidate, index) => {
                  const picked = chosen[candidate.dedupeKey] ?? candidate.preselect;
                  return (
                    <View key={candidate.dedupeKey}>
                      <Pressable
                        onPress={() =>
                          setChosen((current) => ({
                            ...current,
                            [candidate.dedupeKey]: !picked,
                          }))
                        }
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: picked }}
                        accessibilityLabel={`${candidate.merchant ?? t.smsImport.cardPayment}, ${
                          picked ? t.smsImport.selected : t.smsImport.notSelected
                        }`}
                      >
                        <ListRow
                          title={candidate.merchant ?? t.smsImport.cardPayment}
                          subtitle={subtitleFor(candidate, locale)}
                          leading={
                            <Ionicons
                              name={picked ? 'checkbox' : 'square-outline'}
                              size={iconSize.xxl}
                              color={picked ? theme.color.brand : theme.color.textFaint}
                            />
                          }
                          trailing={
                            <View style={{ alignItems: 'flex-end', gap: 2 }}>
                              <MoneyText
                                amount={candidate.amount.minor}
                                currency={candidate.amount.currency}
                                locale={locale}
                                variant="subheading"
                              />
                              {candidate.preselect ? null : <Badge label={t.smsImport.checkThis} />}
                            </View>
                          }
                        />
                      </Pressable>
                      {index < importable.length - 1 ? (
                        <View style={{ height: 1, backgroundColor: theme.color.border }} />
                      ) : null}
                    </View>
                  );
                })}
              </Card>
            )}

            {otherCurrency.length > 0 ? (
              <Card>
                <Text variant="caption" tone="muted">
                  {plural(locale, otherCurrency.length, t.smsImport.otherCurrencyNote).replace(
                    '{currency}',
                    groupCurrency,
                  )}
                </Text>
              </Card>
            ) : null}
          </View>
        ) : null}

        {importable.length > 0 ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title={t.smsImport.whoPaidSection} />
            <Card style={{ gap: theme.spacing.md }}>
              <Text variant="micro" tone="muted">
                {t.smsImport.whoPaidNote}
              </Text>
              <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                {memberRows.map((member) => (
                  <Chip
                    key={member.id}
                    label={displayName(member, profile?.id)}
                    selected={member.id === effectivePayer}
                    onPress={() => setPayer(member.id)}
                  />
                ))}
              </Row>
            </Card>
          </View>
        ) : null}

        {error ? <Callout tone="negative">{error}</Callout> : null}

        {saved !== null ? (
          <Card>
            <Text variant="caption">{plural(locale, saved, t.smsImport.addedCount)}</Text>
          </Card>
        ) : null}

        <Button
          label={
            saving
              ? t.smsImport.adding
              : selected.length === 0
                ? t.smsImport.nothingSelected
                : plural(locale, selected.length, t.smsImport.addCount)
          }
          onPress={() => void confirm()}
          disabled={selected.length === 0 || saving}
        />
      </ScrollView>
    </Screen>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useStrings();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text variant="micro" tone="muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        keyboardType="numbers-and-punctuation"
        accessibilityLabel={t.smsImport.dateFieldLabel.replace('{label}', label)}
        placeholder={t.smsImport.datePlaceholder}
        placeholderTextColor={theme.color.textFaint}
        style={{ fontSize: 16, color: theme.color.text, paddingVertical: theme.spacing.xs }}
      />
    </View>
  );
}

function subtitleFor(candidate: ExpenseCandidate, locale: string): string {
  const when = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(
    new Date(candidate.at),
  );
  const parts = [when];
  if (candidate.dateInferred) parts.push('date not in the message');
  if (candidate.accountTail) parts.push(`⋯${candidate.accountTail}`);
  return parts.join(' · ');
}

const today = (): string => new Date().toISOString().slice(0, 10);

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** Why the inbox could not be read, said in a way a person can act on. */
function readFailureMessage(reason: SmsReadFailure, t: ReturnType<typeof useStrings>['t']): string {
  switch (reason) {
    case SmsReadFailure.Denied:
      return t.smsImport.permissionDenied;
    case SmsReadFailure.Blocked:
      return t.smsImport.permissionBlocked;
    case SmsReadFailure.Unsupported:
      return t.smsImport.readUnsupported;
    case SmsReadFailure.Unavailable:
      return t.smsImport.readUnavailable;
    case SmsReadFailure.Failed:
      return t.smsImport.readFailed;
  }
}
