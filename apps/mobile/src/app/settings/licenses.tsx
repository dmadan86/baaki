import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
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

import { useStrings } from '@/i18n';

/**
 * The open-source software Baaki stands on.
 *
 * A flat, honest list rather than a generated dump: the libraries the app
 * actually ships and leans on, each with the license it is used under. Names
 * are proper nouns and stay in English across locales; only the surrounding
 * words translate. Every entry here is a real dependency in `package.json`, so
 * the screen can be checked against the manifest the same way the privacy copy
 * can be checked against the code.
 */
const LICENSES: readonly { name: string; license: string }[] = [
  { name: 'React', license: 'MIT' },
  { name: 'React Native', license: 'MIT' },
  { name: 'Expo', license: 'MIT' },
  { name: 'Expo Router', license: 'MIT' },
  { name: 'React Native Reanimated', license: 'MIT' },
  { name: 'React Native Gesture Handler', license: 'MIT' },
  { name: 'React Native Screens', license: 'MIT' },
  { name: 'React Native Safe Area Context', license: 'MIT' },
  { name: 'React Native SVG', license: 'MIT' },
  { name: 'Shopify FlashList', license: 'MIT' },
  { name: 'Supabase JS', license: 'MIT' },
  { name: 'TanStack Query', license: 'MIT' },
  { name: 'Async Storage', license: 'MIT' },
  { name: 'ML Kit Text Recognition', license: 'MIT' },
  { name: 'Sentry', license: 'MIT' },
  { name: 'Microsoft Clarity', license: 'MIT' },
];

export default function LicensesScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();

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
            <Text variant="heading">{t.privacy.licensesTitle}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="body" tone="muted">
          {t.privacy.licensesIntro}
        </Text>

        <Card style={{ paddingVertical: theme.spacing.xs }}>
          {LICENSES.map((lib, index) => (
            <Row
              key={lib.name}
              style={{
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingVertical: theme.spacing.md,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: theme.color.border,
                gap: theme.spacing.md,
              }}
            >
              <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
                {lib.name}
              </Text>
              <Text variant="caption" tone="muted">
                {lib.license}
              </Text>
            </Row>
          ))}
        </Card>

        <Text variant="micro" tone="muted">
          {t.privacy.licenseNote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
