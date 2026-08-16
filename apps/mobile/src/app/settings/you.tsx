/**
 * You — your name, and how you appear to everyone else.
 *
 * Was the first face of the profile screen (a SegmentedTab). It is now a row in
 * the settings list, so the profile tab is a settings list and nothing else,
 * and the name lives on a page of its own rather than sharing a screen with the
 * payment rails and every preference.
 *
 * It edits one field — the display name — and writes only that. The photo is
 * still changed from the profile hero; the payment details have their own page.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, TextInput, View } from 'react-native';

import {
  Badge,
  Button,
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

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function YouScreen() {
  const { profile } = useAuth();
  // Seed the form from `profile` exactly once, keyed on the id, so Save can
  // never write an empty seed back over a real row before it has loaded.
  if (!profile) {
    return (
      <Screen>
        <View />
      </Screen>
    );
  }
  return <YouForm key={profile.id} />;
}

function YouForm() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { profile, isGuest, updateProfile } = useAuth();

  const [name, setName] = useState(profile?.display_name ?? '');
  const [status, setStatus] = useState<string | null>(null);

  const dirty = name.trim() !== (profile?.display_name ?? '');

  const save = async (): Promise<void> => {
    setStatus(null);
    try {
      // Only the name. The empty name falls back to "You" so nobody is nameless.
      await updateProfile({ display_name: name.trim() || t.account.you });
      setStatus(t.account.saved);
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
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
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
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
            <Text variant="heading">{t.account.faceYou}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="caption" tone="muted">
              {t.account.displayName}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              accessibilityLabel={t.account.displayName}
              placeholder={t.common.yourName}
              placeholderTextColor={theme.color.textFaint}
              style={{
                fontSize: 18,
                fontWeight: '600',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
          </View>
          <Button
            label={t.common.save}
            fullWidth
            disabled={!dirty}
            onPress={() => void save()}
          />
          {status ? (
            <Text
              variant="caption"
              tone={status === t.account.saved ? 'positive' : 'negative'}
            >
              {status}
            </Text>
          ) : null}
        </Card>

        {isGuest ? (
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.md }}>
            <Text variant="subheading" tone="brand">
              {t.account.guestAccount}
            </Text>
            <Text variant="caption" tone="muted">
              {t.account.guestAccountBody}
            </Text>
            <Button
              label={t.account.addYourDetails}
              variant="secondary"
              size="sm"
              onPress={() => router.push('/settings/account')}
            />
          </Card>
        ) : null}

        <Row style={{ gap: theme.spacing.sm, justifyContent: 'center' }}>
          <Badge label={t.freeForever} tone="positive" />
          <Badge label={locale} tone="brand" />
        </Row>
      </ScrollView>
    </Screen>
  );
}
