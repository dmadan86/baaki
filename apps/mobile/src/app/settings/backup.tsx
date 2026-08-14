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

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Divider,
  directionalIcon,
  IconButton,
  Row,
  Screen,
  SectionHeader,
  SegmentedTabs,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { plural, useStrings } from '@/i18n';
import { useBackup } from '@/lib/cloud/BackupProvider';
import { allProviders } from '@/lib/cloud/providers';
import type { BackupNetworkPolicy, CloudProviderId } from '@/lib/cloud/types';

export default function BackupSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const backup = useBackup();
  const [busy, setBusy] = useState<CloudProviderId | null>(null);

  const providers = allProviders();

  const onConnect = async (id: CloudProviderId): Promise<void> => {
    setBusy(id);
    try {
      await backup.connect(id);
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
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
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
                        !configured
                          ? t.backup.notConfigured
                          : connected
                            ? t.backup.connected
                            : undefined
                      }
                      onPress={() => (connected ? void backup.setPrimary(provider.id) : undefined)}
                    />
                    {!configured ? (
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

        <Text variant="micro" tone="faint" align="center">
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
        size={22}
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
