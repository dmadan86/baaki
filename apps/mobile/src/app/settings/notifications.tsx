import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, Switch, View } from 'react-native';

import { Card, IconButton, Row, Screen, SectionHeader, Text, useTheme } from '@baaki/ui';

import {
  DEFAULT_NOTIFICATION_PREFS,
  fetchNotificationPrefs,
  saveNotificationPrefs,
  type NotificationPrefs,
} from '@/data/api';
import { useAuth } from '@/lib/auth';

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

export default function NotificationSettingsScreen() {
  const theme = useTheme();
  const { profile } = useAuth();

  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

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
                  <Switch
                    value={prefs[row.key]}
                    onValueChange={(value) => toggle(row.key, value)}
                    trackColor={{ true: theme.color.brand, false: theme.color.border }}
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
          Delivery itself lands in M4 — these preferences are stored now so the fanout has something
          to respect from day one.
        </Text>
      </ScrollView>
    </Screen>
  );
}
