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
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { type DeviceSession } from '@waves/core';
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
} from '@waves/ui';

import { plural, useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';
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
  // Counting before `deviceId()` resolves would count this phone as another
  // session, and offer to sign it out.
  const ready = !devices.isLoading && myDeviceId !== null;
  const otherLiveCount = ready
    ? rows.filter((row) => row.deviceId !== myDeviceId && !row.revokedAt).length
    : 0;

  async function onSignOutOthers() {
    setBusy(true);
    setMessage(null);
    try {
      const revoked = await signOutOthers();
      // null means the sessions were revoked but the count could not be
      // confirmed; show a plain acknowledgement instead of a false "0 devices".
      setMessage(
        revoked === null ? t.devices.signedOut : plural(locale, revoked, t.devices.signedOutOthers),
      );
      await queryClient.invalidateQueries({ queryKey: ['devices'] });
    } catch (caught) {
      setMessage(friendlyError(caught, t.devices.couldNotSignOut, 'devices.signOutOthers'));
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

        {!ready ? (
          // Until the list loads, `rows` is empty — showing "only this device"
          // here would tell people they have no other sessions before we know.
          <View style={{ padding: theme.spacing.xl }}>
            <ActivityIndicator color={theme.color.brand} />
          </View>
        ) : (
          <>
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
            ) : null}
          </>
        )}

        {ready && otherLiveCount > 0 ? (
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
        ) : null}

        {message ? (
          <Text variant="caption" tone="muted" align="center">
            {message}
          </Text>
        ) : null}

        <Text variant="micro" tone="muted" align="center">
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
