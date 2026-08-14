/**
 * Where this account is signed in, and the one button that trims it.
 *
 * The free tier is two devices at a time (see `deviceSession.tsx`); this is the
 * screen that makes that legible — the phones seen in the last three months,
 * this one marked, and "log out all other devices" for when the list has
 * somebody on it you do not recognise. Signing the others out here is the same
 * action the over-limit gate offers, reached calmly rather than because you are
 * blocked.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { type DeviceSession } from '@baaki/core';
import {
  Badge,
  Button,
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { plural, useStrings } from '@/i18n';
import { fetchDevices } from '@/data/api';
import { deviceId } from '@/lib/device';
import { useDeviceSession } from '@/lib/deviceSession';

export default function DevicesScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const { signOutOthers } = useDeviceSession();

  const [myDeviceId, setMyDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void deviceId().then(setMyDeviceId);
  }, []);

  // The server already returns the last three months, newest first.
  const devices = useQuery({ queryKey: ['devices'], queryFn: fetchDevices });
  const rows = devices.data ?? [];
  const otherLiveCount = rows.filter((row) => row.deviceId !== myDeviceId && !row.revokedAt).length;

  async function onSignOutOthers() {
    setBusy(true);
    setMessage(null);
    try {
      const revoked = await signOutOthers();
      setMessage(plural(locale, revoked, t.devices.signedOutOthers));
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    } finally {
      setBusy(false);
    }
  }

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
            <Text variant="heading">{t.devices.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="caption" tone="muted">
          {t.devices.intro}
        </Text>

        <View style={{ gap: theme.spacing.md }}>
          {rows.map((row) => (
            <DeviceCard
              key={`${row.deviceId}-${row.lastSeenAt}`}
              row={row}
              current={row.deviceId === myDeviceId}
              locale={locale}
              t={t}
            />
          ))}
        </View>

        {otherLiveCount === 0 ? (
          <Text variant="caption" tone="muted" align="center">
            {t.devices.onlyThisDevice}
          </Text>
        ) : (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="caption" tone="muted">
              {t.devices.signOutOthersHint}
            </Text>
            <Button
              label={t.devices.signOutOthers}
              variant="danger"
              disabled={busy}
              onPress={() => void onSignOutOthers()}
            />
          </Card>
        )}

        {message ? (
          <Text variant="caption" tone="muted" align="center">
            {message}
          </Text>
        ) : null}

        <Text variant="micro" tone="faint" align="center">
          {t.devices.historyNote}
        </Text>
      </ScrollView>
    </Screen>
  );
}

function DeviceCard({
  row,
  current,
  locale,
  t,
}: {
  row: DeviceSession;
  current: boolean;
  locale: string;
  t: ReturnType<typeof useStrings>['t'];
}) {
  const theme = useTheme();
  const when = new Date(row.lastSeenAt).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <Card style={{ gap: 4, opacity: row.revokedAt ? 0.6 : 1 }}>
      <Row style={{ justifyContent: 'space-between', gap: theme.spacing.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="subheading" numberOfLines={1}>
            {row.label}
          </Text>
          <Text variant="caption" tone="muted">
            {row.platform}
          </Text>
          <Text variant="caption" tone="muted">
            {t.devices.lastActive.replace('{when}', when)}
          </Text>
        </View>
        {current ? (
          <Badge label={t.devices.thisDevice} tone="brand" />
        ) : row.revokedAt ? (
          <Badge label={t.devices.signedOut} tone="neutral" />
        ) : null}
      </Row>
    </Card>
  );
}
