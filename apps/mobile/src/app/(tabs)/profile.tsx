import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, ScrollView, TextInput, View } from 'react-native';

import { defaultRailFor, isValidHandle, railById, railsFor } from '@baaki/core';
import {
  Badge,
  Button,
  Card,
  ChipRow,
  directionalIcon,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  SegmentedTabs,
  Text,
  useTheme,
} from '@baaki/ui';

import { ProfileAvatar } from '@/components/ProfileAvatar';
import { removeAvatar, uploadAvatar } from '@/data/api';
import { useSettledTotals } from '@/data/hooks';
import { deviceCountry, useStrings } from '@/i18n';
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
                    <Ionicons
                      name={directionalIcon('chevron-forward')}
                      size={18}
                      color={theme.color.textFaint}
                    />
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

/** The three faces of this screen. */
type Face = 'you' | 'paying' | 'settings';

/**
 * One Save, shown on whichever face you are looking at.
 *
 * It writes the whole profile, not the tab: a name typed on one face and a UPI
 * ID typed on another are one edit to one row, and asking somebody to go back
 * and save each face separately would invent a rule the data does not have.
 */
function SaveRow({
  dirty,
  valid,
  status,
  onSave,
}: {
  dirty: boolean;
  valid: boolean;
  status: string | null;
  onSave: () => void;
}) {
  return (
    <>
      <Button label="Save" fullWidth disabled={!dirty || !valid} onPress={onSave} />
      {status ? (
        <Text variant="caption" tone={status === 'Saved' ? 'positive' : 'negative'}>
          {status}
        </Text>
      ) : null}
    </>
  );
}

/**
 * What has actually changed hands through you.
 *
 * The board this is drawn from puts a points total here. Baaki has no points
 * and should not invent any: a score next to somebody's money is a number that
 * means nothing pretending to sit with numbers that mean everything. This is
 * the true version of the same idea — one figure, earned, that appears nowhere
 * else in the app.
 *
 * It is not a balance and is deliberately not coloured like one. Paying and
 * being paid are the same fact here: a debt closed.
 */
function SettledPill({ profileId, locale }: { profileId: string | null; locale: string }) {
  const theme = useTheme();
  const totals = useSettledTotals(profileId);

  const entries = [...(totals.data ?? new Map<string, bigint>())].sort((a, b) =>
    b[1] === a[1] ? 0 : b[1] > a[1] ? 1 : -1,
  );
  const top = entries[0];

  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.xs }}>
      <Row
        style={{
          gap: theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.color.brandSoft,
        }}
      >
        <Ionicons name="checkmark-done" size={16} color={theme.color.brand} />
        {top ? (
          <Row style={{ gap: 4 }}>
            <MoneyText
              amount={top[1]}
              currency={top[0] as never}
              locale={locale}
              variant="subheading"
              tone="brand"
            />
            <Text variant="caption" tone="brand">
              settled
            </Text>
          </Row>
        ) : (
          <Text variant="caption" tone="brand">
            Nothing settled yet
          </Text>
        )}
      </Row>
      {/* No rate turns rupees into euros, so the rest are counted, not added. */}
      {entries.length > 1 ? (
        <Text variant="micro" tone="faint">
          {`and ${entries.length - 1} other ${entries.length === 2 ? 'currency' : 'currencies'}`}
        </Text>
      ) : null}
    </View>
  );
}

export default function ProfileScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const { profile, isGuest, updateProfile, signOut } = useAuth();

  const { enabled: lockEnabled, supported: lockSupported, graceSeconds } = useLock();
  const { animated, overridden: motionOverridden } = useMotion();

  const [name, setName] = useState(profile?.display_name ?? '');
  /**
   * How this person is paid. Falls back through the rail pair, then the old
   * `default_vpa` — anything written before rails existed can only have been a
   * UPI ID, and nobody should have to type theirs again.
   */
  const country = profile?.country_code ?? deviceCountry();
  const [rail, setRail] = useState(
    profile?.payment_rail ?? (profile?.default_vpa ? 'upi' : defaultRailFor(country)),
  );
  const [handle, setHandle] = useState(profile?.payment_handle ?? profile?.default_vpa ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [face, setFace] = useState<Face>('you');

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

  const railInfo = railById(rail);
  const handleValid = handle.trim() === '' || isValidHandle(rail, handle.trim());
  const dirty =
    name.trim() !== (profile?.display_name ?? '') ||
    handle.trim() !== (profile?.payment_handle ?? profile?.default_vpa ?? '') ||
    rail !== (profile?.payment_rail ?? (profile?.default_vpa ? 'upi' : rail));

  const save = async (): Promise<void> => {
    setStatus(null);
    const trimmed = handle.trim();
    try {
      await updateProfile({
        display_name: name.trim() || 'You',
        payment_rail: trimmed === '' ? null : rail,
        payment_handle: trimmed === '' ? null : trimmed,
        // Kept in step while the older screens still read it. A handle on any
        // other rail is not a UPI ID and must not masquerade as one.
        default_vpa: rail === 'upi' && trimmed !== '' ? trimmed : null,
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
        {/* The hero. No card behind it: the avatar, the name and the one number
            are the page's title, and a title does not sit in a box. */}
        <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.lg }}>
          <ProfileAvatar
            name={profile?.display_name ?? 'You'}
            avatarUrl={profile?.avatar_url}
            size={92}
            onPress={profile ? photoOptions : undefined}
            busy={photoBusy}
          />
          <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Text variant="title">{profile?.display_name ?? 'You'}</Text>
              {/* The badge says the account has no email or phone on it. When
                  somebody has not renamed themselves it repeats the name they
                  were given, which reads as a bug rather than a fact. */}
              {isGuest && profile?.display_name !== 'Guest' ? <Badge label="Guest" /> : null}
            </Row>
            <SettledPill profileId={profile?.id ?? null} locale={locale} />
          </View>
        </View>

        <SegmentedTabs<Face>
          value={face}
          onChange={setFace}
          tabs={[
            // Not `t.profile` — that reads "Account", which is the whole
            // screen. A tab has to name the part, not the page.
            { value: 'you', label: 'You' },
            { value: 'paying', label: 'Paying' },
            { value: 'settings', label: 'Settings' },
          ]}
        />

        {face === 'you' ? (
          <>
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
              <SaveRow
                dirty={dirty}
                valid={handleValid}
                status={status}
                onSave={() => void save()}
              />
            </Card>

            {isGuest ? (
              <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.md }}>
                <Text variant="subheading" tone="brand">
                  Guest account
                </Text>
                <Text variant="caption" tone="muted">
                  Everything you have entered is already saved and yours. Add an email or phone
                  number whenever you want to reach it from another phone — it keeps this account
                  rather than starting a new one.
                </Text>
                <Button
                  label="Add your details"
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
          </>
        ) : null}

        {face === 'paying' ? (
          <Card style={{ gap: theme.spacing.lg }}>
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                How people pay you
              </Text>
              {/* Whatever this person's country uses. In India that still starts
                  on UPI; in the UAE it starts on Aani. */}
              <ChipRow<string>
                value={rail}
                onChange={setRail}
                options={railsFor(country).map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                }))}
              />
              {railInfo && railInfo.handle !== 'none' ? (
                <>
                  <TextInput
                    value={handle}
                    onChangeText={setHandle}
                    autoCapitalize="none"
                    accessibilityLabel={`Your ${railInfo.label} details`}
                    placeholder={railInfo.handleHint}
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 18,
                      fontWeight: '600',
                      color: handleValid ? theme.color.text : theme.color.negative,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                  <Text variant="micro" tone={handleValid ? 'faint' : 'negative'}>
                    {!handleValid
                      ? `That does not look like ${railInfo.handleHint.toLowerCase()}.`
                      : railInfo.link
                        ? 'People settling with you get a one-tap payment. Baaki never handles the money.'
                        : 'People settling with you see this to pay you from their own bank app. Baaki never handles the money.'}
                  </Text>
                </>
              ) : (
                <Text variant="micro" tone="faint">
                  Nothing to add — people will record what they paid you by hand.
                </Text>
              )}
            </View>
            <SaveRow dirty={dirty} valid={handleValid} status={status} onSave={() => void save()} />
          </Card>
        ) : null}

        {face !== 'settings' ? null : (
          <>
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
                {
                  icon: 'log-out-outline',
                  label: 'Sign out',
                  hint: signOutHint,
                  onPress: confirmSignOut,
                },
              ]}
            />
          </>
        )}

        <Text variant="micro" tone="faint" align="center">
          Baaki · the ledger is free forever. We only ever charge for convenience.
        </Text>
      </ScrollView>
    </Screen>
  );
}
