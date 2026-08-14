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
  directionalIcon,
  Divider,
  IconButton,
  Row,
  Screen,
  Text,
  Toggle,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useMotion } from '@/lib/motion';

export default function MotionSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { animated, systemReducesMotion, overridden, setAnimated } = useMotion();

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
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.motion.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ gap: theme.spacing.lg }}>
          <Row style={{ justifyContent: 'space-between', gap: theme.spacing.lg }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="subheading">{t.motion.animateBetweenScreens}</Text>
              <Text variant="caption" tone="muted">
                {t.motion.animateExplain}
              </Text>
            </View>
            <Toggle
              value={animated}
              onValueChange={(value) => void setAnimated(value)}
              accessibilityLabel={t.motion.animateBetweenScreens}
            />
          </Row>

          <Divider />

          <View style={{ gap: theme.spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text variant="caption" tone="muted">
                {t.motion.thisPhone}
              </Text>
              <Badge
                label={systemReducesMotion ? t.motion.reduceMotionOn : t.motion.reduceMotionOff}
                tone={systemReducesMotion ? 'brand' : 'neutral'}
              />
            </Row>
            <Text variant="caption" tone="muted">
              {overridden
                ? animated
                  ? t.motion.setYourselfOn
                  : t.motion.setYourselfOff
                : systemReducesMotion
                  ? t.motion.followingReduced
                  : t.motion.following}
            </Text>
            {overridden ? (
              <Button
                label={t.motion.followPhone}
                variant="ghost"
                onPress={() => void setAnimated(null)}
              />
            ) : null}
          </View>
        </Card>

        <Text variant="micro" tone="faint" align="center">
          {t.motion.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
