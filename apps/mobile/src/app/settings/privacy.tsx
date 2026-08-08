import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Card, directionalIcon, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';

/**
 * What is held, how it is kept, and what somebody can do about it.
 *
 * Written from what the app actually does rather than from a template: every
 * claim here is one this codebase can be checked against — row-level security
 * on every table (ADR-013), receipts in a private bucket behind signed links,
 * crash reports scrubbed before they leave the phone, export free and lossless
 * (ADR-012). A policy that promises something the code does not do is worse
 * than no policy, because it is the one people rely on.
 */
export default function PrivacyScreen() {
  const theme = useTheme();
  const { t } = useStrings();

  const sections = [
    { title: t.privacy.storeTitle, body: t.privacy.storeBody, icon: 'file-tray-outline' },
    { title: t.privacy.protectTitle, body: t.privacy.protectBody, icon: 'lock-closed-outline' },
    { title: t.privacy.analyticsTitle, body: t.privacy.analyticsBody, icon: 'stats-chart-outline' },
    { title: t.privacy.choicesTitle, body: t.privacy.choicesBody, icon: 'hand-left-outline' },
  ] as const;

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
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.privacy.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="body" tone="muted">
          {t.privacy.intro}
        </Text>

        {sections.map((section) => (
          <Card key={section.title} style={{ gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Ionicons name={section.icon} size={18} color={theme.color.brand} />
              <Text variant="subheading">{section.title}</Text>
            </Row>
            <Text variant="caption" tone="muted">
              {section.body}
            </Text>
          </Card>
        ))}

        <Text variant="micro" tone="faint">
          {t.privacy.englishGoverns}
        </Text>
      </ScrollView>
    </Screen>
  );
}
