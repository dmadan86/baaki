/**
 * Bringing a ledger in — from Splitwise, or from Baaki itself (ADR-012).
 *
 * The parsing is the easy half and lives in `packages/core`. This screen is the
 * other half: deciding which name in the file is which person here, and being
 * straight about what each kind of file does and does not contain.
 *
 * A **Splitwise** export holds each person's *net* for every row. It does not
 * hold who paid — many (paid, owed) pairs produce the same net, and the file
 * keeps none of them. Balances come across to the paisa; the payer on each row
 * is a deterministic reconstruction, and the preview says so in those words,
 * because somebody who later opens a row and finds they apparently paid for a
 * dinner they did not pay for deserves to have been told first.
 *
 * A **Baaki** export holds the real (paid, owed) pair and the settlements
 * besides, so nothing is reconstructed. What still does not survive is stated
 * in ./import's own words on screen: ids, edit history and settlement
 * allocations are new, and that is what "lossless" honestly covers (M5).
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import {
  importSplitwiseCsv,
  isBaakiExport,
  parseBaakiExport,
  type BaakiImportGroup,
  type BaakiImportSettlement,
  type ImportProblem,
} from '@baaki/core';
import {
  Badge,
  Button,
  Callout,
  Card,
  ChipRow,
  directionalIcon,
  Divider,
  IconButton,
  iconSize,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { createGroup, fetchMembers, importLedger, type ImportPerson } from '@/data/api';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useGroups } from '@/data/hooks';
import { displayName, groupLabel, GroupType, type MemberRow } from '@/data/types';
import { useAuth } from '@/lib/auth';

/** What a column in the file has been mapped to. */
type Mapping = { kind: 'me' } | { kind: 'member'; memberId: string } | { kind: 'ghost' };

const NEW_GROUP = 'new';

/**
 * The two file formats, flattened to what this screen needs.
 *
 * They differ in exactly two ways that matter here — whether the payer is real
 * or reconstructed, and whether settlements came along — so one shape with two
 * origins beats two screens that drift apart.
 */
interface Loaded {
  origin: 'splitwise' | 'baaki';
  /** What to call the group if a new one is made. */
  suggestedName: string;
  people: readonly string[];
  currency: string;
  expenses: readonly {
    description: string;
    category: string | null;
    date: string;
    currency: string;
    amount: bigint;
    payers: Readonly<Record<string, bigint>>;
    shares: Readonly<Record<string, bigint>>;
  }[];
  settlements: readonly BaakiImportSettlement[];
  /** Net per person in `currency`. Other currencies are counted but not shown. */
  balances: Readonly<Record<string, bigint>>;
  /** Currencies in the file beyond the main one, so the preview can say so. */
  otherCurrencies: readonly string[];
  problems: readonly ImportProblem[];
}

function fromBaaki(group: BaakiImportGroup, fallbackName: string): Loaded {
  const currencies = [...new Set(group.expenses.map((expense) => expense.currency))];
  return {
    origin: 'baaki',
    suggestedName: group.name ?? fallbackName,
    people: group.people,
    currency: group.currency,
    expenses: group.expenses,
    settlements: group.settlements,
    balances: group.balances[group.currency] ?? {},
    otherCurrencies: currencies.filter((currency) => currency !== group.currency),
    problems: group.problems,
  };
}

export default function ImportScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const groups = useGroups();
  const { profile } = useAuth();

  const [file, setFile] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Loaded | null>(null);
  /**
   * A Baaki export can hold every group somebody is in. Importing them all in
   * one go would need one who-is-who mapping per group on one screen, which is
   * how somebody puts a stranger's history into the wrong ledger. One at a
   * time, chosen deliberately.
   */
  const [fileGroups, setFileGroups] = useState<readonly BaakiImportGroup[]>([]);
  const [target, setTarget] = useState<string>(NEW_GROUP);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, Mapping>>({});
  /**
   * Generated once per parsed file and reused on every retry. This is what
   * makes a second tap after a dropped connection a replay rather than a
   * duplicate import (ADR-005).
   */
  const [mutationIds, setMutationIds] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    groupId: string;
    expenses: number;
    ghosts: number;
    settlements: number;
  } | null>(null);

  /** Everyone starts as somebody new — see `load`. */
  const load = (loaded: Loaded): void => {
    setParsed(loaded);
    setMutationIds([...loaded.expenses, ...loaded.settlements].map(() => randomUUID()));
    // Claiming a name as yourself is a deliberate act. Guessing by name would
    // silently merge your ledger with a stranger who shares your first name.
    setMapping(Object.fromEntries(loaded.people.map((person) => [person, { kind: 'ghost' }])));
    setTarget(NEW_GROUP);
    setMembers([]);
  };

  const choose = async (): Promise<void> => {
    setError(null);
    setDone(null);

    const picked = await DocumentPicker.getDocumentAsync({
      // Some Android file providers hand back `application/octet-stream` for a
      // .csv, so text/* is allowed too rather than hiding the file the person
      // came here to select.
      type: [
        'text/csv',
        'text/comma-separated-values',
        'text/plain',
        'application/json',
        'application/octet-stream',
      ],
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return;

    const asset = picked.assets[0];
    if (!asset) return;

    setBusy(true);
    setFileGroups([]);
    setParsed(null);
    try {
      const text = new FileSystem.File(asset.uri).textSync();
      setFile(asset.name);

      // Asked of the contents, not the extension: a file saved from a browser
      // or shared through a chat app arrives named all sorts of things.
      if (isBaakiExport(text)) {
        const result = parseBaakiExport(text);
        if (result.problems.length > 0) {
          setError(result.problems[0]!.message);
          return;
        }
        const fallback = asset.name.replace(/\.json$/i, '');
        setFileGroups(result.groups);
        if (result.groups[0]) load(fromBaaki(result.groups[0], fallback));
        return;
      }

      const result = importSplitwiseCsv(text);
      load({
        origin: 'splitwise',
        suggestedName: asset.name.replace(/\.csv$/i, '') || t.importLedger.importedGroup,
        people: result.people,
        currency: result.currency,
        expenses: result.expenses,
        settlements: [],
        balances: result.balances,
        otherCurrencies: [],
        problems: result.problems,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const chooseTarget = async (groupId: string): Promise<void> => {
    setTarget(groupId);
    setMapping((current) =>
      Object.fromEntries(Object.keys(current).map((person) => [person, { kind: 'ghost' }])),
    );
    setMembers(groupId === NEW_GROUP ? [] : await fetchMembers(groupId));
  };

  /** Cycle a column through: new person → you → each existing member → back. */
  const cycle = (person: string): void => {
    setMapping((current) => {
      const now = current[person] ?? { kind: 'ghost' };
      const others = members.filter((member) => member.profile_id !== profile?.id);

      let next: Mapping;
      if (now.kind === 'ghost') next = { kind: 'me' };
      else if (now.kind === 'me')
        next = others[0] ? { kind: 'member', memberId: others[0].id } : { kind: 'ghost' };
      else {
        const index = others.findIndex((member) => member.id === now.memberId);
        const following = others[index + 1];
        next = following ? { kind: 'member', memberId: following.id } : { kind: 'ghost' };
      }

      // One column at most can be you; taking the badge takes it from whoever
      // held it, rather than importing two of you and halving your balance.
      const cleared =
        next.kind === 'me'
          ? Object.fromEntries(
              Object.entries(current).map(([key, value]) =>
                value.kind === 'me' ? [key, { kind: 'ghost' } as Mapping] : [key, value],
              ),
            )
          : current;
      return { ...cleared, [person]: next };
    });
  };

  const describeMapping = (person: string): string => {
    const chosen = mapping[person] ?? { kind: 'ghost' };
    if (chosen.kind === 'me') return t.account.you;
    if (chosen.kind === 'ghost') return t.importLedger.newPerson;
    const member = members.find((one) => one.id === chosen.memberId);
    return member ? displayName(member, profile?.id) : t.importLedger.newPerson;
  };

  const claimedByMe = Object.values(mapping).some((value) => value.kind === 'me');

  const run = async (): Promise<void> => {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      let groupId = target;
      if (groupId === NEW_GROUP) {
        groupId = await createGroup({
          name: parsed.suggestedName || t.importLedger.importedGroup,
          type: GroupType.Other,
          currency: parsed.currency,
        });
      }

      // Whoever is "you" maps to your own membership in the target group; the
      // server resolves the rest, so a null memberId means "make a ghost".
      const mine = (await fetchMembers(groupId)).find(
        (member) => member.profile_id === profile?.id,
      );

      const people: ImportPerson[] = parsed.people.map((person) => {
        const chosen = mapping[person] ?? { kind: 'ghost' };
        if (chosen.kind === 'me') return { name: person, memberId: mine?.id ?? null };
        if (chosen.kind === 'member') return { name: person, memberId: chosen.memberId };
        return { name: person, memberId: null };
      });

      const result = await importLedger({
        groupId,
        people,
        origin: parsed.origin,
        expenses: parsed.expenses.map((expense, index) => ({
          clientMutationId: mutationIds[index] ?? randomUUID(),
          description: expense.description,
          category: expense.category,
          date: expense.date,
          currency: expense.currency,
          amount: expense.amount,
          payers: expense.payers,
          shares: expense.shares,
        })),
        settlements: parsed.settlements.map((settlement, index) => ({
          clientMutationId: mutationIds[parsed.expenses.length + index] ?? randomUUID(),
          from: settlement.from,
          to: settlement.to,
          currency: settlement.currency,
          amount: settlement.amount,
          method: settlement.method,
          status: settlement.status,
          note: settlement.note,
          at: settlement.at,
        })),
      });

      setDone({
        groupId,
        expenses: result.expenses,
        ghosts: result.ghosts,
        settlements: result.settlements ?? 0,
      });
      void groups.refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.importLedger.ledgerTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">{t.importLedger.bringHistory}</Text>
            <Badge label={t.importLedger.free} tone="positive" />
          </Row>
          <Text variant="caption" tone="muted">
            {t.importLedger.ledgerHowTo}
          </Text>
        </Card>

        <Button
          label={file ? t.importLedger.chooseDifferentFile : t.importLedger.chooseFile}
          size="lg"
          fullWidth
          variant={file ? 'secondary' : 'primary'}
          disabled={busy}
          onPress={() => void choose()}
          icon={
            <Ionicons
              name="document-attach-outline"
              size={iconSize.md}
              color={file ? theme.color.brand : theme.color.onBrand}
            />
          }
        />

        {busy && !parsed ? <ActivityIndicator color={theme.color.brand} /> : null}

        {/* A file holding several groups: one at a time, chosen here. */}
        {fileGroups.length > 1 && !done ? (
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader title={t.importLedger.whichGroup} />
            <ChipRow<string>
              value={parsed?.suggestedName ?? ''}
              onChange={(name) => {
                const chosen = fileGroups.find(
                  (group, index) => (group.name ?? numberedGroup(t, index)) === name,
                );
                if (chosen) load(fromBaaki(chosen, name));
              }}
              options={fileGroups.map((group, index) => ({
                value: group.name ?? numberedGroup(t, index),
                label: `${group.name ?? numberedGroup(t, index)} · ${group.expenses.length}`,
              }))}
            />
          </View>
        ) : null}

        {parsed && !done ? (
          <>
            <Card style={{ gap: theme.spacing.sm }}>
              <Text variant="subheading">{file}</Text>
              <Text variant="caption" tone="muted">
                {plural(locale, parsed.expenses.length, t.importLedger.expenseCount)}
                {parsed.settlements.length > 0
                  ? ` · ${plural(locale, parsed.settlements.length, t.importLedger.settlementCount)}`
                  : ''}{' '}
                · {plural(locale, parsed.people.length, t.importLedger.peopleCount)} ·{' '}
                {parsed.currency}
              </Text>

              <Divider />

              <Text variant="caption" tone="muted">
                {parsed.origin === 'baaki'
                  ? t.importLedger.fromBaakiNote
                  : t.importLedger.fromSplitwiseNote}
              </Text>

              {parsed.otherCurrencies.length > 0 ? (
                <Text variant="micro" tone="faint">
                  {t.importLedger.otherCurrenciesNote
                    .replace('{currency}', parsed.currency)
                    .replace('{others}', parsed.otherCurrencies.join(', '))}
                </Text>
              ) : null}
            </Card>

            {parsed.problems.length > 0 ? (
              <Card style={{ gap: theme.spacing.sm }}>
                <Text variant="subheading" tone="negative">
                  {plural(locale, parsed.problems.length, t.importLedger.rowsSkipped)}
                </Text>
                {parsed.problems.slice(0, 6).map((problem) => (
                  <Text key={`${problem.kind}-${problem.row}`} variant="caption" tone="muted">
                    {problem.message}
                  </Text>
                ))}
                {parsed.problems.length > 6 ? (
                  <Text variant="micro" tone="faint">
                    {t.importLedger.andMore.replace('{n}', String(parsed.problems.length - 6))}
                  </Text>
                ) : null}
              </Card>
            ) : null}

            {parsed.expenses.length > 0 ? (
              <View>
                <SectionHeader title={t.importLedger.whereItGoes} />
                <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                  <TargetRow
                    label={t.importLedger.aNewGroup}
                    hint={t.importLedger.namedAfterFile}
                    selected={target === NEW_GROUP}
                    onPress={() => void chooseTarget(NEW_GROUP)}
                  />
                  {(groups.data ?? []).map((group) => (
                    <TargetRow
                      key={group.id}
                      label={groupLabel(group)}
                      hint={t.importLedger.addToThisGroup}
                      selected={target === group.id}
                      onPress={() => void chooseTarget(group.id)}
                    />
                  ))}
                </Card>
              </View>
            ) : null}

            {parsed.expenses.length > 0 ? (
              <View>
                <SectionHeader title={t.importLedger.whoIsWho} />
                <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
                  {parsed.people.map((person, index) => (
                    <View key={person}>
                      {index > 0 ? <Divider /> : null}
                      <Pressable
                        onPress={() => cycle(person)}
                        accessibilityRole="button"
                        accessibilityLabel={`${person} is ${describeMapping(person)}. Tap to change.`}
                        style={{ paddingVertical: theme.spacing.lg, gap: 2 }}
                      >
                        <Row style={{ justifyContent: 'space-between' }}>
                          <Text variant="subheading">{person}</Text>
                          <Row style={{ gap: theme.spacing.sm }}>
                            <MoneyText
                              amount={parsed.balances[person] ?? 0n}
                              currency={parsed.currency}
                              variant="caption"
                            />
                            <Badge
                              label={describeMapping(person)}
                              tone={mapping[person]?.kind === 'ghost' ? 'neutral' : 'brand'}
                            />
                          </Row>
                        </Row>
                      </Pressable>
                    </View>
                  ))}
                </Card>
                <Text variant="micro" tone="faint" style={{ paddingTop: theme.spacing.sm }}>
                  {t.importLedger.tapANameNote}
                </Text>
              </View>
            ) : null}

            {parsed.expenses.length > 0 ? (
              <>
                <Button
                  label={
                    busy
                      ? t.importLedger.importing
                      : plural(locale, parsed.expenses.length, t.importLedger.importCount)
                  }
                  size="lg"
                  fullWidth
                  disabled={busy || !claimedByMe}
                  onPress={() => void run()}
                  icon={
                    <Ionicons
                      name="cloud-upload-outline"
                      size={iconSize.md}
                      color={theme.color.onBrand}
                    />
                  }
                />
                {!claimedByMe ? (
                  <Text variant="caption" tone="muted" align="center">
                    {t.importLedger.tapYourNameFirst}
                  </Text>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {done ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading" tone="positive">
              {t.importLedger.imported}
            </Text>
            <Text variant="caption" tone="muted">
              {plural(locale, done.expenses, t.importLedger.expenseCount)}
              {done.settlements > 0
                ? ` · ${plural(locale, done.settlements, t.importLedger.settlementCount)}`
                : ''}
              {done.ghosts > 0
                ? ` · ${plural(locale, done.ghosts, t.importLedger.peopleAdded)}`
                : ''}
            </Text>
            <Button
              label={t.importLedger.openTheGroup}
              fullWidth
              onPress={() => router.replace(`/group/${done.groupId}`)}
            />
          </Card>
        ) : null}

        {error ? <Callout tone="negative">{error}</Callout> : null}
      </ScrollView>
    </Screen>
  );
}

function TargetRow({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{ paddingVertical: theme.spacing.lg }}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ gap: 2 }}>
          <Text variant="subheading">{label}</Text>
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        </View>
        <Ionicons
          name={selected ? 'radio-button-on' : 'radio-button-off'}
          size={iconSize.xl}
          color={selected ? theme.color.brand : theme.color.textFaint}
        />
      </Row>
    </Pressable>
  );
}

/** The name a group falls back to when the file did not give it one. */
function numberedGroup(t: UiStrings, index: number): string {
  return t.importLedger.groupNumber.replace('{n}', String(index + 1));
}
