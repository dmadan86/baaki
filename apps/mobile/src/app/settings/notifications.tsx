import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  directionalIcon,
  IconButton,
  Row,
  Screen,
  SectionHeader,
  Text,
  Toggle,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import {
  DEFAULT_NOTIFICATION_PREFS,
  fetchNotificationPrefs,
  saveNotificationPrefs,
  type NotificationPrefs,
} from '@/data/api';
import { useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { enablePush, PushFailure, PushPermission, pushPermission } from '@/lib/push';

function rows(t: UiStrings): { key: keyof NotificationPrefs; title: string; body: string }[] {
  return [
    {
      key: 'involvesMe',
      title: t.notifications.involvesMe,
      body: t.notifications.involvesMeBody,
    },
    {
      key: 'settlementRequests',
      title: t.notifications.settlementRequests,
      body: t.notifications.settlementRequestsBody,
    },
    { key: 'nudges', title: t.notifications.nudges, body: t.notifications.nudgesBody },
    {
      key: 'groupActivityDigest',
      title: t.notifications.digest,
      body: t.notifications.digestBody,
    },
    {
      key: 'weeklyEmail',
      title: t.notifications.weeklyEmail,
      body: t.notifications.weeklyEmailBody,
    },
  ];
}

/**
 * What went wrong, said to the person it happened to.
 *
 * Only `denied` is theirs to undo, and only that one sends them to their phone
 * settings. Telling somebody to check their settings when the real problem is
 * that this build has no Firebase key sends them somewhere that cannot help.
 */
function pushFailureCopy(t: UiStrings): Record<PushFailure, string> {
  return {
    [PushFailure.Denied]: t.notifications.failDenied,
    [PushFailure.Unsupported]: t.notifications.failUnsupported,
    [PushFailure.NotSignedIn]: t.notifications.failNotSignedIn,
    [PushFailure.NotConfigured]: t.notifications.failNotConfigured,
    [PushFailure.SaveFailed]: t.notifications.failSaveFailed,
  };
}

export default function NotificationSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { profile } = useAuth();

  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [permission, setPermission] = useState<PushPermission>(PushPermission.Undetermined);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let active = true;
    void pushPermission().then((value) => {
      if (active) setPermission(value);
    });
    return () => {
      active = false;
    };
  }, []);

  /**
   * The prompt happens here, having read what it is for — never on launch. On
   * iOS a denial is close to permanent: the only way back is Settings, which
   * nobody visits.
   */
  const turnOnPush = async (): Promise<void> => {
    setAsking(true);
    setStatus(null);
    try {
      const result = await enablePush();
      setPermission(await pushPermission());
      if (!result.ok) setStatus(pushFailureCopy(t)[result.why]);
    } finally {
      setAsking(false);
    }
  };

  useEffect(() => {
    if (!profile?.id) return;
    let active = true;
    void (async () => {
      try {
        const loaded = await fetchNotificationPrefs(profile.id);
        if (active) setPrefs(loaded);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [profile?.id]);

  const toggle = (key: keyof NotificationPrefs, value: boolean): void => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    if (!profile?.id) return;
    setStatus(null);
    void saveNotificationPrefs(profile.id, next)
      .then(() => setStatus(t.account.saved))
      .catch((caught: unknown) =>
        setStatus(caught instanceof Error ? caught.message : String(caught)),
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
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.notifications.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* ADR-010: the competition is simultaneously spammy and silent. These
            defaults are the fix, and they are all off-switchable. */}
        <Card style={{ backgroundColor: theme.color.brandSoft }}>
          <Text variant="caption" tone="brand">
            {t.notifications.neverSpam}
          </Text>
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">{t.notifications.onThisPhone}</Text>
            <Badge
              label={
                permission === 'granted'
                  ? t.notifications.granted
                  : permission === 'denied'
                    ? t.notifications.denied
                    : t.notifications.undetermined
              }
              tone={permission === 'granted' ? 'positive' : undefined}
            />
          </Row>
          <Text variant="caption" tone="muted">
            {permission === 'granted'
              ? t.notifications.permissionOn
              : permission === 'denied'
                ? t.notifications.permissionOff
                : t.notifications.permissionUnset}
          </Text>
          {permission === 'granted' ? null : (
            <Button
              label={asking ? t.notifications.asking : t.notifications.turnOn}
              size="sm"
              disabled={asking || permission === 'denied'}
              onPress={() => void turnOnPush()}
            />
          )}
        </Card>

        {loading ? (
          <ActivityIndicator color={theme.color.brand} />
        ) : (
          <View>
            <SectionHeader title={t.notifications.pushSection} />
            <Card style={{ gap: theme.spacing.xl }}>
              {rows(t).map((row) => (
                <Row key={row.key} style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
                    <Text variant="subheading">{row.title}</Text>
                    <Text variant="caption" tone="muted">
                      {row.body}
                    </Text>
                  </View>
                  <Toggle
                    value={prefs[row.key]}
                    onValueChange={(value) => toggle(row.key, value)}
                    accessibilityLabel={row.title}
                  />
                </Row>
              ))}
            </Card>
          </View>
        )}

        {status ? (
          <Text variant="caption" tone={status === t.account.saved ? 'positive' : 'negative'}>
            {status}
          </Text>
        ) : null}

        <Text variant="micro" tone="faint" align="center">
          {t.notifications.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
