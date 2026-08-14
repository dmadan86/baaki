/**
 * Security.
 *
 * Two settings and a way out. The lock guards the screen when the phone is
 * handed over; the delay decides how often that guard gets in the way of the
 * person who owns it. Both matter, because a lock that asks too often is a lock
 * somebody turns off, and a lock nobody turns on protects nothing.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, ScrollView, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Chip,
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
import { useAuth } from '@/lib/auth';
import { describeGrace, GRACE_CHOICES, useLock } from '@/lib/lock';

export default function LockSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t, locale } = useStrings();
  const { enabled, supported, graceSeconds, setEnabled, setGraceSeconds } = useLock();
  const { isGuest, signOut } = useAuth();

  const confirmSignOut = (): void => {
    Alert.alert(
      t.lock.signOutQuestion,
      isGuest
        ? // The one case where signing out is not reversible: a guest session
          // lives on this device and nowhere else, so there is no credential to
          // come back with.
          t.lock.signOutGuestWarning
        : t.lock.signOutReassure,
      [
        { text: t.lock.staySignedIn, style: 'cancel' },
        { text: t.lock.signOut, style: 'destructive', onPress: () => void signOut() },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
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
            <Text variant="heading">{t.lock.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">{t.lock.requireBiometrics}</Text>
              <Text variant="caption" tone="muted">
                {t.lock.requireExplain}
              </Text>
            </View>
            <Toggle
              value={enabled}
              disabled={!supported}
              onValueChange={(value) => void setEnabled(value)}
              accessibilityLabel={t.lock.appLock}
            />
          </Row>
        </Card>

        {!supported ? <Badge label={t.lock.unsupported} /> : null}

        {enabled ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">{t.lock.askAgainAfter}</Text>
            <Text variant="caption" tone="muted">
              {t.lock.askAgainExplain}
            </Text>
            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {GRACE_CHOICES.map((seconds) => (
                <Chip
                  key={seconds}
                  label={describeGrace(seconds, t, locale)}
                  selected={graceSeconds === seconds}
                  onPress={() => void setGraceSeconds(seconds)}
                />
              ))}
            </Row>
            <Text variant="micro" tone="muted">
              {t.lock.reopenAlwaysAsks}
            </Text>
          </Card>
        ) : null}

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading">{t.lock.signOut}</Text>
          <Text variant="caption" tone="muted">
            {isGuest ? t.lock.signOutGuest : t.lock.signOutMember}
          </Text>
          <Button label={t.lock.signOut} variant="secondary" fullWidth onPress={confirmSignOut} />
        </Card>

        <Text variant="micro" tone="muted" align="center">
          {t.lock.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
