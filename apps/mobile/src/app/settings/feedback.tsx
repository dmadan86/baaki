import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ActivityIndicator, Platform, ScrollView, TextInput, View } from 'react-native';

import {
  Button,
  Callout,
  Card,
  ChipRow,
  directionalIcon,
  IconButton,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { submitFeedback } from '@/data/api';
import { useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';

enum Kind {
  General = 'general',
  Bug = 'bug',
  Idea = 'idea',
}

export default function FeedbackScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();

  const [kind, setKind] = useState<Kind>(Kind.General);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await submitFeedback({
        message: message.trim(),
        kind,
        // Version and platform go along because "it crashes" is a different
        // report on an old build than on the current one, and asking somebody
        // to find their build number is asking them not to bother.
        appVersion: Constants.expoConfig?.version ?? null,
        platform: Platform.OS,
      });
      setSent(true);
    } catch (caught) {
      // Never the raw message. On an emulator this screen once showed somebody
      // "Could not find the function public.baaki_submit_feedback(...) in the
      // schema cache" while they were mid-complaint.
      setError(friendlyError(caught, t.privacy.couldNotSave, 'feedback.submit'));
    } finally {
      setBusy(false);
    }
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
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.privacy.feedbackTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {sent ? (
          <Card style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Ionicons name="checkmark-circle" size={40} color={theme.color.positive} />
            <Text variant="subheading" align="center">
              {t.privacy.feedbackThanks}
            </Text>
            <Button label={t.common.close} variant="secondary" onPress={() => router.back()} />
          </Card>
        ) : (
          <>
            <Text variant="body" tone="muted">
              {t.privacy.feedbackHint}
            </Text>

            <ChipRow<Kind>
              value={kind}
              onChange={setKind}
              options={[
                { value: Kind.General, label: t.privacy.kindGeneral },
                { value: Kind.Bug, label: t.privacy.kindBug },
                { value: Kind.Idea, label: t.privacy.kindIdea },
              ]}
            />

            <Card>
              <TextInput
                value={message}
                onChangeText={setMessage}
                placeholder={t.privacy.feedbackPlaceholder}
                placeholderTextColor={theme.color.textFaint}
                accessibilityLabel={t.privacy.feedbackTitle}
                multiline
                autoFocus
                maxLength={4000}
                style={{
                  minHeight: 140,
                  fontSize: 16,
                  color: theme.color.text,
                  textAlignVertical: 'top',
                }}
              />
            </Card>

            {error ? <Callout tone="negative">{error}</Callout> : null}
            {busy ? <ActivityIndicator color={theme.color.brand} /> : null}

            <Button
              label={t.privacy.feedbackSend}
              size="lg"
              fullWidth
              disabled={busy || message.trim().length === 0}
              onPress={() => void send()}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
