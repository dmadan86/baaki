import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { LayoutAnimation, Pressable, ScrollView, View } from 'react-native';

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

import { useBlockedUsers } from '@/data/blocked';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { clarityConfigured } from '@/lib/clarity';
import { useLock } from '@/lib/lock';
import { useReducedMotion } from '@/lib/reducedMotion';
import { sessionReplayConsent, setSessionReplayConsent } from '@/lib/sessionReplay';

/**
 * What is held, how it is kept, and what somebody can do about it.
 *
 * Written from what the app actually does rather than from a template: every
 * claim here is one this codebase can be checked against — row-level security
 * on every table (ADR-013), receipts in a private bucket behind signed links,
 * the offline mirror sealed at rest (`sync/rowCipher`), crash reports scrubbed
 * before they leave the phone, export free and lossless (ADR-012). A policy
 * that promises something the code does not do is worse than no policy, because
 * it is the one people rely on.
 *
 * The screen has two readers and serves them in two different orders. Somebody
 * arriving from Settings came to *do* something — lock the app, see who they
 * blocked, stop the recording, take their data out — so for them the switches
 * come first and the prose is folded down to a line each, opened on a tap.
 * Somebody arriving from the legal line on the signed-out gate came to *read*
 * the policy, so for them the same text is the page, open from the start, with
 * no account controls that would act on an account they do not have.
 */

/** When the policy text below last changed. Shown, because an undated policy is not one. */
const POLICY_UPDATED = '2026-08-31';

export default function PrivacyScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const reduceMotion = useReducedMotion();
  // The account data-controls act on an account a signed-out reader does not
  // have yet, so they are shown only once there is a session (a guest counts —
  // they have data to manage).
  const { session } = useAuth();
  const { enabled: lockEnabled, supported: lockSupported } = useLock();
  const { blocked } = useBlockedUsers();

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

  // Which policy points are open. Signed out this screen *is* the policy, so
  // every point starts open and the summaries are just headings above the text;
  // signed in they start folded, one line each, out of the way of the controls.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (id: string): boolean => open[id] ?? !session;
  const toggleSection = (id: string): void => {
    if (!reduceMotion) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? !session) }));
  };

  const sections = [
    {
      id: 'store',
      title: t.privacy.storeTitle,
      summary: t.privacy.storeSummary,
      body: t.privacy.storeBody,
      icon: 'file-tray-outline',
    },
    {
      id: 'protect',
      title: t.privacy.protectTitle,
      summary: t.privacy.protectSummary,
      body: t.privacy.protectBody,
      icon: 'lock-closed-outline',
    },
    {
      id: 'device',
      title: t.privacy.deviceTitle,
      summary: t.privacy.deviceSummary,
      body: t.privacy.deviceBody,
      icon: 'phone-portrait-outline',
    },
    {
      id: 'services',
      title: t.privacy.servicesTitle,
      summary: t.privacy.servicesSummary,
      body: t.privacy.servicesBody,
      icon: 'cloud-outline',
    },
    {
      id: 'analytics',
      title: t.privacy.analyticsTitle,
      summary: t.privacy.analyticsSummary,
      body: t.privacy.analyticsBody,
      icon: 'stats-chart-outline',
    },
    {
      id: 'retention',
      title: t.privacy.retentionTitle,
      summary: t.privacy.retentionSummary,
      body: t.privacy.retentionBody,
      icon: 'hourglass-outline',
    },
    {
      id: 'choices',
      title: t.privacy.choicesTitle,
      summary: t.privacy.choicesSummary,
      body: t.privacy.choicesBody,
      icon: 'hand-left-outline',
    },
  ] as const;

  const chevron = (
    <Ionicons
      name={directionalIcon('chevron-forward')}
      size={iconSize.md}
      color={theme.color.textFaint}
    />
  );

  /** A right-hand status word — the state at a glance, without a sentence. */
  const status = (label: string) => (
    <Text variant="caption" tone="muted">
      {label}
    </Text>
  );

  const divider = <View style={{ height: 1, backgroundColor: theme.color.border }} />;

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
          {/* A shield, not the people glyph this screen used to open with: the
              subject is what is kept and who cannot reach it, not who is in
              your groups. */}
          <Ionicons name="shield-checkmark-outline" size={64} color={theme.color.text} />
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

        {/* The switches, first, for the reader who came from Settings. Each is a
            state they can read off in a second — on or off, how many — rather
            than a paragraph that describes one. */}
        {session ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title={t.privacy.controlsSection} />
            <Card style={{ paddingVertical: theme.spacing.xs }}>
              <ListRow
                title={t.privacy.appLockRow}
                subtitle={t.privacy.appLockHint}
                onPress={() => router.push('/settings/lock')}
                leading={
                  <Ionicons
                    name="finger-print-outline"
                    size={iconSize.md}
                    color={theme.color.brand}
                  />
                }
                trailing={
                  <Row style={{ gap: theme.spacing.xs }}>
                    {status(
                      !lockSupported
                        ? t.privacy.appLockUnavailable
                        : lockEnabled
                          ? t.privacy.statusOn
                          : t.privacy.statusOff,
                    )}
                    {chevron}
                  </Row>
                }
              />
              {divider}
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
                  <Row style={{ gap: theme.spacing.xs }}>
                    {status(
                      blocked.length > 0
                        ? blocked.length.toLocaleString(locale)
                        : t.privacy.blockedNone,
                    )}
                    {chevron}
                  </Row>
                }
              />
              {/* The most sensitive switch on the page — it can record screens
                  with names and amounts on them — so it sits in the open with
                  the other controls rather than as a footnote under a
                  paragraph. Hidden entirely on a build with no Clarity project,
                  where it would toggle nothing. */}
              {clarityConfigured ? (
                <>
                  {divider}
                  <ListRow
                    title={t.privacy.sessionReplayRow}
                    subtitle={t.privacy.sessionReplayHint}
                    leading={
                      <Ionicons
                        name="videocam-outline"
                        size={iconSize.md}
                        color={theme.color.brand}
                      />
                    }
                    trailing={
                      <Toggle
                        value={replay}
                        onValueChange={onReplayChange}
                        accessibilityLabel={t.privacy.sessionReplayRow}
                      />
                    }
                  />
                </>
              ) : null}
            </Card>
          </View>
        ) : null}

        {/* Taking a copy out is not destructive and does not belong next to the
            row that ends the account, so it stands on its own. */}
        {session ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title={t.privacy.dataControlsSection} />
            <Card style={{ paddingVertical: theme.spacing.xs }}>
              <ListRow
                title={t.privacy.exportRow}
                subtitle={t.privacy.exportRowHint}
                onPress={() => router.push('/settings/export')}
                leading={
                  <Ionicons name="download-outline" size={iconSize.md} color={theme.color.brand} />
                }
                trailing={chevron}
              />
            </Card>
          </View>
        ) : null}

        {/* The policy itself: a glyph, the point, and one line of what it says.
            Tapping opens the full paragraph. Signed out every one is already
            open — this is the policy then, not a settings screen. */}
        <View style={{ gap: theme.spacing.sm }}>
          {session ? <SectionHeader title={t.privacy.policySection} /> : null}
          <View style={{ gap: theme.spacing.lg }}>
            {sections.map((section) => {
              const expanded = isOpen(section.id);
              return (
                <Pressable
                  key={section.id}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  accessibilityLabel={section.title}
                  accessibilityHint={expanded ? t.privacy.collapseLabel : t.privacy.expandLabel}
                  onPress={() => toggleSection(section.id)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                  <Row style={{ alignItems: 'flex-start', gap: theme.spacing.md }}>
                    <Ionicons
                      name={section.icon}
                      size={iconSize.md}
                      color={theme.color.brand}
                      style={{ marginTop: 2 }}
                    />
                    <View style={{ flex: 1, gap: theme.spacing.xs }}>
                      <Text variant="subheading">{section.title}</Text>
                      <Text variant="body" tone="muted">
                        {expanded ? section.body : section.summary}
                      </Text>
                    </View>
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={iconSize.sm}
                      color={theme.color.textFaint}
                      style={{ marginTop: 4 }}
                    />
                  </Row>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={{ gap: theme.spacing.sm }}>
          <SectionHeader title={t.privacy.legalSection} />
          <Card style={{ paddingVertical: theme.spacing.xs }}>
            {/* A policy that explains your rights and gives you nobody to ask is
                half a policy. The route only exists behind a session, so it is
                offered to the reader who has one. */}
            {session ? (
              <>
                <ListRow
                  title={t.privacy.supportRow}
                  subtitle={t.privacy.supportRowHint}
                  onPress={() => router.push('/settings/feedback')}
                  leading={
                    <Ionicons
                      name="chatbubble-ellipses-outline"
                      size={iconSize.md}
                      color={theme.color.brand}
                    />
                  }
                  trailing={chevron}
                />
                {divider}
              </>
            ) : null}
            <ListRow
              title={t.privacy.licensesRow}
              subtitle={t.privacy.licensesRowHint}
              onPress={() => router.push('/settings/licenses')}
              leading={
                <Ionicons name="code-slash-outline" size={iconSize.md} color={theme.color.brand} />
              }
              trailing={chevron}
            />
          </Card>
        </View>

        {/* Ending the account is one divider away from nothing: it gets its own
            heading and its own card, at the bottom, past everything reversible. */}
        {session ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SectionHeader title={t.privacy.dangerSection} />
            <Card style={{ paddingVertical: theme.spacing.xs }}>
              <ListRow
                title={t.privacy.deleteRow}
                subtitle={t.privacy.deleteRowHint}
                destructive
                onPress={() => router.push('/settings/delete-account')}
                leading={
                  <Ionicons name="trash-outline" size={iconSize.md} color={theme.color.negative} />
                }
                trailing={chevron}
              />
            </Card>
          </View>
        ) : null}

        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="micro" tone="muted">
            {t.privacy.lastUpdated.replace(
              '{date}',
              new Date(`${POLICY_UPDATED}T12:00:00`).toLocaleDateString(locale, {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              }),
            )}
          </Text>
          <Text variant="micro" tone="muted">
            {t.privacy.englishGoverns}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
