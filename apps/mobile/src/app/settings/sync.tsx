/**
 * Which networks sync may use.
 *
 * Three choices with Wi‑Fi first, the default — the same shape as the theme and
 * motion screens, because it is the same kind of decision: a preference the app
 * remembers about how it should behave in the background. The queue is always
 * safe on disk (ADR-005); this only decides when it is allowed to leave.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Card,
  directionalIcon,
  IconButton,
  iconSize,
  ListRow,
  Row,
  Screen,
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { SyncNetworkPreference, useSyncNetwork } from '@/lib/syncNetwork';

export default function SyncSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { preference, setPreference } = useSyncNetwork();

  const rows: {
    key: string;
    title: string;
    subtitle: string;
    icon: keyof typeof Ionicons.glyphMap;
    value: SyncNetworkPreference;
  }[] = [
    {
      key: 'wifi',
      title: t.sync.wifi,
      subtitle: t.sync.wifiHint,
      icon: 'wifi-outline',
      value: SyncNetworkPreference.Wifi,
    },
    {
      key: 'cellular',
      title: t.sync.cellular,
      subtitle: t.sync.cellularHint,
      icon: 'cellular-outline',
      value: SyncNetworkPreference.Cellular,
    },
    {
      key: 'both',
      title: t.sync.both,
      subtitle: t.sync.bothHint,
      icon: 'globe-outline',
      value: SyncNetworkPreference.Both,
    },
  ];

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
            <Text variant="heading">{t.sync.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          {rows.map((row, index) => {
            const chosen = preference === row.value;
            return (
              <View key={row.key}>
                <ListRow
                  title={row.title}
                  subtitle={row.subtitle}
                  onPress={() => void setPreference(row.value)}
                  accessibilityLabel={`${row.title}${chosen ? `, ${t.sync.selected}` : ''}`}
                  leading={<Ionicons name={row.icon} size={iconSize.xl} color={theme.color.text} />}
                  trailing={
                    chosen ? (
                      <Ionicons name="checkmark" size={iconSize.lg} color={theme.color.brand} />
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

        <Text variant="micro" tone="muted" align="center">
          {t.sync.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
