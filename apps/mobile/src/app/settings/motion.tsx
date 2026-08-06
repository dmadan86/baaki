/**
 * Motion, and the switch for it.
 *
 * Three states, not two: on, off, and "whatever the phone says". The third is
 * the default and matters most — somebody who has already told Android they get
 * motion sick should not have to tell every app separately, and an app that
 * makes them is an app they stop using.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Divider,
  IconButton,
  Row,
  Screen,
  Text,
  Toggle,
  useTheme,
} from '@baaki/ui';

import { useMotion } from '@/lib/motion';

export default function MotionSettingsScreen() {
  const theme = useTheme();
  const { animated, systemReducesMotion, overridden, setAnimated } = useMotion();

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
          <IconButton label="Back" onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">Motion</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ justifyContent: 'space-between', gap: theme.spacing.lg }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="subheading">Animate between screens</Text>
              <Text variant="caption" tone="muted">
                Screens slide in from the right, and sheets rise from the bottom — which is how a
                screen tells you whether you have gone somewhere or opened something on top of where
                you were.
              </Text>
            </View>
            <Toggle
              value={animated}
              onValueChange={(value) => void setAnimated(value)}
              accessibilityLabel="Animate between screens"
            />
          </Row>

          <Divider />

          <View style={{ gap: theme.spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="caption" tone="muted">
                This phone
              </Text>
              <Badge
                label={systemReducesMotion ? 'Reduce motion is on' : 'Reduce motion is off'}
                tone={systemReducesMotion ? 'brand' : 'neutral'}
              />
            </Row>
            <Text variant="caption" tone="muted">
              {overridden
                ? `You have set this yourself, so it stays ${animated ? 'on' : 'off'} whatever the phone says.`
                : systemReducesMotion
                  ? 'Following your accessibility settings, which ask for less movement.'
                  : 'Following your accessibility settings.'}
            </Text>
            {overridden ? (
              <Button
                label="Follow my phone's setting"
                variant="ghost"
                onPress={() => void setAnimated(null)}
              />
            ) : null}
          </View>
        </Card>

        <Text variant="micro" tone="faint" align="center">
          Turning motion off does not shorten the animations — it removes them. A faster animation
          is still an animation to somebody who cannot watch one.
        </Text>
      </ScrollView>
    </Screen>
  );
}
