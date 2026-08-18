/**
 * Receipt backup settings — where scanned receipts go, and over which network.
 *
 * The privacy promise this screen makes is the whole point of the feature: the
 * photo of your bill lives on your phone and, if you connect one, on a cloud
 * drive that is *yours*. It never goes to Baaki. So the screen leads with that
 * sentence, then offers the single choice that makes it true — pick one provider
 * as the place receipts are copied to — plus the one guard people actually ask
 * for, which is "not on my mobile data".
 *
 * One provider is primary at a time. Connecting a provider makes it primary if
 * nothing else was; after that the radio chooses between the ones you have
 * connected. A provider with no client id in this build says so and cannot be
 * connected, rather than opening a broken consent page.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import {
  Badge,
  Button,
  Callout,
  Card,
  directionalIcon,
  Divider,
  IconButton,
  iconSize,
  Row,
  Screen,
  SectionHeader,
  SegmentedTabs,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { canUploadGroupPhoto } from '@/data/api';
import { plural, useStrings } from '@/i18n';
import { friendlyError } from '@/lib/errors';
import { useBackup } from '@/lib/cloud/BackupProvider';
import { allProviders } from '@/lib/cloud/providers';
import type { BackupNetworkPolicy, CloudProviderId } from '@/lib/cloud/types';

export default function BackupSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const backup = useBackup();
  const [busy, setBusy] = useState<CloudProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Whether this account is on Plus — the one thing that decides if the Waves
  // destination can be switched on. Undefined while it loads: the row shows
  // Connect (safe) rather than an Upgrade prompt it hasn't earned the right to.
  const [paid, setPaid] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void canUploadGroupPhoto(null)
      .then((value) => {
        if (active) setPaid(value);
      })
      // A failed check is not "not paid": leave it unknown so the gate neither
      // grants Waves nor nags to upgrade on a network blip.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const providers = allProviders();

  const onRetry = async (): Promise<void> => {
    setRetrying(true);
    try {
      await backup.retryFailed();
    } finally {
      setRetrying(false);
    }
  };

  // The one actionable sentence under the trouble card, chosen from why the last
  // pass stalled — an expired sign-in and a Wi‑Fi-only policy want different
  // fixes. Falls back to the generic line when the reason is not one we can name.
  const troubleReason =
    backup.lastSkip === 'offline'
      ? t.backup.troubleOffline
      : backup.lastSkip === 'policy'
        ? t.backup.troublePolicy
        : backup.lastSkip === 'auth' || backup.lastSkip === 'not-connected'
          ? t.backup.troubleReconnect
          : t.backup.troubleGeneric;

  const onConnect = async (id: CloudProviderId): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await backup.connect(id);
    } catch (caught) {
      setError(friendlyError(caught, t.backup.connectFailed, 'backup.connect'));
    } finally {
      setBusy(null);
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
            <Text variant="heading">{t.backup.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="caption" tone="muted">
          {t.backup.primaryBody}
        </Text>

        <View>
          <SectionHeader title={t.backup.primaryTitle} />
          <Card style={{ gap: theme.spacing.md }}>
            {/* "Off" — receipts stay on the device only. */}
            <SelectRow
              label={t.backup.off}
              selected={backup.primary === null}
              onPress={() => void backup.setPrimary(null)}
            />

            {providers.map((provider) => {
              const configured = provider.isConfigured();
              const connected = backup.connected[provider.id];
              const isPrimary = backup.primary === provider.id;
              // Waves is our own storage, gated on Plus rather than a client id.
              // A free account sees why (a Plus badge) and the way to it (Upgrade)
              // instead of a Connect that every upload would bounce off the policy.
              const isWaves = provider.id === 'waves';
              const lockedForFree = isWaves && paid === false;
              return (
                <View key={provider.id} style={{ gap: theme.spacing.md }}>
                  <Divider />
                  <Row
                    style={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                    }}
                  >
                    <SelectRow
                      label={provider.label}
                      // Only a connected provider can be the destination.
                      selected={isPrimary}
                      disabled={!connected}
                      status={
                        connected
                          ? t.backup.connected
                          : isWaves
                            ? t.backup.wavesHint
                            : undefined
                      }
                      onPress={() => (connected ? void backup.setPrimary(provider.id) : undefined)}
                    />
                    {lockedForFree ? (
                      <Row style={{ alignItems: 'center', gap: theme.spacing.sm }}>
                        <Badge label={t.backup.plus} tone="brand" />
                        <Button
                          label={t.backup.upgrade}
                          variant="secondary"
                          size="sm"
                          onPress={() => router.push('/settings/upgrade')}
                        />
                      </Row>
                    ) : !configured ? (
                      <Badge label={t.backup.notConfigured} tone="neutral" />
                    ) : connected ? (
                      <Button
                        label={t.backup.disconnect}
                        variant="ghost"
                        size="sm"
                        onPress={() => void backup.disconnect(provider.id)}
                      />
                    ) : (
                      <Button
                        label={t.backup.connect}
                        variant="secondary"
                        size="sm"
                        disabled={busy === provider.id}
                        onPress={() => void onConnect(provider.id)}
                      />
                    )}
                  </Row>
                </View>
              );
            })}
          </Card>
          {error ? <Callout tone="negative">{error}</Callout> : null}
        </View>

        {/* Only worth choosing a network policy once something will actually be
            uploaded. */}
        {backup.primary ? (
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader title={t.backup.networkTitle} />
            <SegmentedTabs<BackupNetworkPolicy>
              value={backup.policy}
              onChange={(value) => void backup.setPolicy(value)}
              tabs={[
                { value: 'wifi', label: t.backup.wifiOnly },
                { value: 'any', label: t.backup.wifiAndData },
              ]}
            />
            <Text variant="caption" tone="muted">
              {backup.pending > 0
                ? plural(locale, backup.pending, t.backup.pending)
                : t.backup.allBackedUp}
            </Text>
          </View>
        ) : null}

        {/* When receipts failed to upload, say so plainly, name the likely cause
            and its fix, and offer one button to try again — the photos are safe
            in the device vault throughout, so this is a nudge, never a loss. */}
        {backup.errored > 0 ? (
          <Card style={{ gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
              <Ionicons name="alert-circle-outline" size={iconSize.md} color={theme.color.warning} />
              <Text variant="subheading">{t.backup.troubleTitle}</Text>
            </Row>
            <Text variant="caption" tone="muted">
              {troubleReason}
            </Text>
            {/* The drive's own last words, kept faint — useful when the cause is
                not one of the named ones, harmless when it is. */}
            {backup.lastError ? (
              <Text variant="micro" tone="faint">
                {backup.lastError}
              </Text>
            ) : null}
            <Text variant="micro" tone="muted">
              {t.backup.troubleSafe}
            </Text>
            <Button
              label={t.backup.retry}
              variant="secondary"
              size="sm"
              disabled={retrying}
              onPress={() => void onRetry()}
            />
          </Card>
        ) : null}

        <Text variant="micro" tone="muted" align="center">
          {t.backup.privacyNote}
        </Text>
      </ScrollView>
    </Screen>
  );
}

/** A radio-style selectable line: a mark, a label, and an optional status word. */
function SelectRow({
  label,
  selected,
  disabled = false,
  status,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  status?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
      onPress={disabled ? undefined : onPress}
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={iconSize.xl}
        color={selected ? theme.color.brand : theme.color.textFaint}
      />
      <View style={{ flex: 1 }}>
        <Text variant="subheading">{label}</Text>
        {status ? (
          <Text variant="caption" tone="muted">
            {status}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
