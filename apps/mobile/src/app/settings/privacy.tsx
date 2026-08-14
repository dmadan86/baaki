import { useEffect, useState } from 'react';
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
  Toggle,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { clarityConfigured } from '@/lib/clarity';
import { sessionReplayConsent, setSessionReplayConsent } from '@/lib/sessionReplay';

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
  const clearance = useTabBarClearance();
  const { t } = useStrings();

  // The session-replay opt-in, mirrored from storage. Only meaningful when a
  // Clarity project is configured; on a build without one the switch is hidden
  // rather than shown doing nothing.
  const [replay, setReplay] = useState(false);
  useEffect(() => {
    void sessionReplayConsent().then(setReplay);
  }, []);

  const onReplayChange = (value: boolean): void => {
    setReplay(value);
    void setSessionReplayConsent(value);
  };

  const sections = [
    {
      id: 'store',
      title: t.privacy.storeTitle,
      body: t.privacy.storeBody,
      icon: 'file-tray-outline',
    },
    {
      id: 'protect',
      title: t.privacy.protectTitle,
      body: t.privacy.protectBody,
      icon: 'lock-closed-outline',
    },
    {
      id: 'analytics',
      title: t.privacy.analyticsTitle,
      body: t.privacy.analyticsBody,
      icon: 'stats-chart-outline',
    },
    {
      id: 'choices',
      title: t.privacy.choicesTitle,
      body: t.privacy.choicesBody,
      icon: 'hand-left-outline',
    },
  ] as const;

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
            <Text variant="heading">{t.privacy.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="body" tone="muted">
          {t.privacy.intro}
        </Text>

        {sections.map((section) => (
          <Card key={section.id} style={{ gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Ionicons name={section.icon} size={iconSize.md} color={theme.color.brand} />
              <Text variant="subheading">{section.title}</Text>
            </Row>
            <Text variant="caption" tone="muted">
              {section.body}
            </Text>

            {/* The control the analytics text describes, sat under it so the
                explanation and the switch are one thing. Hidden entirely on a
                build with no Clarity project, where it would toggle nothing. */}
            {section.id === 'analytics' && clarityConfigured ? (
              <Row style={{ gap: theme.spacing.md, justifyContent: 'space-between' }}>
                <Text variant="body" style={{ flex: 1 }}>
                  {t.privacy.sessionReplayRow}
                </Text>
                <Toggle
                  value={replay}
                  onValueChange={onReplayChange}
                  accessibilityLabel={t.privacy.sessionReplayRow}
                />
              </Row>
            ) : null}
          </Card>
        ))}

        <Text variant="micro" tone="faint">
          {t.privacy.englishGoverns}
        </Text>
      </ScrollView>
    </Screen>
  );
}
