/**
 * The quick-shortcut settings — one action, two ways to fire it.
 *
 * The person picks what the shortcut does (or turns it off), and whether the
 * two-finger double-tap is armed. The app-icon menu follows the same choice.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import {
  Card,
  Divider,
  IconButton,
  Row,
  Screen,
  Text,
  Toggle,
  directionalIcon,
  iconSize,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { useStrings } from '@/i18n';
import { useShortcut, type ShortcutAction } from '@/lib/shortcut';

export default function ShortcutSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { action, doubleTap, setAction, setDoubleTap } = useShortcut();

  const options: { value: ShortcutAction; icon: keyof typeof Ionicons.glyphMap; label: string }[] =
    [
      { value: 'scan', icon: 'camera-outline', label: t.shortcut.optionScan },
      { value: 'voice', icon: 'mic-outline', label: t.shortcut.optionVoice },
      { value: 'add', icon: 'add-circle-outline', label: t.shortcut.optionAdd },
      { value: 'off', icon: 'remove-circle-outline', label: t.shortcut.optionOff },
    ];

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
            <Text variant="heading">{t.shortcut.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Text variant="body" tone="muted">
          {t.shortcut.intro}
        </Text>

        {/* The action the shortcut performs. */}
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="muted">
            {t.shortcut.actionLabel}
          </Text>
          <Card padded={false} style={{ overflow: 'hidden' }}>
            {options.map((option, index) => {
              const selected = action === option.value;
              return (
                <View key={option.value}>
                  {index > 0 ? <Divider /> : null}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={option.label}
                    onPress={() => void setAction(option.value)}
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
                      name={option.icon}
                      size={iconSize.lg}
                      color={selected ? theme.color.brand : theme.color.textMuted}
                    />
                    <Text variant="subheading" style={{ flex: 1 }}>
                      {option.label}
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

        {/* The two-finger double-tap trigger. */}
        <Card style={{ gap: theme.spacing.sm }}>
          <Row style={{ justifyContent: 'space-between', gap: theme.spacing.lg }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="subheading">{t.shortcut.doubleTapTitle}</Text>
              <Text variant="caption" tone="muted">
                {t.shortcut.doubleTapExplain}
              </Text>
            </View>
            <Toggle
              value={doubleTap}
              onValueChange={(value) => void setDoubleTap(value)}
              accessibilityLabel={t.shortcut.doubleTapTitle}
              disabled={action === 'off'}
            />
          </Row>
        </Card>

        <Text variant="micro" tone="faint" align="center">
          {t.shortcut.iconHint}
        </Text>
      </ScrollView>
    </Screen>
  );
}
