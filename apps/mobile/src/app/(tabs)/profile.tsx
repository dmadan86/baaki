import Ionicons from '@expo/vector-icons/Ionicons';
import { ScrollView, View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  ListRow,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { GROUPS, ME, memberById } from '@/mocks/data';

const SETTINGS: { icon: keyof typeof Ionicons.glyphMap; label: string; hint?: string }[] = [
  { icon: 'wallet-outline', label: 'UPI ID', hint: 'Used to receive settlements' },
  { icon: 'notifications-outline', label: 'Notifications', hint: 'Only what involves me' },
  { icon: 'download-outline', label: 'Export data', hint: 'JSON + CSV, lossless' },
  { icon: 'cloud-upload-outline', label: 'Import from Splitwise' },
  { icon: 'lock-closed-outline', label: 'App lock', hint: 'Biometric / PIN' },
  { icon: 'language-outline', label: 'Language', hint: 'English · தமிழ் · हिंदी' },
];

export default function ProfileScreen() {
  const theme = useTheme();
  const { t, locale } = useStrings();
  const me = memberById(GROUPS[0]!, ME);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: 140,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="title" style={{ paddingTop: theme.spacing.md }}>
          {t.profile}
        </Text>

        <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          <Avatar name={me?.name ?? 'You'} emoji={me?.emoji} size={78} />
          <Text variant="heading">{me?.name ?? 'You'}</Text>
          <Text variant="caption" tone="muted">
            {me?.vpa ?? 'Add a UPI ID to get paid back'}
          </Text>
          <Row style={{ gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
            <Badge label={t.freeForever} tone="positive" />
            <Badge label={locale} tone="brand" />
          </Row>
        </Card>

        <View>
          <SectionHeader title="Settings" />
          <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
            {SETTINGS.map((item, index) => (
              <View key={item.label}>
                <ListRow
                  title={item.label}
                  subtitle={item.hint}
                  leading={
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: theme.radius.pill,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: theme.color.brandSoft,
                      }}
                    >
                      <Ionicons name={item.icon} size={18} color={theme.color.brand} />
                    </View>
                  }
                  trailing={
                    <Ionicons name="chevron-forward" size={18} color={theme.color.textFaint} />
                  }
                  onPress={() => {}}
                />
                {index < SETTINGS.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            ))}
          </Card>
        </View>

        <Text variant="micro" tone="faint" align="center">
          Baaki · the ledger is free forever. We only ever charge for convenience.
        </Text>
      </ScrollView>
    </Screen>
  );
}
