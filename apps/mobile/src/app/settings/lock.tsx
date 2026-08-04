import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, Switch, View } from 'react-native';

import { Badge, Card, IconButton, Row, Screen, Text, useTheme } from '@baaki/ui';

import { useLock } from '@/lib/lock';

export default function LockSettingsScreen() {
  const theme = useTheme();
  const { enabled, supported, setEnabled } = useLock();

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
            <Text variant="heading">App lock</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: theme.spacing.lg }}>
              <Text variant="subheading">Require biometrics or a passcode</Text>
              <Text variant="caption" tone="muted">
                Baaki locks whenever it goes to the background. Handing someone your phone to show
                them the split should not show them everything else.
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

        <Text variant="micro" tone="faint" align="center">
          This guards the screen, not the data — your ledger is protected by row-level security on
          the server whether the lock is on or not.
        </Text>
      </ScrollView>
    </Screen>
  );
}
