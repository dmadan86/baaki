import { useEffect, useState, type ComponentProps } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  directionalIcon,
  Divider,
  IconButton,
  iconSize,
  Row,
  Screen,
  SectionHeader,
  Text,
  Toggle,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import {
  DEFAULT_NOTIFICATION_PREFS,
  fetchNotificationPrefs,
  saveNotificationPrefs,
  type NotificationPrefs,
} from '@/data/api';
import { useStrings, type UiStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';
import { useAuth } from '@/lib/auth';
import { enablePush, PushFailure, PushPermission, pushPermission } from '@/lib/push';

type IconName = ComponentProps<typeof Ionicons>['name'];
type PrefRow = { key: keyof NotificationPrefs; title: string; body: string; icon: IconName };

/** The push notifications — everything the phone delivers. */
function pushRows(t: UiStrings): PrefRow[] {
  return [
    {
      key: 'involvesMe',
      title: t.notifications.involvesMe,
      body: t.notifications.involvesMeBody,
      icon: 'people-outline',
    },
    {
      key: 'settlementRequests',
      title: t.notifications.settlementRequests,
      body: t.notifications.settlementRequestsBody,
      icon: 'swap-horizontal-outline',
    },
    {
      key: 'nudges',
      title: t.notifications.nudges,
      body: t.notifications.nudgesBody,
      icon: 'hand-left-outline',
    },
    {
      key: 'groupActivityDigest',
      title: t.notifications.digest,
      body: t.notifications.digestBody,
      icon: 'newspaper-outline',
    },
  ];
}

/** The weekly digest arrives by email, not push, so it sits in its own section. */
function emailRows(t: UiStrings): PrefRow[] {
  return [
    {
      key: 'weeklyEmail',
      title: t.notifications.weeklyEmail,
      body: t.notifications.weeklyEmailBody,
      icon: 'mail-outline',
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
    const previous = prefs;
    const next = { ...prefs, [key]: value };
    if (!profile?.id) {
      setStatus(t.notifications.failNotSignedIn);
      return;
    }
    setPrefs(next);
    setStatus(null);
    void saveNotificationPrefs(profile.id, next)
      .then(() => setStatus(t.account.saved))
      .catch((caught: unknown) => {
        // The switch goes back to what the server still holds, so the screen
        // never shows a preference that was not saved.
        setPrefs(previous);
        setStatus(friendlyError(caught, t.notifications.failSaveFailed, 'notifications.savePrefs'));
      });
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
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.notifications.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* ADR-010: the competition is simultaneously spammy and silent. These
            defaults are the fix, and they are all off-switchable. */}
        <Card
          flat
          style={{ backgroundColor: theme.color.brandSoft, paddingVertical: theme.spacing.lg }}
        >
          <Row gap={theme.spacing.md}>
            <Ionicons
              name="shield-checkmark-outline"
              size={iconSize.xl}
              color={theme.color.brand}
            />
            <Text variant="caption" tone="brand" style={{ flex: 1 }}>
              {t.notifications.neverSpam}
            </Text>
          </Row>
        </Card>

        {/* The master switch: nothing below fires until the phone itself is
            allowed to deliver, so this device-permission state leads. */}
        <Card style={{ gap: theme.spacing.md }}>
          <Row gap={theme.spacing.md}>
            <IconChip icon="phone-portrait-outline" />
            <View style={{ flex: 1 }}>
              <Text variant="subheading">{t.notifications.onThisPhone}</Text>
              <Text variant="caption" tone="muted">
                {permission === 'granted'
                  ? t.notifications.permissionOn
                  : permission === 'denied'
                    ? t.notifications.permissionOff
                    : t.notifications.permissionUnset}
              </Text>
            </View>
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
          <>
            <View>
              <SectionHeader title={t.notifications.pushSection} />
              <PrefSection rows={pushRows(t)} prefs={prefs} onToggle={toggle} />
            </View>
            <View>
              <SectionHeader title={t.notifications.emailSection} />
              <PrefSection rows={emailRows(t)} prefs={prefs} onToggle={toggle} />
            </View>
          </>
        )}

        {status ? (
          <Text variant="caption" tone={status === t.account.saved ? 'positive' : 'negative'}>
            {status}
          </Text>
        ) : null}

        <Text variant="micro" tone="muted" align="center">
          {t.notifications.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}

/**
 * A soft round badge that carries a row's glyph. Purely decorative — the
 * screen reader ignores it and reads the row title instead — but it gives each
 * preference a fixed anchor on the left, the way the reference notification
 * lists lean on a leading icon column.
 */
function IconChip({ icon }: { icon: IconName }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 40,
        height: 40,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.color.brandSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Ionicons name={icon} size={iconSize.lg} color={theme.color.brand} />
    </View>
  );
}

/** One card of preference toggles, shared by the push and email sections. */
function PrefSection({
  rows,
  prefs,
  onToggle,
}: {
  rows: PrefRow[];
  prefs: NotificationPrefs;
  onToggle: (key: keyof NotificationPrefs, value: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <Card padded={false} style={{ paddingHorizontal: theme.spacing.xl }}>
      {rows.map((row, index) => (
        <View key={row.key}>
          {index > 0 ? <Divider /> : null}
          <Row gap={theme.spacing.md} style={{ paddingVertical: theme.spacing.lg }}>
            <IconChip icon={row.icon} />
            <View style={{ flex: 1 }}>
              <Text variant="subheading">{row.title}</Text>
              <Text variant="caption" tone="muted">
                {row.body}
              </Text>
            </View>
            <Toggle
              value={prefs[row.key]}
              onValueChange={(value) => onToggle(row.key, value)}
              accessibilityLabel={row.title}
            />
          </Row>
        </View>
      ))}
    </Card>
  );
}
