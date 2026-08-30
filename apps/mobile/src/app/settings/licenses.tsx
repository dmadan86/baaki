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
 * A flat, honest list rather than a generated dump: every direct runtime
 * dependency in `apps/mobile/package.json` (the workspace `@waves/*` packages
 * excepted, since they are the app itself). Each license identifier is the SPDX
 * string from that package's own `package.json` `license` field, read from the
 * installed tree — so the screen can be checked against the manifest the same
 * way the privacy copy can be checked against the code. Names are proper nouns
 * and stay in English across locales; only the surrounding words translate.
 *
 * As of this writing every direct dependency publishes under MIT; the column
 * still carries each identifier so a future dependency under a different
 * license (Apache-2.0, BSD, …) lands with the truth already in place. Full
 * per-package license text is not bundled — the app cannot read node_modules at
 * runtime — so this is an attribution notice, not a copy of every LICENSE file.
 */
const LICENSES: readonly { name: string; license: string }[] = [
  { name: 'React', license: 'MIT' },
  { name: 'React DOM', license: 'MIT' },
  { name: 'React Native', license: 'MIT' },
  { name: 'React Native Web', license: 'MIT' },
  { name: 'Expo', license: 'MIT' },
  { name: 'Expo Router', license: 'MIT' },
  { name: 'Expo UI', license: 'MIT' },
  { name: 'Expo Vector Icons', license: 'MIT' },
  { name: 'Expo Auth Session', license: 'MIT' },
  { name: 'Expo Clipboard', license: 'MIT' },
  { name: 'Expo Constants', license: 'MIT' },
  { name: 'Expo Contacts', license: 'MIT' },
  { name: 'Expo Crypto', license: 'MIT' },
  { name: 'Expo Dev Client', license: 'MIT' },
  { name: 'Expo Device', license: 'MIT' },
  { name: 'Expo Document Picker', license: 'MIT' },
  { name: 'Expo File System', license: 'MIT' },
  { name: 'Expo Font', license: 'MIT' },
  { name: 'Expo Glass Effect', license: 'MIT' },
  { name: 'Expo Image', license: 'MIT' },
  { name: 'Expo Image Manipulator', license: 'MIT' },
  { name: 'Expo Image Picker', license: 'MIT' },
  { name: 'Expo Linear Gradient', license: 'MIT' },
  { name: 'Expo Linking', license: 'MIT' },
  { name: 'Expo Local Authentication', license: 'MIT' },
  { name: 'Expo Localization', license: 'MIT' },
  { name: 'Expo Network', license: 'MIT' },
  { name: 'Expo Notifications', license: 'MIT' },
  { name: 'Expo Secure Store', license: 'MIT' },
  { name: 'Expo Sharing', license: 'MIT' },
  { name: 'Expo Speech Recognition', license: 'MIT' },
  { name: 'Expo Splash Screen', license: 'MIT' },
  { name: 'Expo SQLite', license: 'MIT' },
  { name: 'Expo Status Bar', license: 'MIT' },
  { name: 'Expo Symbols', license: 'MIT' },
  { name: 'Expo System UI', license: 'MIT' },
  { name: 'Expo Updates', license: 'MIT' },
  { name: 'Expo Web Browser', license: 'MIT' },
  { name: 'React Native Reanimated', license: 'MIT' },
  { name: 'React Native Worklets', license: 'MIT' },
  { name: 'React Native Gesture Handler', license: 'MIT' },
  { name: 'React Native Screens', license: 'MIT' },
  { name: 'React Native Safe Area Context', license: 'MIT' },
  { name: 'React Native SVG', license: 'MIT' },
  { name: 'React Native URL Polyfill', license: 'MIT' },
  { name: 'React Native Document Scanner', license: 'MIT' },
  { name: 'React Native Get SMS Android', license: 'MIT' },
  { name: 'React Native DateTimePicker', license: 'MIT' },
  { name: 'Shopify FlashList', license: 'MIT' },
  { name: 'Supabase JS', license: 'MIT' },
  { name: 'TanStack Query', license: 'MIT' },
  { name: 'Async Storage', license: 'MIT' },
  { name: 'ML Kit Text Recognition', license: 'MIT' },
  { name: 'Sentry', license: 'MIT' },
  { name: 'Microsoft Clarity', license: 'MIT' },
  { name: 'base64-arraybuffer', license: 'MIT' },
];

export default function LicensesScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();

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
          <Text variant="heading">{t.privacy.licensesTitle}</Text>
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
