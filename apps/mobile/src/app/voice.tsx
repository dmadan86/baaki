/**
 * Speak an expense.
 *
 * Reached from the raised mic in the bottom bar. The reader says something like
 * "add 500 to the Goa trip"; the phone turns it into text on-device (see
 * VoiceCapture), this parses out the amount and the group it names (see
 * voiceExpense), and hands off to the ordinary add-expense form with those
 * filled in — so the last step is always a glance and a Save, never a blind
 * write. When the sentence names no group, or names one ambiguously, it asks
 * which rather than guessing.
 *
 * The route file imports nothing native: the microphone is reached through
 * VoiceMicPanel, which loads the native module inside a try (see the note
 * there), so an older binary shows a plain message instead of crashing.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Button,
  Callout,
  IconButton,
  iconSize,
  ListRow,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@baaki/ui';

import { useGroups } from '@/data/hooks';
import { groupLabel } from '@/data/types';
import { useStrings } from '@/i18n';
import { VoiceMicPanel } from '@/components/VoiceMicPanel';
import { parseVoiceExpense, type ParsedVoiceExpense } from '@/lib/voiceExpense';

export default function VoiceScreen() {
  const theme = useTheme();
  const clearance = useScreenClearance();
  const { t } = useStrings();
  const groups = useGroups();

  // Parsed result waiting on a group choice, or null while still listening.
  const [pending, setPending] = useState<ParsedVoiceExpense | null>(null);
  const [noAmount, setNoAmount] = useState(false);
  // Remounts the mic to start a fresh utterance after a miss.
  const [attempt, setAttempt] = useState(0);

  const groupRows = groups.data ?? [];
  const groupRefs = groupRows.map((group) => ({ id: group.id, name: group.name }));
  const hints = groupRows.map((group) => group.name ?? '').filter(Boolean);

  const goToExpense = (groupId: string, parsed: ParsedVoiceExpense): void => {
    // Swap this modal for the prefilled form, so Back from the form returns to
    // where the reader was, not to the mic.
    router.replace({
      pathname: '/group/[id]/add-expense',
      params: {
        id: groupId,
        voice: '1',
        amount: parsed.amountMinor === null ? '0' : String(parsed.amountMinor),
        description: parsed.note,
      },
    });
  };

  const handleTranscript = (transcript: string): void => {
    const parsed = parseVoiceExpense(transcript, groupRefs);
    if (parsed.amountMinor === null) {
      setNoAmount(true);
      setAttempt((current) => current + 1);
      return;
    }
    if (parsed.groupId) {
      goToExpense(parsed.groupId, parsed);
      return;
    }
    // Amount understood, group not — ask which.
    setPending(parsed);
  };

  const retry = (): void => {
    setNoAmount(false);
    setPending(null);
    setAttempt((current) => current + 1);
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md, justifyContent: 'space-between' }}>
          <Text variant="heading">{t.voice.title}</Text>
          <IconButton label={t.common.close} onPress={() => router.back()}>
            <Ionicons name="close" size={iconSize.lg} color={theme.color.text} />
          </IconButton>
        </Row>

        {groupRows.length === 0 ? (
          // Nothing to speak an expense into yet.
          <View style={{ gap: theme.spacing.lg, paddingTop: theme.spacing.xxl }}>
            <Text align="center" tone="muted">
              {t.voice.noGroups}
            </Text>
            <View style={{ alignItems: 'center' }}>
              <Button label={t.voice.makeGroup} onPress={() => router.replace('/new-group')} />
            </View>
          </View>
        ) : pending ? (
          // Amount understood; pick the group it belongs to.
          <View style={{ gap: theme.spacing.lg }}>
            <Callout tone="info">
              {t.voice.heard.replace('{note}', pending.note || t.voice.anExpense)}
            </Callout>
            <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
              {t.voice.chooseGroup.toUpperCase()}
            </Text>
            {groupRows.map((group) => (
              <ListRow
                key={group.id}
                title={groupLabel(group)}
                onPress={() => goToExpense(group.id, pending)}
              />
            ))}
          </View>
        ) : (
          // Listening.
          <View style={{ gap: theme.spacing.lg, paddingTop: theme.spacing.xxl }}>
            {noAmount ? <Callout tone="warning">{t.voice.noAmount}</Callout> : null}
            <VoiceMicPanel key={attempt} onDone={handleTranscript} hints={hints} />
            {noAmount ? (
              <View style={{ alignItems: 'center' }}>
                <Button label={t.voice.tryAgain} variant="secondary" onPress={retry} />
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
