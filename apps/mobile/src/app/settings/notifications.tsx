import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  IconButton,
  Row,
  Screen,
  SectionHeader,
  Text,
  Toggle,
  useTheme,
} from '@baaki/ui';

import {
  DEFAULT_NOTIFICATION_PREFS,
  fetchNotificationPrefs,
  saveNotificationPrefs,
  type NotificationPrefs,
} from '@/data/api';
import { useAuth } from '@/lib/auth';
import { enablePush, pushPermission, type PushFailure, type PushPermission } from '@/lib/push';

const ROWS: {
  key: keyof NotificationPrefs;
  title: string;
  body: string;
}[] = [
  {
    key: 'involvesMe',
    title: 'Only what involves me',
    body: 'Push when you owe, are owed, or are mentioned — not for every expense in every group.',
  },
  {
    key: 'settlementRequests',
    title: 'Settlement confirmations',
    body: 'When someone says they paid you, so your baaki stays right.',
  },
  {
    key: 'nudges',
    title: 'Reminders',
    body: 'A friendly nudge about money owed. Limited to one per person per day, in the database.',
  },
  {
    key: 'groupActivityDigest',
    title: 'Daily group summary',
    body: 'Everything else, batched into one notification a day instead of a stream.',
  },
  {
    key: 'weeklyEmail',
    title: 'Weekly email digest',
    body: 'Your net baaki and pending confirmations, once a week. Off by default.',
  },
];

/**
 * What went wrong, said to the person it happened to.
 *
 * Only `denied` is theirs to undo, and only that one sends them to their phone
 * settings. Telling somebody to check their settings when the real problem is
 * that this build has no Firebase key sends them somewhere that cannot help.
 */
const PUSH_FAILURE_COPY: Record<PushFailure, string> = {
  denied: 'Not enabled — you can turn it on in your phone settings later.',
  unsupported: 'This device cannot receive push notifications. Everything still lands in Activity.',
  not_signed_in: 'Sign in first, so we know which phone is yours.',
  not_configured:
    'Push is not set up in this build of Baaki. Nothing you did — everything still lands in Activity.',
  save_failed: 'Could not save this phone. Check your connection and try again.',
};

export default function NotificationSettingsScreen() {
  const theme = useTheme();
  const { profile } = useAuth();

  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [permission, setPermission] = useState<PushPermission>('undetermined');
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
      if (!result.ok) setStatus(PUSH_FAILURE_COPY[result.why]);
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
      .then(() => setStatus('Saved'))
      .catch((caught: unknown) =>
        setStatus(caught instanceof Error ? caught.message : String(caught)),
      );
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">Notifications</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* ADR-010: the competition is simultaneously spammy and silent. These
            defaults are the fix, and they are all off-switchable. */}
        <Card style={{ backgroundColor: theme.color.brandSoft }}>
          <Text variant="caption" tone="brand">
            Baaki never emails you about routine expense activity. Only the six things you would
            actually want in your inbox, each unsubscribable on its own.
          </Text>
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text variant="subheading">Notifications on this phone</Text>
            <Badge
              label={permission === 'granted' ? 'On' : permission === 'denied' ? 'Off' : 'Not set'}
              tone={permission === 'granted' ? 'positive' : undefined}
            />
          </Row>
          <Text variant="caption" tone="muted">
            {permission === 'granted'
              ? 'This device is registered. Everything below still lands in your inbox whether or not a push gets through.'
              : permission === 'denied'
                ? 'Your phone is blocking them. Turn them back on in system settings for Baaki — the inbox still has everything either way.'
                : 'Baaki will only ask once, and only for the things you switch on below.'}
          </Text>
          {permission === 'granted' ? null : (
            <Button
              label={asking ? 'Asking…' : 'Turn on notifications'}
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
            <SectionHeader title="Push" />
            <Card style={{ gap: theme.spacing.xl }}>
              {ROWS.map((row) => (
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
          <Text variant="caption" tone={status === 'Saved' ? 'positive' : 'negative'}>
            {status}
          </Text>
        ) : null}

        <Text variant="micro" tone="faint" align="center">
          Email delivery is still to come. Everything here is also in your inbox, which is the
          record of what Baaki has told you whether or not a notification arrived.
        </Text>
      </ScrollView>
    </Screen>
  );
}
