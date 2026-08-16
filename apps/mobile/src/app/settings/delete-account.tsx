import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import {
  Button,
  Callout,
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { deleteMyAccount, erasurePreview } from '@/data/api';
import { fill, plural, useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';
import { useAuth } from '@/lib/auth';

/**
 * Leaving, with the consequence in view before the button.
 *
 * The screen leads with what does *not* go, because that is the part people do
 * not expect: expenses in a shared group are also other people's records, and
 * removing them would silently change somebody else's balance to settle a debt
 * nobody paid. Saying so first is the difference between a promise the app can
 * keep and one it cannot.
 *
 * Export sits above the confirmation on purpose. Somebody who has decided to
 * leave should be offered their data on the way out rather than reminded of it
 * afterwards.
 */
export default function DeleteAccountScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { signOut } = useAuth();

  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const preview = useQuery({ queryKey: ['erasure-preview'], queryFn: erasurePreview });

  const armed = confirm.trim().toUpperCase() === t.privacy.deleteConfirmWord;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await deleteMyAccount(reason.trim() || null);
      // Signing out is the last thing, and only after the data is gone: the
      // reverse order would leave somebody signed out of an account that still
      // holds everything, with no way back in to try again.
      //
      // A failure here is its own report: the data is already gone, so the
      // screen must not claim success while the session is still live.
      await signOut();
      setDone(plural(locale, result.memberships_anonymised ?? 0, t.privacy.deleteSummary));
    } catch (caught) {
      setError(friendlyError(caught, t.privacy.couldNotSave, 'account.delete'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', padding: theme.spacing.xxxl, gap: 16 }}>
          <Text variant="title" align="center">
            {t.privacy.deleteDone}
          </Text>
          <Text variant="caption" tone="muted" align="center">
            {done}
          </Text>
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
            <Text variant="heading">{t.privacy.deleteTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="body" tone="muted">
          {t.privacy.deleteIntro}
        </Text>

        {/* What stays comes first: it is the surprising half. */}
        <Card style={{ gap: theme.spacing.sm, borderWidth: 1, borderColor: theme.color.border }}>
          <Row style={{ gap: theme.spacing.sm }}>
            <Ionicons name="people-outline" size={iconSize.md} color={theme.color.text} />
            <Text variant="subheading">{t.privacy.deleteStaysTitle}</Text>
          </Row>
          <Text variant="caption" tone="muted">
            {t.privacy.deleteStaysBody}
          </Text>
          {/* Labelled, because the first version of this rendered as "1 · 3 · 0
              · INR" — four numbers with nothing saying what any of them
              counted, on the screen where somebody is deciding whether to
              erase themselves. */}
          {preview.data ? (
            <View style={{ gap: 2, paddingTop: theme.spacing.xs }}>
              <Text variant="micro" tone="muted">
                {plural(locale, preview.data.groups_count, t.privacy.previewGroups)}
              </Text>
              <Text variant="micro" tone="muted">
                {plural(locale, preview.data.expenses_authored, t.privacy.previewExpenses)}
              </Text>
              <Text variant="micro" tone="muted">
                {plural(locale, preview.data.settlements_involved, t.privacy.previewSettlements)}
              </Text>
              {preview.data.outstanding_currencies.length > 0 ? (
                <Text variant="micro" tone="negative">
                  {fill(t.privacy.previewOutstanding, {
                    list: preview.data.outstanding_currencies.join(', '),
                  })}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Card>

        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ gap: theme.spacing.sm }}>
            <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
            <Text variant="subheading">{t.privacy.deleteGoesTitle}</Text>
          </Row>
          <Text variant="caption" tone="muted">
            {t.privacy.deleteGoesBody}
          </Text>
        </Card>

        <Button
          label={t.privacy.deleteExportFirst}
          variant="secondary"
          onPress={() => router.push('/settings/export')}
        />

        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="caption" tone="muted">
            {t.privacy.deleteWhyLabel}
          </Text>
          <Card>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder={t.privacy.deleteWhyPlaceholder}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.privacy.deleteWhyLabel}
              multiline
              maxLength={4000}
              style={{
                minHeight: 80,
                fontSize: 15,
                color: theme.color.text,
                textAlignVertical: 'top',
              }}
            />
          </Card>
        </View>

        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="caption" tone="muted">
            {t.privacy.deleteConfirmLabel}
          </Text>
          <Card>
            <TextInput
              value={confirm}
              onChangeText={setConfirm}
              placeholder={t.privacy.deleteConfirmWord}
              placeholderTextColor={theme.color.textFaint}
              accessibilityLabel={t.privacy.deleteConfirmLabel}
              autoCapitalize="characters"
              autoCorrect={false}
              style={{ fontSize: 18, fontWeight: '700', color: theme.color.text }}
            />
          </Card>
        </View>

        {error ? <Callout tone="negative">{error}</Callout> : null}
        {busy ? <ActivityIndicator color={theme.color.negative} /> : null}

        <Button
          label={busy ? t.privacy.deleteWorking : t.privacy.deleteButton}
          size="lg"
          fullWidth
          variant="danger"
          disabled={!armed || busy}
          onPress={() => void run()}
        />
      </ScrollView>
    </Screen>
  );
}
