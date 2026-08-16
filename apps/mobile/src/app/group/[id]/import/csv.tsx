/**
 * A Splitwise export into this group.
 *
 * The work here is the mapping, not the parsing. A CSV names people as text;
 * a group has member ids, and getting that wrong does not fail loudly — it
 * puts somebody else's share on your name and the numbers still add up. So no
 * name is matched automatically unless it is exactly a member's name, nothing
 * is imported until every column has a person against it, and a name with
 * nobody chosen refuses rather than being dropped.
 *
 * The other half is what is *not* imported. `importSplitwiseCsv` names every
 * row it could not read — a row whose columns do not sum to zero is skipped
 * rather than adjusted into shape, because adjusting it would silently move
 * money. Those rows are shown here, by number, so they can be added by hand.
 */

import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { randomUUID } from 'expo-crypto';

import {
  Badge,
  Button,
  Callout,
  Card,
  Chip,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
  useScreenClearance,
} from '@baaki/ui';

import { importSplitwiseCsv, MutationKind, type MemberId, type SplitwiseImport } from '@baaki/core';

import { useGroup } from '@/data/hooks';
import { planFromCsv, toMutationPayload, UnmappedPersonError } from '@/data/importPlan';
import { displayName } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { importMutationId } from '@/lib/importId';
import { useSync } from '@/sync/provider';

/** A new person to create for a CSV column, rather than pointing it at somebody who exists. */
const NEW_PERSON = '__new__';

export default function ImportCsvScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t, locale } = useStrings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const { profile } = useAuth();
  const { mutate } = useSync();

  const { group, members } = useGroup(groupId);

  const [file, setFile] = useState<string | null>(null);
  const [parsed, setParsed] = useState<SplitwiseImport | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const groupCurrency = group.data?.default_currency ?? 'INR';
  const memberRows = members.data ?? [];

  const pick = async (): Promise<void> => {
    setError(null);
    setSaved(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        // Some file providers hand a CSV over as text/plain or as an octet
        // stream. Refusing those would reject files that are perfectly fine.
        type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets[0]) return;

      const asset = picked.assets[0];
      const contents = new FileSystem.File(asset.uri).textSync();
      const result = importSplitwiseCsv(contents);

      setFile(asset.name);
      setParsed(result);
      // Only an exact name match is pre-filled. A fuzzy guess here would be a
      // guess about whose money this is.
      setMapping(
        Object.fromEntries(
          result.people.flatMap((person) => {
            const match = memberRows.find(
              (member) =>
                displayName(member, profile?.id).trim().toLowerCase() ===
                person.trim().toLowerCase(),
            );
            return match ? [[person, match.id]] : [];
          }),
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const unmapped = useMemo(
    () => (parsed?.people ?? []).filter((person) => !mapping[person]),
    [parsed, mapping],
  );

  const currencyMatches = !parsed || parsed.currency === groupCurrency;
  const canImport =
    parsed !== null && parsed.expenses.length > 0 && unmapped.length === 0 && currencyMatches;

  const run = async (): Promise<void> => {
    if (!parsed) return;
    setError(null);
    setSaving(true);
    try {
      // Anybody the file names who is not in the group yet becomes a member
      // first, with an id generated here. The id goes into the queue with the
      // add, so the expenses that follow can name them even offline — the
      // server keeps the id we chose rather than making its own (ADR-005).
      const resolved: Record<string, MemberId> = {};
      for (const person of parsed.people) {
        const choice = mapping[person];
        if (choice === NEW_PERSON) {
          const memberId = randomUUID();
          await mutate(MutationKind.MemberAddGhost, groupId, { name: person, memberId });
          resolved[person] = memberId;
        } else if (choice) {
          resolved[person] = choice;
        }
      }

      for (const [index, expense] of parsed.expenses.entries()) {
        const plan = planFromCsv(expense, resolved, index);
        const expenseId = await importMutationId(groupId, `expense:${plan.seed}`);
        const clientMutationId = await importMutationId(groupId, plan.seed);
        await mutate(
          MutationKind.ExpenseCreate,
          groupId,
          toMutationPayload(plan, { expenseId }),
          clientMutationId,
        );
      }

      setSaved(parsed.expenses.length);
      setParsed(null);
      setFile(null);
      setMapping({});
    } catch (caught) {
      setError(
        caught instanceof UnmappedPersonError
          ? t.importLedger.chooseWhoIs.replace('{name}', caught.person)
          : caught instanceof Error
            ? caught.message
            : String(caught),
      );
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
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.xl} color={theme.color.text} />
          </IconButton>
          <Text variant="subheading" style={{ marginLeft: theme.spacing.md }}>
            {t.importLedger.splitwiseTitle}
          </Text>
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {t.importLedger.splitwiseHowTo}
          </Text>
          <Button
            label={
              file ? t.importLedger.chosenFile.replace('{name}', file) : t.importLedger.chooseFile
            }
            onPress={() => void pick()}
          />
        </Card>

        {saved !== null ? (
          <Card>
            <Text variant="caption">{plural(locale, saved, t.importLedger.importedCount)}</Text>
          </Card>
        ) : null}

        {parsed ? (
          <>
            {!currencyMatches ? (
              <Card>
                <Text variant="caption" tone="negative">
                  {t.misc.csvCurrencyMismatch
                    .replace(/\{fileCur\}/g, parsed.currency)
                    .replace('{groupCur}', groupCurrency)}
                </Text>
              </Card>
            ) : null}

            <View style={{ gap: theme.spacing.sm }}>
              <SectionHeader title={t.importLedger.whoIsWho} />
              <Card style={{ gap: theme.spacing.lg }}>
                <Text variant="micro" tone="muted">
                  {t.importLedger.whoIsWhoNote}
                </Text>
                {parsed.people.map((person) => (
                  <View key={person} style={{ gap: theme.spacing.xs }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text variant="body">{person}</Text>
                      <MoneyText
                        amount={parsed.balances[person] ?? 0n}
                        currency={parsed.currency}
                        locale={locale}
                        variant="caption"
                        mode="balance"
                      />
                    </Row>
                    <Row style={{ gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                      {memberRows.map((member) => (
                        <Chip
                          key={member.id}
                          label={displayName(member, profile?.id)}
                          selected={mapping[person] === member.id}
                          onPress={() =>
                            setMapping((current) => ({ ...current, [person]: member.id }))
                          }
                        />
                      ))}
                      <Chip
                        label={t.importLedger.addAsNew}
                        selected={mapping[person] === NEW_PERSON}
                        onPress={() =>
                          setMapping((current) => ({ ...current, [person]: NEW_PERSON }))
                        }
                      />
                    </Row>
                  </View>
                ))}
              </Card>
            </View>

            <View style={{ gap: theme.spacing.sm }}>
              <SectionHeader
                title={plural(locale, parsed.expenses.length, t.importLedger.expenseCount)}
              />
              <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                {parsed.expenses.slice(0, 20).map((expense, index) => (
                  <View key={`${expense.date}-${expense.description}-${index}`}>
                    <ListRow
                      title={expense.description}
                      subtitle={expense.date}
                      trailing={
                        <MoneyText
                          amount={expense.amount}
                          currency={expense.currency}
                          locale={locale}
                          variant="caption"
                        />
                      }
                    />
                    {index < Math.min(parsed.expenses.length, 20) - 1 ? (
                      <View style={{ height: 1, backgroundColor: theme.color.border }} />
                    ) : null}
                  </View>
                ))}
              </Card>
              {parsed.expenses.length > 20 ? (
                <Text variant="micro" tone="muted">
                  {t.importLedger.andMore.replace('{n}', String(parsed.expenses.length - 20))}
                </Text>
              ) : null}
            </View>

            {parsed.problems.length > 0 ? (
              <View style={{ gap: theme.spacing.sm }}>
                <SectionHeader title={t.importLedger.rowsLeftOut} />
                <Card style={{ gap: theme.spacing.sm }}>
                  <Text variant="micro" tone="muted">
                    {t.importLedger.rowsLeftOutNote}
                  </Text>
                  {parsed.problems.map((problem, index) => (
                    <Row key={index} style={{ gap: theme.spacing.sm }}>
                      <Badge
                        label={
                          problem.row
                            ? t.importLedger.rowNumber.replace('{n}', String(problem.row))
                            : t.importLedger.fileWide
                        }
                      />
                      <Text variant="micro" tone="muted" style={{ flex: 1 }}>
                        {problem.message}
                      </Text>
                    </Row>
                  ))}
                </Card>
              </View>
            ) : null}
          </>
        ) : null}

        {error ? <Callout tone="negative">{error}</Callout> : null}

        {parsed ? (
          <Button
            label={
              saving
                ? t.importLedger.importing
                : unmapped.length > 0
                  ? unmapped.length === 1
                    ? t.importLedger.chooseWhoIs.replace('{name}', unmapped[0])
                    : plural(locale, unmapped.length, t.importLedger.chooseWhoArePlural)
                  : plural(locale, parsed.expenses.length, t.importLedger.importCount)
            }
            onPress={() => void run()}
            disabled={!canImport || saving}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}
