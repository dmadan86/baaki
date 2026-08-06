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
import { Alert, ScrollView, Switch, View } from 'react-native';

import { Badge, Button, Card, Chip, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { useAuth } from '@/lib/auth';
import { describeGrace, GRACE_CHOICES, useLock } from '@/lib/lock';

export default function LockSettingsScreen() {
  const theme = useTheme();
  const { enabled, supported, graceSeconds, setEnabled, setGraceSeconds } = useLock();
  const { isGuest, signOut } = useAuth();

  const confirmSignOut = (): void => {
    Alert.alert(
      'Sign out?',
      isGuest
        ? // The one case where signing out is not reversible: a guest session
          // lives on this device and nowhere else, so there is no credential to
          // come back with.
          'This is a guest account, so signing out leaves no way back into it. Add an email or phone number first if you want to keep it.'
        : 'You can sign back in whenever you like. Nothing is deleted.',
      [
        { text: 'Stay signed in', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">Security</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">Require biometrics or a passcode</Text>
              <Text variant="caption" tone="muted">
                Handing someone your phone to show them the split should not show them everything
                else.
              </Text>
            </View>
            <Switch
              value={enabled}
              disabled={!supported}
              onValueChange={(value) => void setEnabled(value)}
              trackColor={{ true: theme.color.brand, false: theme.color.border }}
              accessibilityLabel="App lock"
            />
          </Row>
        </Card>

        {!supported ? <Badge label="This device has no biometrics or passcode set up" /> : null}

        {enabled ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">Ask again after</Text>
            <Text variant="caption" tone="muted">
              Time in the background before Baaki locks. Settling by UPI sends you to another app
              and back, so locking the instant you leave means unlocking every time you pay
              somebody.
            </Text>
            <Row style={{ flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {GRACE_CHOICES.map((seconds) => (
                <Chip
                  key={seconds}
                  label={describeGrace(seconds)}
                  selected={graceSeconds === seconds}
                  onPress={() => void setGraceSeconds(seconds)}
                />
              ))}
            </Row>
            <Text variant="micro" tone="faint">
              Reopening Baaki after it has been closed always asks, whatever this says.
            </Text>
          </Card>
        ) : null}

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading">Sign out</Text>
          <Text variant="caption" tone="muted">
            {isGuest
              ? 'This account lives on this device only. Signing out ends it.'
              : 'Your groups and history stay exactly where they are.'}
          </Text>
          <Button label="Sign out" variant="secondary" fullWidth onPress={confirmSignOut} />
        </Card>

        <Text variant="micro" tone="faint" align="center">
          This guards the screen, not the data — your ledger is protected by row-level security on
          the server whether the lock is on or not.
        </Text>
      </ScrollView>
    </Screen>
  );
}
