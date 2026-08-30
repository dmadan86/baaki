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
  Divider,
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

/**
 * A phone or a computer, read off the free-text platform string. Only ever
 * decides which glyph sits in front of a row — a browser session is a laptop,
 * everything else is the phone this app usually is.
 */
function deviceGlyph(platform: string) {
  const p = platform.toLowerCase();
  const isDesktop = /web|mac|windows|linux|desktop|chrome|firefox|safari|browser|edge/.test(p);
  return isDesktop ? 'desktop-outline' : 'phone-portrait-outline';
}

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

  // Presentation only: this phone reads first, then the other live sessions in
  // the server's newest-first order, then anything already signed out settles
  // to the bottom where it can be scanned past. Nothing about the data changes.
  const ordered = ready
    ? [...rows].sort((a, b) => rankOf(a, myDeviceId) - rankOf(b, myDeviceId))
    : [];

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
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
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

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          paddingTop: theme.spacing.lg,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
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
            {/* One grouped list rather than a stack of separate cards: the
                sessions read as a single set you scan down, this phone marked
                at the top, hairlines between each. */}
            <Card style={{ paddingVertical: theme.spacing.xs }}>
              {ordered.map((row, index) => (
                <View key={`${row.deviceId}-${row.lastSeenAt}`}>
                  {index > 0 ? <Divider /> : null}
                  <DeviceRow
                    row={row}
                    current={row.deviceId === myDeviceId}
                    locale={locale}
                    t={t}
                  />
                </View>
              ))}
            </Card>

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

/** Sort key: this phone first (0), other live sessions next (1), signed-out last (2). */
function rankOf(row: DeviceSession, myDeviceId: string | null): number {
  if (row.deviceId === myDeviceId) return 0;
  if (row.revokedAt) return 2;
  return 1;
}

function DeviceRow({
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
    <Row
      style={{
        paddingVertical: theme.spacing.md,
        gap: theme.spacing.md,
        opacity: row.revokedAt ? 0.55 : 1,
      }}
    >
      {/* The current session gets a brand-tinted mark; the rest sit in a quiet
          neutral square so the eye lands on this phone first. */}
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: theme.radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: current ? theme.color.brandSoft : theme.color.surfaceMuted,
        }}
      >
        <Ionicons
          name={deviceGlyph(row.platform)}
          size={iconSize.xl}
          color={current ? theme.color.brand : theme.color.textMuted}
        />
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="subheading" numberOfLines={1}>
          {row.label}
        </Text>
        <Text variant="caption" tone="muted" numberOfLines={1}>
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
  );
}
