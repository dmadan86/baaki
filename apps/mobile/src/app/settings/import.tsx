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
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  importSplitwiseCsv,
  isBaakiExport,
  parseBaakiExport,
  type BaakiImportGroup,
  type BaakiImportSettlement,
  type ImportProblem,
} from '@waves/core';
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
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
  Sheet,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { createGroup, fetchMembers, importLedger, type ImportPerson } from '@/data/api';
import { beginImport } from '@/lib/importProgress';
import { friendlyError } from '@/lib/errors';
import { plural, useStrings, type UiStrings } from '@/i18n';
import { useReducedMotion } from '@/lib/reducedMotion';
import { useGroups } from '@/data/hooks';
import { displayName, groupLabel, GroupType, type MemberRow } from '@/data/types';
import { useAuth } from '@/lib/auth';

/** What a column in the file has been mapped to. */
type Mapping = { kind: 'me' } | { kind: 'member'; memberId: string } | { kind: 'ghost' };

const NEW_GROUP = 'new';

/**
 * Yield one frame so React can flush a state change to the screen before the
 * thread is tied up again. The file read is async, but the parse that follows
 * runs on this thread and blocks it — without a paint in between, a large file
 * freezes on a blank screen and looks like nothing happened.
 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Which slow step the screen is on, so it can name what it is waiting for. */
type Stage = 'reading' | 'parsing' | 'importing';

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
  // The bottom bar shows on this screen (it is a settings page, not a modal), and
  // it is opaque — so the scroll has to clear the *bar*, not just the system
  // inset. `useScreenClearance` only cleared the inset, which left the Import CTA
  // jammed under the bar. `useTabBarClearance` is the bar-aware room the other
  // settings screens use; a token more on top gives the footer CTA its breath.
  const clearance = useTabBarClearance() + theme.spacing.xl;
  const { t, locale } = useStrings();
  const reduceMotion = useReducedMotion();
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
  const [fileGroupIndex, setFileGroupIndex] = useState(0);
  const [target, setTarget] = useState<string>(NEW_GROUP);
  // The name a new group is created with. Seeded from the file (the Splitwise
  // default, or the export's own name) and then the person's to change — they no
  // longer have to accept "Splitwise" or rename it afterwards.
  const [newGroupName, setNewGroupName] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, Mapping>>({});
  /**
   * Generated once per parsed file and reused on every retry. This is what
   * makes a second tap after a dropped connection a replay rather than a
   * duplicate import (ADR-005).
   */
  const [mutationIds, setMutationIds] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
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
    setNewGroupName(loaded.suggestedName);
    setMutationIds([...loaded.expenses, ...loaded.settlements].map(() => randomUUID()));
    // Claiming a name as yourself is a deliberate act. Guessing by name would
    // silently merge your ledger with a stranger who shares your first name.
    setMapping(Object.fromEntries(loaded.people.map((person) => [person, { kind: 'ghost' }])));
    setTarget(NEW_GROUP);
    setMembers([]);
  };

  const choose = async (source: 'splitwise' | 'other' = 'other'): Promise<void> => {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      // The format is decided by sniffing the file contents (isBaakiExport),
      // never the picker — so both sources funnel through here. The `source`
      // only narrows what the picker offers: a Splitwise export is a CSV, so
      // that option leads with CSV; "other data" (a Waves JSON, or anything
      // else) leads with JSON. Both keep the text/octet-stream fallbacks, since
      // some Android providers mislabel a .csv as `application/octet-stream`.
      const type =
        source === 'splitwise'
          ? ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/octet-stream']
          : [
              'application/json',
              'text/csv',
              'text/comma-separated-values',
              'text/plain',
              'application/octet-stream',
            ];
      const picked = await DocumentPicker.getDocumentAsync({
        type,
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;

      const asset = picked.assets[0];
      if (!asset) return;

      setFileGroups([]);
      setFileGroupIndex(0);
      setParsed(null);

      // Paint the "reading" bar before touching the file. The read below is
      // async, but the parse after it is not — both run on this thread, so
      // without a frame here a large file blocks before any progress shows.
      setStage('reading');
      await nextFrame();

      const pickedFile = new FileSystem.File(asset.uri);
      // Async read (Blob.text) rather than the synchronous textSync: a large
      // file no longer holds the JS thread while it comes off disk.
      const text = await pickedFile.text();
      try {
        if (pickedFile.exists) pickedFile.delete();
      } catch {
        // Best-effort privacy cleanup; parsing has already copied the content into memory.
      }
      setFile(asset.name);

      // The parse is synchronous and can be the slow part on a big file, so flush
      // the "parsing" label to the screen before it blocks the thread.
      setStage('parsing');
      await nextFrame();

      // Asked of the contents, not the extension: a file saved from a browser
      // or shared through a chat app arrives named all sorts of things.
      if (isBaakiExport(text)) {
        const result = parseBaakiExport(text);
        if (result.problems.length > 0) {
          setError(result.problems[0]!.message);
          return;
        }
        const fallback = asset.name.replace(/\.json$/i, '');
        if (result.groups.length === 0 || !result.groups[0]) {
          setError(t.importLedger.noGroupsInFile);
          return;
        }
        setFileGroups(result.groups);
        load(fromBaaki(result.groups[0], fallback));
        return;
      }

      const result = importSplitwiseCsv(text);
      load({
        origin: 'splitwise',
        // A Splitwise CSV is named "export" more often than not and carries no
        // group name of its own, so default to the source's own name rather than
        // a filename that means nothing. The person can rename the group later.
        suggestedName: t.importLedger.splitwiseGroupName,
        people: result.people,
        currency: result.currency,
        expenses: result.expenses,
        settlements: [],
        balances: result.balances,
        otherCurrencies: [],
        problems: result.problems,
      });
    } catch (caught) {
      setError(friendlyError(caught, t.importLedger.importFailed, 'import.readFile'));
    } finally {
      setBusy(false);
      setStage(null);
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

  /**
   * Hand the import to the background store and walk home. The write itself no
   * longer happens on this screen: the moment it is kicked, we replace this
   * screen with the dashboard, where a banner above the group list tracks the
   * percentage and the finished group animates into the list. The job below
   * closes over everything it needs, so it runs to completion whether or not
   * this screen is still mounted (see `@/lib/importProgress`).
   */
  const run = (): void => {
    if (!parsed) return;
    const snapshot = parsed;
    const chosenMapping = mapping;
    const chosenTarget = target;
    const ids = mutationIds;
    const iClaimedAColumn = claimedByMe;
    // What the person typed, falling back to the file's suggestion and then a
    // generic label — a new group never lands nameless.
    const name = newGroupName.trim() || snapshot.suggestedName || t.importLedger.importedGroup;
    // A client-chosen id for a brand-new group, fixed here so the whole job is a
    // safe replay: if the store re-runs it after an offline wait, createGroup is
    // idempotent on this id (returns the same group, never a second one) and the
    // ledger write dedups on its mutation ids. Unused for an existing target.
    const newGroupId = randomUUID();

    // The one precondition we can settle before leaving: claiming yourself in an
    // existing group you are not a member of would file your history under a
    // ghost. A new group makes you a member, so this only bites an existing
    // target — and there we already hold its members, so the check is local.
    if (
      chosenTarget !== NEW_GROUP &&
      iClaimedAColumn &&
      !members.some((member) => member.profile_id === profile?.id)
    ) {
      setError(t.importLedger.couldNotFindYou);
      return;
    }

    const scheduled = beginImport({
      name,
      run: async () => {
        try {
          let groupId = chosenTarget;
          if (groupId === NEW_GROUP) {
            groupId = newGroupId;
            await createGroup({
              groupId: newGroupId,
              name,
              type: GroupType.Other,
              currency: snapshot.currency,
            });
          }

          // Whoever is "you" maps to your own membership in the target group; the
          // server resolves the rest, so a null memberId means "make a ghost".
          const mine = (await fetchMembers(groupId)).find(
            (member) => member.profile_id === profile?.id,
          );
          if (iClaimedAColumn && !mine) throw new Error(t.importLedger.couldNotFindYou);

          const people: ImportPerson[] = snapshot.people.map((person) => {
            const chosen = chosenMapping[person] ?? { kind: 'ghost' };
            if (chosen.kind === 'me') return { name: person, memberId: mine?.id ?? null };
            if (chosen.kind === 'member') return { name: person, memberId: chosen.memberId };
            return { name: person, memberId: null };
          });

          const result = await importLedger({
            groupId,
            people,
            origin: snapshot.origin,
            expenses: snapshot.expenses.map((expense, index) => ({
              clientMutationId: ids[index] ?? randomUUID(),
              description: expense.description,
              category: expense.category,
              date: expense.date,
              currency: expense.currency,
              amount: expense.amount,
              payers: expense.payers,
              shares: expense.shares,
            })),
            settlements: snapshot.settlements.map((settlement, index) => ({
              clientMutationId: ids[snapshot.expenses.length + index] ?? randomUUID(),
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

          // Pull the new group into the mirror so Home can show (and animate) it.
          groups.refetch();
          return {
            groupId,
            expenses: result.expenses,
            ghosts: result.ghosts,
            settlements: result.settlements ?? 0,
          };
        } catch (caught) {
          // Keep the one precondition message as-is; wrap everything else in a
          // people-facing line. The store shows whichever we throw verbatim.
          if (caught instanceof Error && caught.message === t.importLedger.couldNotFindYou) {
            throw caught;
          }
          throw new Error(friendlyError(caught, t.importLedger.importFailed, 'import.commit'));
        }
      },
    });

    // Only leave once the job is actually on. If another import is already
    // running, the store refused this one — staying put with a message beats
    // walking home to watch a different import and silently losing this file.
    if (!scheduled) {
      setError(t.importLedger.alreadyImporting);
      return;
    }
    router.replace('/');
  };

  return (
    <Screen>
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
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
        <IconButton label={t.importLedger.helpTitle} onPress={() => setHelpOpen(true)}>
          <Ionicons name="help-circle-outline" size={iconSize.lg} color={theme.color.text} />
        </IconButton>
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          paddingTop: theme.spacing.lg,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">{t.importLedger.bringHistory}</Text>
            <Badge label={t.importLedger.free} tone="positive" />
          </Row>
          <Text variant="caption" tone="muted">
            {t.importLedger.ledgerHowTo}
          </Text>
        </Card>

        {/* Two ways in, one flow: the file's contents decide the format either
            way (see choose()), so these only set the picker's expectation and
            the wording the person reads. Once a file is loaded, the block below
            takes over; the buttons stay as the way to pick a different one. */}
        <View style={{ gap: theme.spacing.md }}>
          <Button
            label={t.importLedger.fromSplitwise}
            size="lg"
            fullWidth
            variant="primary"
            disabled={busy}
            onPress={() => void choose('splitwise')}
            icon={
              <Ionicons
                name="document-attach-outline"
                size={iconSize.md}
                color={theme.color.onBrand}
              />
            }
          />
          <Button
            label={t.importLedger.fromOther}
            size="lg"
            fullWidth
            variant="secondary"
            disabled={busy}
            onPress={() => void choose('other')}
            icon={
              <Ionicons name="folder-open-outline" size={iconSize.md} color={theme.color.brand} />
            }
          />
        </View>

        {stage === 'reading' || stage === 'parsing' ? (
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="caption" tone="muted">
              {stage === 'reading' ? t.importLedger.reading : t.importLedger.parsing}
            </Text>
            <ProgressBar animated={!reduceMotion} />
          </View>
        ) : null}

        {/* A file holding several groups: one at a time, chosen here. */}
        {fileGroups.length > 1 && !done ? (
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader title={t.importLedger.whichGroup} />
            <ChipRow<string>
              // Keyed by position, not by name: two groups in one export can
              // share a name, and matching on the name loads the first of them
              // whichever chip is tapped.
              value={String(fileGroupIndex)}
              onChange={(key) => {
                const index = Number(key);
                const chosen = fileGroups[index];
                if (chosen) {
                  setFileGroupIndex(index);
                  load(fromBaaki(chosen, numberedGroup(t, index)));
                }
              }}
              options={fileGroups.map((group, index) => ({
                value: String(index),
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
                <Text variant="micro" tone="muted">
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
                  <Text variant="micro" tone="muted">
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
                    hint={t.importLedger.nameItBelow}
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

                {/* Name the new group here rather than accept the file's default.
                    Only for a new group — an existing target already has a name. */}
                {target === NEW_GROUP ? (
                  <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.xs }}>
                    <Text
                      variant="micro"
                      tone="muted"
                      style={{ paddingHorizontal: theme.spacing.sm }}
                    >
                      {t.group.groupName}
                    </Text>
                    <Card style={{ paddingVertical: theme.spacing.md }}>
                      <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
                        <Ionicons
                          name="people-outline"
                          size={iconSize.md}
                          color={theme.color.textFaint}
                        />
                        <TextInput
                          value={newGroupName}
                          onChangeText={setNewGroupName}
                          placeholder={parsed.suggestedName}
                          placeholderTextColor={theme.color.textFaint}
                          accessibilityLabel={t.group.groupName}
                          returnKeyType="done"
                          style={{
                            flex: 1,
                            fontSize: 16,
                            fontWeight: '600',
                            color: theme.color.text,
                            paddingVertical: 0,
                          }}
                        />
                        {newGroupName.length > 0 ? (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={t.entry.clear}
                            onPress={() => setNewGroupName('')}
                            hitSlop={8}
                            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                          >
                            <Ionicons
                              name="close-circle"
                              size={iconSize.md}
                              color={theme.color.textFaint}
                            />
                          </Pressable>
                        ) : null}
                      </Row>
                    </Card>
                  </View>
                ) : null}
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
                <Text variant="micro" tone="muted" style={{ paddingTop: theme.spacing.sm }}>
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
                  onPress={() => run()}
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

      {/* How it works, on tap of the header's help glyph — a bottom sheet that
          walks through the two file types and what does and does not come
          across, plus that it can be done with no connection. */}
      <Sheet
        visible={helpOpen}
        onClose={() => setHelpOpen(false)}
        padded={false}
        closeLabel={t.common.close}
        style={{ paddingHorizontal: theme.spacing.xxl, paddingTop: theme.spacing.xl, gap: theme.spacing.lg }}
      >
            <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
              <Ionicons name="help-circle-outline" size={iconSize.xl} color={theme.color.brand} />
              <Text variant="title">{t.importLedger.helpTitle}</Text>
            </Row>
            <ScrollView
              style={{ maxHeight: 340 }}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ gap: theme.spacing.md }}
            >
              <Text variant="body" tone="muted">
                {t.importLedger.ledgerHowTo}
              </Text>
              <Divider />
              <Text variant="caption" tone="muted">
                {t.importLedger.fromSplitwiseNote}
              </Text>
              <Text variant="caption" tone="muted">
                {t.importLedger.fromBaakiNote}
              </Text>
              <Divider />
              {/* Offline: parked and run on reconnect (see `@/lib/importProgress`). */}
              <Text variant="caption" tone="muted">
                {t.importLedger.helpOffline}
              </Text>
            </ScrollView>
            <Button label={t.misc.gotIt} fullWidth onPress={() => setHelpOpen(false)} />
      </Sheet>
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
