/**
 * Starting a scan, and watching it happen.
 *
 * The reader used to work invisibly — a pass ran, rows appeared somewhere, and
 * the only evidence was a list that had got longer while nobody was looking.
 * That is right for a background job and wrong for a button. A button that
 * returns instantly and changes a number on another screen is a button people
 * press once, disbelieve, and never press again.
 *
 * So this sheet is the whole event, start to finish, in one place:
 *
 *   1. **How far back?** Two choices, not a date picker, because there are two
 *      questions people actually have — catch up, or go back and get
 *      everything. The slow one says it is slow on the row that offers it,
 *      rather than in a toast after it has been chosen.
 *   2. **The hourly check, as a switch.** Whether Waves may wake the phone to
 *      look for new messages, or should only look when it is opened. It used to
 *      be a warning here — several manufacturers stop scheduled work by default
 *      (`lib/smsBattery.ts`) — and a warning is the wrong shape for it: there is
 *      nothing wrong, nothing to fix in the app, and messages are read on the
 *      way in either way. The question mark beside the switch holds what to
 *      change on the phones where the check does get stopped, named by maker.
 *   3. **Progress, in three honest stages.** Reading is indeterminate because
 *      the native call genuinely has no progress to report, and a fake bar is a
 *      small lie told every time. Sorting counts real messages. Saving is the
 *      short tail.
 *   4. **What it found.** Including the two numbers most apps leave out: how
 *      many looked like payments and could not be read, and how many were clear
 *      enough to have gone straight to Review without being asked about.
 *
 * The sheet cannot be dismissed while a scan is running. Not to trap anybody —
 * the scan would finish either way — but because leaving mid-progress is how a
 * person concludes it did not work.
 */

import { useCallback, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import {
  Button,
  Popup,
  ProgressBar,
  Row,
  Sheet,
  Text,
  Toggle,
  iconSize,
  useTheme,
} from '@waves/ui';

import { plural, useStrings, type UiStrings } from '@/i18n';
import { batteryLimitsLikely, deviceMaker, openAppSettings } from '@/lib/smsBattery';
import { useBackgroundCheck } from '@/lib/useBackgroundCheck';
import { useReducedMotion } from '@/lib/reducedMotion';
import { ScanScope, scanFor, type ScanProgress, type ScanResult } from '@/lib/smsScan';

/** What the sheet is showing: the choice, the work, or the outcome. */
type Phase =
  | { readonly kind: 'choosing' }
  | { readonly kind: 'working'; readonly progress: ScanProgress }
  | { readonly kind: 'done'; readonly result: ScanResult };

/**
 * How far a bar should be filled for a stage.
 *
 * Null while reading — the native call is one round trip with nothing to report,
 * so the bar slides rather than pretending to advance. Sorting is the real
 * fraction. Saving is the last stretch, and is mapped into the top tenth of the
 * track rather than restarting from zero: a bar that goes back to the start
 * looks like the work did.
 */
function fractionOf(progress: ScanProgress): number | null {
  if (progress.stage === 'reading') return null;
  if (progress.total === 0) return progress.stage === 'saving' ? 1 : 0.9;
  const done = progress.done / progress.total;
  return progress.stage === 'sorting' ? done * 0.9 : 0.9 + done * 0.1;
}

function stageWords(progress: ScanProgress, t: UiStrings): string {
  if (progress.stage === 'reading') return t.smsInbox.scanReading;
  if (progress.stage === 'saving') return t.smsInbox.scanSaving;
  return t.smsInbox.scanSorting
    .replace('{done}', String(progress.done))
    .replace('{total}', String(progress.total));
}

/** One of the two scopes, as a row you can tap anywhere on. */
function ScopeRow({
  label,
  note,
  selected,
  onPress,
}: {
  label: string;
  note: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}. ${note}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: selected ? theme.color.brand : theme.color.border,
        backgroundColor: selected ? theme.color.brandSoft : theme.color.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {/* The state is in the words and the tick together, never in colour
          alone — the rule the design audit (#191) left behind. */}
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={iconSize.md}
        color={selected ? theme.color.brand : theme.color.textMuted}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body">{label}</Text>
        <Text variant="caption" tone="muted">
          {note}
        </Text>
      </View>
    </Pressable>
  );
}

export function SmsScanSheet({
  visible,
  ownerId,
  onClose,
  onFinished,
}: {
  visible: boolean;
  ownerId: string;
  onClose: () => void;
  /** Fired once a scan completes, so the list behind can read the store again. */
  onFinished: (result: ScanResult) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const reduceMotion = useReducedMotion();

  const [scope, setScope] = useState<ScanScope>(ScanScope.Recent);
  const [phase, setPhase] = useState<Phase>({ kind: 'choosing' });
  const [helpOpen, setHelpOpen] = useState(false);
  const background = useBackgroundCheck();

  const warnBattery = batteryLimitsLikely();
  const maker = deviceMaker();

  const start = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'working', progress: { stage: 'reading' } });
    const result = await scanFor(ownerId, scope, (progress) => {
      setPhase({ kind: 'working', progress });
    });
    setPhase({ kind: 'done', result });
    onFinished(result);
  }, [onFinished, ownerId, scope]);

  const close = useCallback((): void => {
    // Reopening always opens on the choice, never on the last result.
    setPhase({ kind: 'choosing' });
    onClose();
  }, [onClose]);

  return (
    <Sheet
      visible={visible}
      // While a scan is running the backdrop does nothing. The work would
      // finish either way; leaving mid-progress is simply how somebody
      // concludes that it did not.
      onClose={phase.kind === 'working' ? () => {} : close}
      closeLabel={t.common.close}
      style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.lg }}
    >
      <Text variant="heading">{t.smsInbox.scanTitle}</Text>

      {phase.kind === 'choosing' ? (
        <>
          <View style={{ gap: theme.spacing.sm }}>
            <ScopeRow
              label={t.smsInbox.scanRecent}
              note={t.smsInbox.scanRecentNote}
              selected={scope === ScanScope.Recent}
              onPress={() => setScope(ScanScope.Recent)}
            />
            <ScopeRow
              label={t.smsInbox.scanEverything}
              note={t.smsInbox.scanEverythingNote}
              selected={scope === ScanScope.Everything}
              onPress={() => setScope(ScanScope.Everything)}
            />
          </View>

          {/* The one thing people are actually afraid of when they see the word
              "rescan": that it will undo what they have already sorted out. */}
          <Text variant="caption" tone="muted">
            {t.smsInbox.scanKeepsWhatYouDid}
          </Text>

          {/* The hourly wake-up, as a switch rather than an alarm. What stood
              here was an orange panel telling somebody their phone would
              probably stop the feature working — true on about half of Android,
              and no use to anybody: it is not a fault, there is nothing to fix
              in the app, and new messages are read whenever it is opened
              regardless. A switch says the same fact without the fright, and
              the question mark beside it holds what to change on the phones
              where the check does get stopped. */}
          <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Row style={{ alignItems: 'center', gap: theme.spacing.xs }}>
                <Text variant="body">{t.smsInbox.backgroundTitle}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t.smsInbox.backgroundHelp}
                  hitSlop={10}
                  onPress={() => setHelpOpen(true)}
                >
                  <Ionicons
                    name="help-circle-outline"
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                </Pressable>
              </Row>
              <Text variant="micro" tone="muted">
                {t.smsInbox.backgroundNote}
              </Text>
            </View>
            <Toggle
              value={background.wanted}
              onValueChange={background.setWanted}
              accessibilityLabel={t.smsInbox.backgroundTitle}
            />
          </Row>

          <Button label={t.smsInbox.scan} fullWidth onPress={() => void start()} />
        </>
      ) : phase.kind === 'working' ? (
        <View style={{ gap: theme.spacing.md, paddingVertical: theme.spacing.md }}>
          <Text variant="body">{stageWords(phase.progress, t)}</Text>
          <ProgressBar progress={fractionOf(phase.progress)} animated={!reduceMotion} />
          {/* The promise, repeated exactly where somebody is watching their own
              bank messages be read. This is the moment it is worth saying. */}
          <Row style={{ gap: theme.spacing.xs, alignItems: 'center' }}>
            <Ionicons name="phone-portrait-outline" size={iconSize.sm} color={theme.color.brand} />
            <Text variant="micro" tone="muted">
              {t.smsInbox.onDevice}
            </Text>
          </Row>
        </View>
      ) : (
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="body">
            {phase.result.added === 0
              ? t.smsInbox.scanNothingNew
              : plural(locale, phase.result.added, t.smsInbox.scanFound)}
          </Text>
          {phase.result.drafted > 0 ? (
            <Text variant="caption" tone="muted">
              {plural(locale, phase.result.drafted, t.smsInbox.scanDrafted)}
            </Text>
          ) : null}
          {/* The number most apps of this kind leave out. It is the only signal
              a person has that the parser has a gap, and hiding it would make
              "nothing found" and "nothing understood" look identical. */}
          {phase.result.unreadable > 0 ? (
            <Text variant="caption" tone="muted">
              {plural(locale, phase.result.unreadable, t.smsInbox.scanUnreadable)}
            </Text>
          ) : null}
          <Button label={t.common.done} fullWidth onPress={close} />
        </View>
      )}
      <Popup visible={helpOpen} onClose={() => setHelpOpen(false)} closeLabel={t.common.close}>
        <Text variant="heading">{t.smsInbox.backgroundHelpTitle}</Text>
        <Text variant="caption" tone="muted">
          {t.smsInbox.backgroundHelpBody}
        </Text>
        {/* Named only where the naming is worth something: the phones that do
            this have the setting in different places, and "usually under
            Battery" is the difference between a person finding it and giving
            up. Everyone else is told nothing they would have to translate. */}
        {warnBattery && maker ? (
          <Text variant="caption" tone="muted">
            {t.smsInbox.backgroundHelpMaker.replace('{maker}', maker)}
          </Text>
        ) : null}
        <Button
          label={t.smsInbox.batteryOpenSettings}
          variant="secondary"
          fullWidth
          onPress={() => void openAppSettings()}
        />
        <Button label={t.common.done} fullWidth onPress={() => setHelpOpen(false)} />
      </Popup>
    </Sheet>
  );
}
