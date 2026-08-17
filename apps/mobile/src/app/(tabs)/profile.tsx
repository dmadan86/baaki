import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, ScrollView, View } from 'react-native';

import {
  Badge,
  Card,
  directionalIcon,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SkeletonList } from '@/components/Skeletons';
import { removeAvatar, uploadAvatar } from '@/data/api';
import { useSettledTotals } from '@/data/hooks';
import { isRtlLanguage, LANGUAGE_NAMES, plural, useStrings, type UiStrings } from '@/i18n';
import { useLanguage } from '@/i18n/language';
import { useAuth } from '@/lib/auth';
import { pickAvatarPhoto } from '@/lib/image';
import { describeGrace, useLock } from '@/lib/lock';
import { useMotion } from '@/lib/motion';
import { SyncNetworkPreference, useSyncNetwork } from '@/lib/syncNetwork';
import { useThemePreference } from '@/lib/theme';

interface SettingsRow {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  route?: string;
  onPress?: () => void;
  /** Ends something. Red title, red icon. */
  destructive?: boolean;
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
                destructive={item.destructive}
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
                      backgroundColor: item.destructive
                        ? theme.color.negativeSoft
                        : live
                          ? theme.color.brandSoft
                          : theme.color.surfaceMuted,
                    }}
                  >
                    <Ionicons
                      name={item.icon}
                      size={iconSize.md}
                      color={
                        item.destructive
                          ? theme.color.negative
                          : live
                            ? theme.color.brand
                            : theme.color.textMuted
                      }
                    />
                  </View>
                }
                trailing={
                  item.route ? (
                    <Ionicons
                      name={directionalIcon('chevron-forward')}
                      size={iconSize.md}
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

/**
 * A function of the strings rather than a constant, because the labels are no
 * longer knowable at module load — they depend on which language the reader
 * has chosen, and that can change while the app is open.
 */
function settingsRows(t: UiStrings): SettingsRow[] {
  return [
    {
      icon: 'notifications-outline',
      label: t.account.notifications,
      hint: t.account.notificationsHint,
      route: '/settings/notifications',
    },
    {
      icon: 'download-outline',
      label: t.account.exportDataRow,
      hint: t.account.exportHint,
      route: '/settings/export',
    },
    {
      icon: 'cloud-upload-outline',
      label: t.account.importSplitwise,
      hint: t.account.importHint,
      route: '/settings/import',
    },
    {
      icon: 'cloud-done-outline',
      label: t.backup.title,
      hint: t.backup.subtitle,
      route: '/settings/backup',
    },
    {
      icon: 'chatbubble-ellipses-outline',
      label: t.privacy.feedbackRow,
      hint: t.privacy.feedbackRowHint,
      route: '/settings/feedback',
    },
    {
      icon: 'shield-checkmark-outline',
      label: t.privacy.row,
      hint: t.privacy.rowHint,
      route: '/settings/privacy',
    },
  ];
}

/**
 * Your account and Paying used to be two faces of this screen, switched with a
 * segmented control that sat between the hero and the settings. They are the
 * two things a person edits about themselves rather than about the app, so they
 * now lead the settings list as their own rows — each a page of its own,
 * reached the same way every other setting is.
 *
 * "You" (just the name) and "Your account" (email, phone, sign-in links) were
 * one thing split across two screens, so they are folded into a single "Your
 * account" page that carries the name too.
 */
function profileRows(t: UiStrings): SettingsRow[] {
  return [
    {
      icon: 'person-circle-outline',
      label: t.account.yourAccount,
      hint: t.account.yourAccountHint,
      route: '/settings/account',
    },
    {
      icon: 'card-outline',
      label: t.account.facePaying,
      hint: t.account.howPeoplePayYou,
      route: '/settings/paying',
    },
  ];
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
  const { t } = useStrings();
  const totals = useSettledTotals(profileId);

  const entries = [...(totals.data ?? new Map<string, bigint>())].sort((a, b) =>
    b[1] === a[1] ? 0 : b[1] > a[1] ? 1 : -1,
  );
  const top = entries[0];

  // Nothing settled yet is not worth an empty badge — the pill only earns its
  // place once a real figure has changed hands. Until then, show nothing.
  if (!top) return null;

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
        <Ionicons name="checkmark-done" size={iconSize.base} color={theme.color.brand} />
        <Row style={{ gap: 4 }}>
          <MoneyText
            amount={top[1]}
            currency={top[0] as never}
            locale={locale}
            variant="subheading"
            tone="brand"
          />
          <Text variant="caption" tone="brand">
            {t.account.settled}
          </Text>
        </Row>
      </Row>
      {/* No rate turns rupees into euros, so the rest are counted, not added. */}
      {entries.length > 1 ? (
        <Text variant="micro" tone="muted">
          {plural(locale, entries.length - 1, t.account.otherCurrencies)}
        </Text>
      ) : null}
    </View>
  );
}

export default function ProfileScreen() {
  const { profile } = useAuth();
  // The hero seeds nothing editable now, but the settings summaries below still
  // read the profile — hold on a skeleton until it arrives so the first paint
  // is the real thing, not a flash of defaults.
  if (!profile) {
    return (
      <Screen>
        <SkeletonList rows={6} />
      </Screen>
    );
  }
  return <ProfileForm key={profile.id} />;
}

function ProfileForm() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { profile, isGuest, updateProfile, signOut } = useAuth();

  const { enabled: lockEnabled, supported: lockSupported, graceSeconds } = useLock();
  const { animated, overridden: motionOverridden } = useMotion();
  const { preference: syncNetwork } = useSyncNetwork();
  const { preference: themePreference, overridden: themeOverridden } = useThemePreference();
  const { language, stored: languageChosen, restartNeeded } = useLanguage();

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
    Alert.alert(t.account.yourPhoto, undefined, [
      { text: t.account.chooseNewPhoto, onPress: () => void choosePhoto() },
      { text: t.common.remove, style: 'destructive', onPress: () => void clearPhoto() },
      { text: t.common.cancel, style: 'cancel' },
    ]);
  };

  /**
   * The row says the language in its own script. It is the one settings row
   * whose subtitle has to be legible to somebody who cannot read the rest of
   * the screen — which is exactly the person going looking for it.
   *
   * The restart hint has two directions and they are not interchangeable.
   * Telling somebody who has just chosen English that reopening will "mirror
   * it" describes the opposite of what will happen, on the one screen they are
   * looking at to find out why it has not.
   */
  const languageSummary = restartNeeded
    ? (isRtlLanguage(language)
        ? t.account.languageRestartHint
        : t.account.languageRestartHintBack
      ).replace('{language}', LANGUAGE_NAMES[language].own)
    : languageChosen === null
      ? t.account.languageFollowingPhone.replace('{language}', LANGUAGE_NAMES[language].own)
      : `${LANGUAGE_NAMES[language].own} · ${LANGUAGE_NAMES[language].english}`;

  const themeSummary = themeOverridden
    ? themePreference === 'dark'
      ? t.theme.dark
      : t.theme.light
    : t.theme.followingPhone;

  const syncNetworkSummary =
    syncNetwork === SyncNetworkPreference.Cellular
      ? t.sync.cellular
      : syncNetwork === SyncNetworkPreference.Both
        ? t.sync.both
        : t.sync.wifi;

  const motionSummary = motionOverridden
    ? animated
      ? t.account.motionOn
      : t.account.motionOff
    : animated
      ? t.account.motionFollowingOn
      : t.account.motionFollowingOff;

  const lockSummary = !lockSupported
    ? t.account.lockNoBiometrics
    : lockEnabled
      ? t.account.lockOn.replace('{when}', describeGrace(graceSeconds, t, locale).toLowerCase())
      : t.account.lockOff;

  const signOutHint = isGuest ? t.account.signOutGuestHint : t.account.signOutHint;

  const confirmSignOut = (): void => {
    Alert.alert(
      t.lock.signOutQuestion,
      isGuest ? t.lock.signOutGuestWarning : t.lock.signOutReassure,
      [
        { text: t.lock.staySignedIn, style: 'cancel' },
        { text: t.lock.signOut, style: 'destructive', onPress: () => void signOut() },
      ],
    );
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
        {/* The hero. No card behind it: the avatar, the name and the one number
            are the page's title, and a title does not sit in a box. */}
        <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.lg }}>
          <ProfileAvatar
            name={profile?.display_name ?? t.account.you}
            avatarUrl={profile?.avatar_url}
            size={92}
            onPress={profile ? photoOptions : undefined}
            busy={photoBusy}
          />
          <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Text variant="title">{profile?.display_name ?? t.account.you}</Text>
              {/* The badge says the account has no email or phone on it. When
                  somebody has not renamed themselves it repeats the name they
                  were given, which reads as a bug rather than a fact. */}
              {isGuest && profile?.display_name !== 'Guest' ? (
                <Badge label={t.common.guest} />
              ) : null}
            </Row>
            <SettledPill profileId={profile?.id ?? null} locale={locale} />
            {/* Photo errors have nowhere else to land now the form is gone. */}
            {status ? (
              <Text variant="caption" tone="negative">
                {status}
              </Text>
            ) : null}
          </View>
        </View>

        {/* You and Paying lead: the two things you edit about yourself, above
            everything you set about the app. */}
        <SettingsSection title={t.account.sectionProfile} rows={profileRows(t)} />

        {/* Its own section, above the settings rather than among them. Paying
            for something is not a preference, and a row that sells you something
            sitting between Notifications and Export is a row dressed up as a
            setting. */}
        <SettingsSection
          title={t.account.sectionBaaki}
          rows={[
            {
              icon: 'rocket-outline',
              label: t.upgrade,
              hint: t.account.upgradeHint,
              route: '/settings/upgrade',
            },
          ]}
        />

        {/* Bring your own model key. Its own section because it is neither a
            preference nor a Baaki purchase — it is a credential the reader
            supplies, held on the device, to run the model-powered features on
            their own account. */}
        <SettingsSection
          title={t.account.sectionAi}
          rows={[
            {
              icon: 'key-outline',
              label: t.account.aiKeysRow,
              hint: t.account.aiKeysHint,
              route: '/settings/ai-keys',
            },
          ]}
        />

        {/* Language leads. It was fifth, under Import, and it is the one setting
            somebody may have to reach *before* they can read the four above it —
            a row you can only find by reading past rows you cannot read is a row
            that is not there. */}
        <SettingsSection
          title={t.account.sectionSettings}
          rows={[
            {
              icon: 'language-outline',
              label: t.language,
              hint: languageSummary,
              route: '/settings/language',
            },
            ...settingsRows(t),
            {
              icon: 'contrast-outline',
              label: t.account.themeRow,
              hint: themeSummary,
              route: '/settings/theme',
            },
            {
              icon: 'sparkles-outline',
              label: t.account.motionRow,
              hint: motionSummary,
              route: '/settings/motion',
            },
            {
              icon: 'cloud-outline',
              label: t.sync.title,
              hint: syncNetworkSummary,
              route: '/settings/sync',
            },
          ]}
        />

        {/* Security is its own section rather than one row among many: it is the
            only group of settings somebody comes looking for. */}
        <SettingsSection
          title={t.account.sectionSecurity}
          rows={[
            {
              icon: 'finger-print-outline',
              label: t.lock.appLock,
              hint: lockSummary,
              route: '/settings/lock',
            },
            {
              icon: 'phone-portrait-outline',
              label: t.devices.row,
              hint: t.devices.rowHint,
              route: '/settings/devices',
            },
            {
              icon: 'log-out-outline',
              label: t.lock.signOut,
              hint: signOutHint,
              onPress: confirmSignOut,
              destructive: true,
            },
            // Last row of the last section, under Sign out. It first sat in the
            // middle of the settings list, because `settingsRows` is spread
            // before Motion is appended — which put an irreversible action
            // between "import a spreadsheet" and "animations on". Running it on
            // a device is what showed that.
            {
              icon: 'trash-outline',
              label: t.privacy.deleteRow,
              hint: t.privacy.deleteRowHint,
              route: '/settings/delete-account',
              destructive: true,
            },
          ]}
        />

        <Text variant="micro" tone="muted" align="center">
          {t.account.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
