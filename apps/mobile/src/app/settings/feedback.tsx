import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ActivityIndicator, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  Button,
  Callout,
  Card,
  ChipRow,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

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
  // 1–5, or null when they write without rating. The table and RPC have always
  // had the column (baaki_submit_feedback's p_rating); this is the screen that
  // finally offers it. Tapping a chosen star again clears it — a rating is a
  // gift, not a required field.
  const [rating, setRating] = useState<number | null>(null);
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
        rating,
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
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.privacy.feedbackTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {sent ? (
          <Card style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Ionicons name="checkmark-circle" size={iconSize.hero} color={theme.color.positive} />
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

            {/* A rating, offered not demanded — the star row a person reaches for
                first, and the one signal that turns a wall of messages into a
                trend. Optional: the label says so, and a second tap clears it. */}
            <Card style={{ gap: theme.spacing.md }}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Text variant="subheading">{t.privacy.feedbackRating}</Text>
                <Text variant="micro" tone="faint">
                  {t.privacy.feedbackRatingHint}
                </Text>
              </Row>
              <Row style={{ gap: theme.spacing.sm, justifyContent: 'center' }}>
                {[1, 2, 3, 4, 5].map((n) => {
                  const filled = rating !== null && n <= rating;
                  return (
                    <Pressable
                      key={n}
                      accessibilityRole="button"
                      accessibilityLabel={String(n)}
                      accessibilityState={{ selected: filled }}
                      hitSlop={6}
                      onPress={() => setRating((current) => (current === n ? null : n))}
                      style={({ pressed }) => ({
                        opacity: pressed ? 0.6 : 1,
                        padding: theme.spacing.xs,
                      })}
                    >
                      <Ionicons
                        name={filled ? 'star' : 'star-outline'}
                        size={iconSize.xl}
                        color={filled ? theme.color.brand : theme.color.textFaint}
                      />
                    </Pressable>
                  );
                })}
              </Row>
            </Card>

            <ChipRow<Kind>
              value={kind}
              onChange={setKind}
              options={[
                { value: Kind.General, label: t.privacy.kindGeneral },
                { value: Kind.Bug, label: t.privacy.kindBug },
                { value: Kind.Idea, label: t.privacy.kindIdea },
              ]}
            />

            <Card style={{ gap: theme.spacing.xs }}>
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
              {/* The counter appears only once the box is filling up — a "0/4000"
                  on an empty field is a demand for length nobody made. */}
              {message.length > 0 ? (
                <Text variant="micro" tone="faint" align="right">
                  {`${message.length}/4000`}
                </Text>
              ) : null}
            </Card>

            {/* What rides along, said plainly — the alternative is a person
                wondering, or a report we cannot place on a build. */}
            <Text variant="micro" tone="muted">
              {t.privacy.feedbackAttachNote}
            </Text>

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
