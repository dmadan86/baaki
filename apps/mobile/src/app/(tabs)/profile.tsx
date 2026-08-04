import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, TextInput, View } from 'react-native';

import { isValidVpa } from '@baaki/core';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

const COMING_LATER: { icon: keyof typeof Ionicons.glyphMap; label: string; hint: string }[] = [
  { icon: 'notifications-outline', label: 'Notifications', hint: 'Only what involves me (M4)' },
  { icon: 'download-outline', label: 'Export data', hint: 'JSON + CSV, lossless (M5)' },
  { icon: 'cloud-upload-outline', label: 'Import from Splitwise', hint: 'M3' },
  { icon: 'lock-closed-outline', label: 'App lock', hint: 'Biometric / PIN' },
];

export default function ProfileScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { profile, isGuest, updateProfile, signOut } = useAuth();

  const [name, setName] = useState(profile?.display_name ?? '');
  const [vpa, setVpa] = useState(profile?.default_vpa ?? '');
  const [status, setStatus] = useState<string | null>(null);

  const vpaValid = vpa.trim() === '' || isValidVpa(vpa.trim());
  const dirty =
    name.trim() !== (profile?.display_name ?? '') || vpa.trim() !== (profile?.default_vpa ?? '');

  const save = async (): Promise<void> => {
    setStatus(null);
    try {
      await updateProfile({
        display_name: name.trim() || 'You',
        default_vpa: vpa.trim() === '' ? null : vpa.trim(),
      });
      setStatus('Saved');
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: 170,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text variant="title" style={{ paddingTop: theme.spacing.md }}>
          {t.profile}
        </Text>

        <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          <Avatar name={profile?.display_name ?? 'You'} size={78} />
          <Row style={{ gap: theme.spacing.sm }}>
            <Badge label={t.freeForever} tone="positive" />
            <Badge label={locale} tone="brand" />
            {isGuest ? <Badge label="Guest" /> : null}
          </Row>
        </Card>

        <Card style={{ gap: theme.spacing.lg }}>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="caption" tone="muted">
              Display name
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              accessibilityLabel="Display name"
              placeholder="Your name"
              placeholderTextColor={theme.color.textFaint}
              style={{
                fontSize: 18,
                fontWeight: '600',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
          </View>

          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="caption" tone="muted">
              UPI ID
            </Text>
            <TextInput
              value={vpa}
              onChangeText={setVpa}
              autoCapitalize="none"
              accessibilityLabel="UPI ID"
              placeholder="you@bank"
              placeholderTextColor={theme.color.textFaint}
              style={{
                fontSize: 18,
                fontWeight: '600',
                color: vpaValid ? theme.color.text : theme.color.negative,
                paddingVertical: theme.spacing.sm,
              }}
            />
            <Text variant="micro" tone={vpaValid ? 'faint' : 'negative'}>
              {vpaValid
                ? 'People settling with you get a one-tap UPI intent. Baaki never handles the money.'
                : 'That does not look like a UPI ID (name@bank).'}
            </Text>
          </View>

          <Button label="Save" disabled={!dirty || !vpaValid} onPress={() => void save()} />
          {status ? (
            <Text variant="caption" tone={status === 'Saved' ? 'positive' : 'negative'}>
              {status}
            </Text>
          ) : null}
        </Card>

        {isGuest ? (
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">
              Guest account
            </Text>
            <Text variant="caption" tone="muted">
              Adding a phone number keeps everything you have entered and lets you use Baaki on
              another device. Linking accounts ships with the invite flow (M3).
            </Text>
          </Card>
        ) : null}

        <View>
          <SectionHeader title="Coming in later milestones" />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {COMING_LATER.map((item, index) => (
              <View key={item.label}>
                <ListRow
                  title={item.label}
                  subtitle={item.hint}
                  leading={
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: theme.radius.pill,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.color.surfaceMuted,
                      }}
                    >
                      <Ionicons name={item.icon} size={18} color={theme.color.textMuted} />
                    </View>
                  }
                />
                {index < COMING_LATER.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        </View>

        <Button label="Sign out" variant="ghost" fullWidth onPress={() => void signOut()} />

        <Text variant="micro" tone="faint" align="center">
          Baaki · the ledger is free forever. We only ever charge for convenience.
        </Text>
      </ScrollView>
    </Screen>
  );
}
