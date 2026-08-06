import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, ScrollView, TextInput, View } from 'react-native';

import { isValidVpa } from '@baaki/core';
import {
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

import { ProfileAvatar } from '@/components/ProfileAvatar';
import { removeAvatar, uploadAvatar } from '@/data/api';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { pickAvatarPhoto } from '@/lib/image';
import { describeGrace, useLock } from '@/lib/lock';
import { useMotion } from '@/lib/motion';

interface SettingsRow {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  route?: string;
  onPress?: () => void;
}

function SettingsSection({ title, rows }: { title: string; rows: SettingsRow[] }) {
  const theme = useTheme();
  return (
    <View>
      <SectionHeader title={title} />
      <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
        {rows.map((item, index) => {
          const live = Boolean(item.route ?? item.onPress);
          return (
            <View key={item.label}>
              <ListRow
                title={item.label}
                subtitle={item.hint}
                onPress={
                  item.onPress ?? (item.route ? () => router.push(item.route as never) : undefined)
                }
                leading={
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: theme.radius.pill,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: live ? theme.color.brandSoft : theme.color.surfaceMuted,
                    }}
                  >
                    <Ionicons
                      name={item.icon}
                      size={18}
                      color={live ? theme.color.brand : theme.color.textMuted}
                    />
                  </View>
                }
                trailing={
                  item.route ? (
                    <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />
                  ) : null
                }
              />
              {index < rows.length - 1 ? (
                <View style={{ height: 1, backgroundColor: theme.color.border }} />
              ) : null}
            </View>
          );
        })}
      </Card>
    </View>
  );
}

const SETTINGS: SettingsRow[] = [
  {
    icon: 'person-circle-outline',
    label: 'Your account',
    hint: 'Add an email or phone, or carry on as a guest',
    route: '/settings/account',
  },
  {
    icon: 'notifications-outline',
    label: 'Notifications',
    hint: 'Only what involves me',
    route: '/settings/notifications',
  },
  {
    icon: 'download-outline',
    label: 'Export data',
    hint: 'JSON + CSV, lossless, free',
    route: '/settings/export',
  },
  {
    icon: 'cloud-upload-outline',
    label: 'Import from Splitwise',
    hint: 'Bring a group across from a CSV export',
    route: '/settings/import',
  },
];

export default function ProfileScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { profile, isGuest, updateProfile, signOut } = useAuth();

  const { enabled: lockEnabled, supported: lockSupported, graceSeconds } = useLock();
  const { animated, overridden: motionOverridden } = useMotion();

  const [name, setName] = useState(profile?.display_name ?? '');
  const [vpa, setVpa] = useState(profile?.default_vpa ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  /**
   * Pick, shrink, upload, then tell the profile where it landed. The upload
   * writes `avatar_url` itself; this repeats it through `updateProfile` so the
   * copy held in context matches without a round trip.
   */
  const choosePhoto = async (): Promise<void> => {
    if (!profile) return;
    const picked = await pickAvatarPhoto();
    if (!picked) return;

    setStatus(null);
    setPhotoBusy(true);
    try {
      const path = await uploadAvatar({
        profileId: profile.id,
        base64: picked.base64,
        mimeType: picked.mimeType,
      });
      await updateProfile({ avatar_url: path });
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPhotoBusy(false);
    }
  };

  const clearPhoto = async (): Promise<void> => {
    if (!profile) return;
    setPhotoBusy(true);
    try {
      await removeAvatar(profile.id, profile.avatar_url);
      await updateProfile({ avatar_url: null });
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPhotoBusy(false);
    }
  };

  const photoOptions = (): void => {
    if (!profile?.avatar_url) {
      void choosePhoto();
      return;
    }
    Alert.alert('Your photo', undefined, [
      { text: 'Choose a new one', onPress: () => void choosePhoto() },
      { text: 'Remove', style: 'destructive', onPress: () => void clearPhoto() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const motionSummary = motionOverridden
    ? animated
      ? 'Screen animations on'
      : 'Screen animations off'
    : `Following your phone — animations ${animated ? 'on' : 'off'}`;

  const lockSummary = !lockSupported
    ? 'This device has no biometrics set up'
    : lockEnabled
      ? `On · asks ${describeGrace(graceSeconds).toLowerCase()}`
      : 'Off — anyone holding your phone can read the ledger';

  const signOutHint = isGuest
    ? 'This guest account lives on this device only'
    : 'Nothing is deleted; sign back in whenever';

  const confirmSignOut = (): void => {
    Alert.alert(
      'Sign out?',
      isGuest
        ? 'This is a guest account, so signing out leaves no way back into it. Add an email or phone number first if you want to keep it.'
        : 'You can sign back in whenever you like. Nothing is deleted.',
      [
        { text: 'Stay signed in', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
      ],
    );
  };

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
          <ProfileAvatar
            name={profile?.display_name ?? 'You'}
            avatarUrl={profile?.avatar_url}
            size={78}
            onPress={profile ? photoOptions : undefined}
            busy={photoBusy}
          />
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
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.md }}>
            <Text variant="subheading" tone="brand">
              Guest account
            </Text>
            <Text variant="caption" tone="muted">
              Everything you have entered is already saved and yours. Add an email or phone number
              whenever you want to reach it from another phone — it keeps this account rather than
              starting a new one.
            </Text>
            <Button
              label="Add your details"
              variant="secondary"
              size="sm"
              onPress={() => router.push('/settings/account')}
            />
          </Card>
        ) : null}

        <SettingsSection
          title="Settings"
          rows={[
            ...SETTINGS,
            {
              icon: 'sparkles-outline',
              label: 'Motion',
              hint: motionSummary,
              route: '/settings/motion',
            },
          ]}
        />

        {/* Security is its own section rather than one row among many: it is
            the only group of settings somebody comes looking for. */}
        <SettingsSection
          title="Security"
          rows={[
            {
              icon: 'finger-print-outline',
              label: 'App lock',
              hint: lockSummary,
              route: '/settings/lock',
            },
            { icon: 'log-out-outline', label: 'Sign out', hint: signOutHint, onPress: confirmSignOut },
          ]}
        />

        <Text variant="micro" tone="faint" align="center">
          Baaki · the ledger is free forever. We only ever charge for convenience.
        </Text>
      </ScrollView>
    </Screen>
  );
}
