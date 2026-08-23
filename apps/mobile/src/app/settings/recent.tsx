/**
 * How many recent expenses the watch shows.
 *
 * A short preference screen — pick 3, 5, or 10 — modelled on the Shortcut
 * settings screen. The value is device-local (AsyncStorage via useRecentCount)
 * and is relayed to a paired watch by the watch bridge.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { RECENT_COUNT_OPTIONS, type RecentCount } from '@waves/core';
import {
  Card,
  Divider,
  IconButton,
  Row,
  Screen,
  Text,
  directionalIcon,
  iconSize,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { useStrings } from '@/i18n';
import { useRecentCount } from '@/lib/recentCount';

export default function RecentSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { count, setCount } = useRecentCount();

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
            <Text variant="heading">{t.recent.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="body" tone="muted">
          {t.recent.intro}
        </Text>

        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.recent.countLabel}
          </Text>
          <Card padded={false} style={{ overflow: 'hidden' }}>
            {RECENT_COUNT_OPTIONS.map((option: RecentCount, index) => {
              const selected = count === option;
              const label = t.recent.countOption.replace('{count}', String(option));
              return (
                <View key={option}>
                  {index > 0 ? <Divider /> : null}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={label}
                    onPress={() => void setCount(option)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                      paddingHorizontal: theme.spacing.lg,
                      paddingVertical: theme.spacing.lg,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <Ionicons
                      name="list-outline"
                      size={iconSize.lg}
                      color={selected ? theme.color.brand : theme.color.textMuted}
                    />
                    <Text variant="subheading" style={{ flex: 1 }}>
                      {label}
                    </Text>
                    {selected ? (
                      <Ionicons name="checkmark" size={iconSize.lg} color={theme.color.brand} />
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </Card>
        </View>

        <Text variant="micro" tone="faint" align="center">
          {t.recent.watchHint}
        </Text>
      </ScrollView>
    </Screen>
  );
}
