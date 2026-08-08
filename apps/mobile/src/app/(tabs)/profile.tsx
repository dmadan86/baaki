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
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { ProfileAvatar } from '@/components/ProfileAvatar';
import { removeAvatar, uploadAvatar } from '@/data/api';
import { useSettledTotals } from '@/data/hooks';
import {
  deviceCountry,
  isRtlLanguage,
  LANGUAGE_NAMES,
  plural,
  useStrings,
  type UiStrings,
} from '@/i18n';
import { useLanguage } from '@/i18n/language';
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

/**
 * A function of the strings rather than a constant, because the labels are no
 * longer knowable at module load — they depend on which language the reader
 * has chosen, and that can change while the app is open.
 */
function settingsRows(t: UiStrings): SettingsRow[] {
  return [
    {
      icon: 'person-circle-outline',
      label: t.account.yourAccount,
      hint: t.account.yourAccountHint,
      route: '/settings/account',
    },
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
  const { t } = useStrings();
  return (
    <>
      <Button label={t.common.save} fullWidth disabled={!dirty || !valid} onPress={onSave} />
      {status ? (
        <Text variant="caption" tone={status === t.account.saved ? 'positive' : 'negative'}>
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
  const { t } = useStrings();
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
              {t.account.settled}
            </Text>
          </Row>
        ) : (
          <Text variant="caption" tone="brand">
            {t.account.nothingSettledYet}
          </Text>
        )}
      </Row>
      {/* No rate turns rupees into euros, so the rest are counted, not added. */}
      {entries.length > 1 ? (
        <Text variant="micro" tone="faint">
          {plural(locale, entries.length - 1, t.account.otherCurrencies)}
        </Text>
      ) : null}
    </View>
  );
}

export default function ProfileScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { profile, isGuest, updateProfile, signOut } = useAuth();

  const { enabled: lockEnabled, supported: lockSupported, graceSeconds } = useLock();
  const { animated, overridden: motionOverridden } = useMotion();
  const { language, stored: languageChosen, restartNeeded } = useLanguage();

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
        display_name: name.trim() || t.account.you,
        payment_rail: trimmed === '' ? null : rail,
        payment_handle: trimmed === '' ? null : trimmed,
        // Kept in step while the older screens still read it. A handle on any
        // other rail is not a UPI ID and must not masquerade as one.
        default_vpa: rail === 'upi' && trimmed !== '' ? trimmed : null,
      });
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
          </View>
        </View>

        <SegmentedTabs<Face>
          value={face}
          onChange={setFace}
          tabs={[
            // Not `t.profile` — that reads "Account", which is the whole
            // screen. A tab has to name the part, not the page.
            { value: 'you', label: t.account.faceYou },
            { value: 'paying', label: t.account.facePaying },
            { value: 'settings', label: t.account.faceSettings },
          ]}
        />

        {face === 'you' ? (
          <>
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
          </>
        ) : null}

        {face === 'paying' ? (
          <Card style={{ gap: theme.spacing.lg }}>
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="caption" tone="muted">
                {t.account.howPeoplePayYou}
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
                    accessibilityLabel={t.account.yourRailDetails.replace('{rail}', railInfo.label)}
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
                      ? t.account.handleWrong.replace('{hint}', railInfo.handleHint.toLowerCase())
                      : railInfo.link
                        ? t.account.railLinkNote
                        : t.account.railManualNote}
                  </Text>
                </>
              ) : (
                <Text variant="micro" tone="faint">
                  {t.account.nothingToAdd}
                </Text>
              )}
            </View>
            <SaveRow dirty={dirty} valid={handleValid} status={status} onSave={() => void save()} />
          </Card>
        ) : null}

        {face !== 'settings' ? null : (
          <>
            {/* Its own section, above the settings rather than among them.
                Paying for something is not a preference, and a row that sells
                you something sitting between Notifications and Export is a row
                dressed up as a setting. */}
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

            {/* Language leads. It was fifth, under Import, and it is the one
                setting somebody may have to reach *before* they can read the
                four above it — a row you can only find by reading past rows you
                cannot read is a row that is not there. */}
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
                  icon: 'sparkles-outline',
                  label: t.account.motionRow,
                  hint: motionSummary,
                  route: '/settings/motion',
                },
              ]}
            />

            {/* Security is its own section rather than one row among many: it is
            the only group of settings somebody comes looking for. */}
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
                  icon: 'log-out-outline',
                  label: t.lock.signOut,
                  hint: signOutHint,
                  onPress: confirmSignOut,
                },
                // Last row of the last section, under Sign out. It first sat in
                // the middle of the settings list, because `settingsRows` is
                // spread before Motion is appended — which put an irreversible
                // action between "import a spreadsheet" and "animations on".
                // Running it on a device is what showed that.
                {
                  icon: 'trash-outline',
                  label: t.privacy.deleteRow,
                  hint: t.privacy.deleteRowHint,
                  route: '/settings/delete-account',
                },
              ]}
            />
          </>
        )}

        <Text variant="micro" tone="faint" align="center">
          {t.account.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
