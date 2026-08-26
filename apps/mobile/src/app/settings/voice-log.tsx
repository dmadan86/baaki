import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { Share, ScrollView, View } from 'react-native';

import {
  Button,
  Card,
  directionalIcon,
  EmptyState,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useScreenClearance,
  useTheme,
} from '@waves/ui';

import { fill, plural, useStrings } from '@/i18n';
import { clearVoiceLog, readVoiceLog, type VoiceAttempt } from '@/lib/voiceLog';

/**
 * A read-back of the on-device voice-attempt log — what the mic heard and
 * whether it produced an expense — so a real miss can be revisited and the
 * parser improved against it. Device-only; the person can share their own log
 * or clear it. Reached from Settings.
 */
export default function VoiceLogScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const clearance = useScreenClearance();
  const [entries, setEntries] = useState<VoiceAttempt[]>([]);

  // Re-read on focus so a fresh miss recorded on the voice screen shows on the
  // way back. Inline (React Compiler auto-memoises) — no hand-written callback.
  useFocusEffect(() => {
    let active = true;
    void readVoiceLog().then((rows) => {
      if (active) setEntries(rows);
    });
    return () => {
      active = false;
    };
  });

  const onClear = (): void => {
    void clearVoiceLog().then(() => setEntries([]));
  };

  const onShare = (): void => {
    if (entries.length === 0) return;
    const text = entries
      .map(
        (entry) =>
          `${entry.at}  [${entry.itemCount}]${entry.usedModel ? ' (model)' : ''}\n${entry.transcript}`,
      )
      .join('\n\n');
    void Share.share({ message: text }).catch(() => undefined);
  };

  const stamp = (iso: string): string => {
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) return iso;
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(parsed),
    );
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md, alignItems: 'center' }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.voice.logTitle}</Text>
          </View>
          {entries.length > 0 ? (
            <IconButton label={t.voice.logShare} onPress={onShare}>
              <Ionicons name="share-outline" size={iconSize.lg} color={theme.color.text} />
            </IconButton>
          ) : (
            <View style={{ width: 44 }} />
          )}
        </Row>

        <Text variant="caption" tone="muted" align="center">
          {t.voice.logSubtitle}
        </Text>

        {entries.length === 0 ? (
          <View style={{ paddingTop: theme.spacing.xxxl }}>
            <EmptyState
              title={t.voice.logEmpty}
              body={t.voice.logEmptyBody}
              icon={<Ionicons name="mic-outline" size={iconSize.xxl} color={theme.color.brand} />}
            />
          </View>
        ) : (
          <>
            {entries.map((entry, index) => {
              const miss = entry.itemCount === 0;
              return (
                <Card key={`${entry.at}-${index}`} style={{ gap: theme.spacing.xs }}>
                  <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text
                      variant="micro"
                      tone={miss ? 'negative' : 'positive'}
                      style={{ fontWeight: '700' }}
                    >
                      {miss
                        ? t.voice.logNoExpense
                        : fill(plural(locale, entry.itemCount, t.voice.logFound), {
                            n: entry.itemCount,
                          })}
                    </Text>
                    <Text variant="micro" tone="muted">
                      {stamp(entry.at)}
                    </Text>
                  </Row>
                  <Text variant="body">{entry.transcript}</Text>
                </Card>
              );
            })}
            <Button label={t.voice.logClear} variant="secondary" onPress={onClear} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
