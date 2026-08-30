import { useEffect, useState } from 'react';
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
  SectionHeader,
  Text,
  Toggle,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
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
  // This same screen is the app's privacy *policy*, reached from the legal line
  // on the signed-out welcome/sign-up gate as well as from Settings. The policy
  // text is for everyone; the account data-controls below (block list, export,
  // delete) act on an account that a signed-out reader does not have yet, so
  // they are shown only once there is a session (a guest counts — they have
  // data to manage).
  const { session } = useAuth();

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
      id: 'services',
      title: t.privacy.servicesTitle,
      body: t.privacy.servicesBody,
      icon: 'cloud-outline',
    },
    {
      id: 'analytics',
      title: t.privacy.analyticsTitle,
      body: t.privacy.analyticsBody,
      icon: 'stats-chart-outline',
    },
    {
      id: 'retention',
      title: t.privacy.retentionTitle,
      body: t.privacy.retentionBody,
      icon: 'hourglass-outline',
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
      {/* Back on the left, the title lifted out of the bar into the hero
          below — the policy leads with a symbol and a heading centred on the
          page, the way Apple's own privacy sheets open. */}
      <Row style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <IconButton label={t.common.back} onPress={() => router.back()}>
          <Ionicons
            name={directionalIcon('chevron-back')}
            size={iconSize.lg}
            color={theme.color.text}
          />
        </IconButton>
        <View style={{ flex: 1 }} />
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
        <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <Ionicons name="people" size={64} color={theme.color.text} />
          <Text
            align="center"
            style={{
              fontSize: 30,
              lineHeight: 38,
              fontWeight: '800',
              letterSpacing: -0.5,
              color: theme.color.text,
            }}
          >
            {t.privacy.title}
          </Text>
          <Text variant="body" tone="muted" align="center">
            {t.privacy.intro}
          </Text>
        </View>

        {/* The policy points as a bulleted list rather than a stack of cards:
            a dot in the margin, the point's heading, then the body — the plain
            "here is what we do" reading the reference uses. */}
        <View style={{ gap: theme.spacing.xl }}>
          {sections.map((section) => (
            <View key={section.id} style={{ flexDirection: 'row', gap: theme.spacing.md }}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 3.5,
                  backgroundColor: theme.color.brand,
                  marginTop: 8,
                }}
              />
              <View style={{ flex: 1, gap: theme.spacing.xs }}>
                <Text variant="subheading">{section.title}</Text>
                <Text variant="body" tone="muted">
                  {section.body}
                </Text>

                {/* The control the analytics text describes, sat under it so the
                    explanation and the switch are one thing. Hidden entirely on
                    a build with no Clarity project, where it would toggle
                    nothing. */}
                {section.id === 'analytics' && clarityConfigured ? (
                  <Row
                    style={{
                      gap: theme.spacing.md,
                      justifyContent: 'space-between',
                      marginTop: theme.spacing.xs,
                    }}
                  >
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
              </View>
            </View>
          ))}
        </View>

        {/* The controls the "choices" card promises, made tappable rather than
            described — export a copy, or close the account, both routes that
            already exist. Delete wears the negative tone: it ends something.
            Hidden when signed out: opened as the policy from the login gate,
            these would act on an account the reader does not have. */}
        {session ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title={t.privacy.dataControlsSection} />
            <Card style={{ paddingVertical: theme.spacing.xs }}>
              <ListRow
                title={t.blocked.row}
                subtitle={t.blocked.rowHint}
                onPress={() => router.push('/settings/blocked')}
                leading={
                  <Ionicons
                    name="person-remove-outline"
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                }
                trailing={
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.md}
                    color={theme.color.textFaint}
                  />
                }
              />
              <View style={{ height: 1, backgroundColor: theme.color.border }} />
              <ListRow
                title={t.privacy.exportRow}
                subtitle={t.privacy.exportRowHint}
                onPress={() => router.push('/settings/export')}
                leading={
                  <Ionicons name="download-outline" size={iconSize.md} color={theme.color.brand} />
                }
                trailing={
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.md}
                    color={theme.color.textFaint}
                  />
                }
              />
              <View style={{ height: 1, backgroundColor: theme.color.border }} />
              <ListRow
                title={t.privacy.deleteRow}
                subtitle={t.privacy.deleteRowHint}
                destructive
                onPress={() => router.push('/settings/delete-account')}
                leading={
                  <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
                }
                trailing={
                  <Ionicons
                    name={directionalIcon('chevron-forward')}
                    size={iconSize.md}
                    color={theme.color.textFaint}
                  />
                }
              />
            </Card>
          </View>
        ) : null}

        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.privacy.legalSection} />
          <Card style={{ paddingVertical: theme.spacing.xs }}>
            <ListRow
              title={t.privacy.licensesRow}
              subtitle={t.privacy.licensesRowHint}
              onPress={() => router.push('/settings/licenses')}
              leading={
                <Ionicons name="code-slash-outline" size={iconSize.md} color={theme.color.brand} />
              }
              trailing={
                <Ionicons
                  name={directionalIcon('chevron-forward')}
                  size={iconSize.md}
                  color={theme.color.textFaint}
                />
              }
            />
          </Card>
        </View>

        <Text variant="micro" tone="muted">
          {t.privacy.englishGoverns}
        </Text>
      </ScrollView>
    </Screen>
  );
}
