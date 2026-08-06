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
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  IconButton,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { proposeFromSms, type ExpenseCandidate, type MemberId } from '@baaki/core';

import { useGroup, useGroupLedger } from '@/data/hooks';
import { planFromSms, toMutationPayload } from '@/data/importPlan';
import { displayName } from '@/data/types';
import { useStrings } from '@/i18n';
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
  const { locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  const { mutate } = useSync();

  const { group, members, expenses } = useGroup(groupId);
  const ledger = useGroupLedger(groupId, profile?.id ?? null);
  const { keys: alreadyImported, remember } = useImported(groupId);

  const [blob, setBlob] = useState('');
  const [from, setFrom] = useState(() => defaultFrom(expenses.data));
  const [to, setTo] = useState(() => today());
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [payer, setPayer] = useState<MemberId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const groupCurrency = group.data?.default_currency ?? 'INR';
  const memberRows = useMemo(() => members.data ?? [], [members.data]);
  const myMemberId = ledger.myMemberId ?? null;
  const effectivePayer = payer ?? myMemberId;
  const participants = useMemo(() => memberRows.map((member) => member.id), [memberRows]);

  const messages = useMemo(() => splitMessages(blob), [blob]);

  const candidates = useMemo(
    () =>
      proposeFromSms(
        messages.map((body) => ({ body, receivedAt: new Date().toISOString() })),
        { from, to, alreadyImported },
      ),
    [messages, from, to, alreadyImported],
  );

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
      setError('Choose who paid');
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
          'expense.create',
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
          <IconButton label="Close" onPress={() => router.back()}>
            <Ionicons name="close" size={22} color={theme.color.text} />
          </IconButton>
          <Text variant="subheading" style={{ marginLeft: theme.spacing.md }}>
            Import from messages
          </Text>
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            Open your messages app, select the bank messages from this trip, copy them, and paste
            them here. Baaki reads them on this phone — nothing is sent anywhere until you confirm
            an expense.
          </Text>
          <Text variant="micro" tone="faint">
            Baaki cannot read your inbox by itself. iPhones give no app that access, and on Android
            it is reserved for whichever app you use as your messages app.
          </Text>
        </Card>

        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title="The messages" />
          <Card style={{ gap: theme.spacing.sm }}>
            <TextInput
              value={blob}
              onChangeText={setBlob}
              multiline
              autoCapitalize="none"
              accessibilityLabel="Paste bank messages"
              placeholder={'Paste here.\n\nLeave a blank line between messages.'}
              placeholderTextColor={theme.color.textFaint}
              style={{
                minHeight: 140,
                fontSize: 15,
                color: theme.color.text,
                textAlignVertical: 'top',
              }}
            />
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="micro" tone="faint">
                {messages.length === 0
                  ? 'Nothing pasted yet'
                  : `${messages.length} message${messages.length === 1 ? '' : 's'}`}
              </Text>
              <Button label="Paste" variant="ghost" onPress={() => void paste()} />
            </Row>
          </Card>
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title="Between these dates" />
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="micro" tone="faint">
              Only payments inside this window are proposed, so the rest of your inbox stays out of
              the group.
            </Text>
            <Row style={{ gap: theme.spacing.md }}>
              <DateField label="From" value={from} onChange={setFrom} />
              <DateField label="To" value={to} onChange={setTo} />
            </Row>
            <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
              <Chip
                label="Last 7 days"
                onPress={() => {
                  setFrom(daysAgo(7));
                  setTo(today());
                }}
              />
              <Chip
                label="Last 30 days"
                onPress={() => {
                  setFrom(daysAgo(30));
                  setTo(today());
                }}
              />
            </Row>
          </Card>
        </View>

        {messages.length > 0 ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title="What was found" />
            {importable.length === 0 ? (
              <EmptyState
                title="Nothing to import"
                body={
                  candidates.length === 0
                    ? 'None of those messages looked like a payment inside these dates. Reminders, one-time passwords and money coming in are all left out on purpose.'
                    : 'Every payment found was in another currency.'
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
                        accessibilityLabel={`${candidate.merchant ?? 'Card payment'}, ${
                          picked ? 'selected' : 'not selected'
                        }`}
                      >
                        <ListRow
                          title={candidate.merchant ?? 'Card payment'}
                          subtitle={subtitleFor(candidate, locale)}
                          leading={
                            <Ionicons
                              name={picked ? 'checkbox' : 'square-outline'}
                              size={24}
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
                              {candidate.preselect ? null : <Badge label="Check this" />}
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
                  {otherCurrency.length} payment{otherCurrency.length === 1 ? ' was' : 's were'} in
                  another currency. Add {otherCurrency.length === 1 ? 'it' : 'them'} by hand — the
                  message does not say what rate you were charged, and this group keeps its money in{' '}
                  {groupCurrency}.
                </Text>
              </Card>
            ) : null}
          </View>
        ) : null}

        {importable.length > 0 ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title="Who paid" />
            <Card style={{ gap: theme.spacing.md }}>
              <Text variant="micro" tone="faint">
                A bank message says what left your account, not who was there. These are split
                equally between everyone in the group — change any of them afterwards.
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

        {error ? (
          <Text variant="caption" tone="negative">
            {error}
          </Text>
        ) : null}

        {saved !== null ? (
          <Card>
            <Text variant="caption">
              {saved} expense{saved === 1 ? '' : 's'} added. They are saved on this phone and will
              sync when there is a connection.
            </Text>
          </Card>
        ) : null}

        <Button
          label={
            saving
              ? 'Adding…'
              : selected.length === 0
                ? 'Nothing selected'
                : `Add ${selected.length} expense${selected.length === 1 ? '' : 's'}`
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
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text variant="micro" tone="faint">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        keyboardType="numbers-and-punctuation"
        accessibilityLabel={`${label} date, year month day`}
        placeholder="YYYY-MM-DD"
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

/**
 * The group's own history is a better guess at "the trip" than a fixed number
 * of days: a group made for last month's holiday should not open on a window
 * that contains none of it.
 */
function defaultFrom(expenses: { created_at?: string }[] | undefined): string {
  const earliest = (expenses ?? [])
    .map((expense) => String(expense.created_at ?? ''))
    .filter(Boolean)
    .sort()[0];
  return earliest ? earliest.slice(0, 10) : daysAgo(30);
}
