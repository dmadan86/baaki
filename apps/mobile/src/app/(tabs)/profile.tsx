import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, ScrollView, View } from 'react-native';

import {
  Badge,
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  ListRow,
  MoneyText,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { ProfileAvatar } from '@/components/ProfileAvatar';
import { friendlyError } from '@/lib/errors';
import { SkeletonList } from '@/components/Skeletons';
import { removeAvatar, uploadAvatar } from '@/data/api';
import { useSettledTotals } from '@/data/hooks';
import { isRtlLanguage, LANGUAGE_NAMES, plural, useStrings } from '@/i18n';
import { useLanguage } from '@/i18n/language';
import { useAuth } from '@/lib/auth';
import { pickAvatarPhoto } from '@/lib/image';
import { r2Enabled } from '@/lib/storage';
import { describeGrace, useLock } from '@/lib/lock';
import { SyncNetworkPreference, useSyncNetwork } from '@/lib/syncNetwork';
import { useThemePreference } from '@/lib/theme';

interface SettingsRow {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  route?: string;
  onPress?: () => void;
  /** Ends something. Red title, red icon. */
  destructive?: boolean;
}

function SettingsSection({ title, rows }: { title?: string; rows: SettingsRow[] }) {
  const theme = useTheme();
  return (
    <View>
      {title ? <SectionHeader title={title} /> : null}
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
          backgroundColor: theme.color.buttonPrimary,
        }}
      >
        <Ionicons name="checkmark-done" size={iconSize.base} color={theme.color.onBrand} />
        <Row style={{ gap: 4 }}>
          <MoneyText
            amount={top[1]}
            currency={top[0] as never}
            locale={locale}
            variant="subheading"
            tone="onBrand"
          />
          <Text variant="caption" tone="onBrand">
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
  const { session, profile, isGuest, updateProfile, signOut } = useAuth();
  // A Google/Apple sign-in carries a photo in the session's user metadata, but
  // the profile row only holds one if a trigger copied it across — older
  // accounts have a null `avatar_url` and so showed initials here. Fall back to
  // the provider photo (an https URL that resolves straight through) so the
  // account page shows your face whether or not the column was ever filled.
  // `||`, not `??`: an empty-string avatar (a cleared column, or a provider that
  // sends '') is "no photo", so it must fall through to the next source rather
  // than be handed on as a blank URL.
  const oauthAvatar =
    (session?.user?.user_metadata?.avatar_url as string | undefined) ||
    (session?.user?.user_metadata?.picture as string | undefined) ||
    null;

  const {
    enabled: lockEnabled,
    supported: lockSupported,
    ready: lockReady,
    graceSeconds,
  } = useLock();
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
      setStatus(friendlyError(caught, t.couldNotSave, 'profile.uploadPhoto'));
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
      setStatus(friendlyError(caught, t.couldNotSave, 'profile.removePhoto'));
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

  // Until the stored state and the hardware check are both back, `supported`
  // is still its initial false — saying "no biometrics" then would be a wrong
  // answer on a phone that has them. No hint until it is known.
  const lockSummary = !lockReady
    ? undefined
    : !lockSupported
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
      {/* A titled bar, like every other pushed screen and every settings
          screen worth copying. Without it the avatar sat against the status
          bar with no word for what the page was, and no way back but the
          gesture. Back on the left, the title centred, an equal spacer on the
          right so the title is centred on the screen, not on the gap. */}
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading">{t.account.faceSettings}</Text>
        </View>
        <View style={{ width: 44 }} />
      </Row>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.lg,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* The hero. No card behind it: the avatar, the name and the one number
            are the page's title, and a title does not sit in a box. */}
        <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <ProfileAvatar
            name={profile?.display_name ?? t.account.you}
            avatarUrl={profile?.avatar_url || oauthAvatar}
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

        {/* Account: who you are, how people pay you, what plan you're on. The
            things you edit about *yourself*, above everything you set about the
            app. Storage and your AI keys belong to the account too, so they sit
            here rather than each claiming a section of its own. Only their
            state-bearing rows keep a subtitle; the rest say enough in the label. */}
        <SettingsSection
          title={t.account.sectionAccount}
          rows={[
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
            // "Plan", not "Upgrade": the row opened a page that sells nothing, so
            // its old name promised a purchase the app doesn't have. The honest
            // label states what it is; the hint says the plan is free.
            {
              icon: 'rocket-outline',
              label: t.account.planRow,
              hint: t.account.upgradeHint,
              route: '/settings/upgrade',
            },
            // Only once storage is on R2 is there a per-user byte tally to meter;
            // before that the row would open a screen with nothing to show.
            ...(r2Enabled()
              ? [
                  {
                    icon: 'cloud-outline' as const,
                    label: t.storage.row,
                    route: '/settings/storage',
                  },
                ]
              : []),
          ]}
        />

        {/* Preferences: how the app looks and speaks to you. Language leads — it
            is the one setting somebody may have to reach *before* they can read
            the rows below it, so it cannot sit under them. Shortcut and the
            watch are neither everyday nor state-bearing, so they trail the
            section, quiet, rather than sit among the primary rows. */}
        <SettingsSection
          title={t.account.sectionPreferences}
          rows={[
            {
              icon: 'language-outline',
              label: t.language,
              hint: languageSummary,
              route: '/settings/language',
            },
            {
              icon: 'contrast-outline',
              label: t.account.themeRow,
              hint: themeSummary,
              route: '/settings/theme',
            },
            {
              icon: 'notifications-outline',
              label: t.account.notifications,
              route: '/settings/notifications',
            },
            {
              icon: 'flash-outline',
              label: t.shortcut.title,
              route: '/settings/shortcut',
            },
            {
              icon: 'watch-outline',
              label: t.recent.title,
              route: '/settings/recent',
            },
          ]}
        />

        {/* Data & privacy: your records, and who can reach them. Export and
            import used to sit up among Language and Notifications, which made
            the screen read like an admin console; they belong with the data
            they move. */}
        <SettingsSection
          title={t.account.sectionData}
          rows={[
            {
              icon: 'pricetags-outline',
              label: t.tags.settingsRow,
              route: '/settings/categories',
            },
            {
              icon: 'download-outline',
              label: t.account.exportDataRow,
              route: '/settings/export',
            },
            {
              icon: 'cloud-upload-outline',
              label: t.account.importSplitwise,
              route: '/settings/import',
            },
            {
              icon: 'cloud-outline',
              label: t.sync.title,
              hint: syncNetworkSummary,
              route: '/settings/sync',
            },
            {
              icon: 'shield-checkmark-outline',
              label: t.privacy.row,
              route: '/settings/privacy',
            },
          ]}
        />

        {/* Security: the one group somebody comes to Settings looking *for*.
            Sign out and Delete used to live here too — but ending a session and
            ending an account are not security settings, and burying an
            irreversible act in a list is how it gets tapped by accident. They
            are pulled out below. */}
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
              route: '/settings/devices',
            },
          ]}
        />

        {/* Help: not settings — support and the fine print. Feedback was a row
            dressed as a preference; licenses were buried on the privacy page.
            Both are things you look for at the bottom, so that is where they
            are. */}
        <SettingsSection
          title={t.account.sectionHelp}
          rows={[
            {
              icon: 'chatbubble-ellipses-outline',
              label: t.privacy.feedbackRow,
              route: '/settings/feedback',
            },
            {
              icon: 'document-text-outline',
              label: t.privacy.licensesRow,
              route: '/settings/licenses',
            },
          ]}
        />

        {/* The two irreversible acts, each alone on its own card at the very
            bottom, split from every section and from each other by the same gap
            that separates sections. No header — a danger zone announces itself
            by standing apart, not by a title. Sign out ends the session; Delete
            ends the account. */}
        <SettingsSection
          rows={[
            {
              icon: 'log-out-outline',
              label: t.lock.signOut,
              hint: signOutHint,
              onPress: confirmSignOut,
              destructive: true,
            },
          ]}
        />
        <SettingsSection
          rows={[
            {
              icon: 'trash-outline',
              label: t.privacy.deleteRow,
              hint: t.privacy.deleteRowHint,
              route: '/settings/delete-account',
              destructive: true,
            },
          ]}
        />
      </ScrollView>
    </Screen>
  );
}
