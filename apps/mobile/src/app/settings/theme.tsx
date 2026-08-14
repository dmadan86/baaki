/**
 * Light or dark, and the switch for it.
 *
 * Three choices with "follow my phone" first, the default — the same shape as
 * the language and motion screens, because it is the same kind of decision: an
 * override the app remembers, sitting on top of a system setting it otherwise
 * honours. The design already carries a full dark palette; this is only the
 * control that lets somebody pick it.
 */

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
  Text,
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useStrings } from '@/i18n';
import { SchemePreference, useThemePreference } from '@/lib/theme';

export default function ThemeSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { preference, systemScheme, setPreference } = useThemePreference();

  const rows: {
    key: string;
    title: string;
    subtitle: string;
    icon: keyof typeof Ionicons.glyphMap;
    value: SchemePreference | null;
  }[] = [
    {
      key: 'system',
      title: t.misc.followMyPhone,
      subtitle: t.theme.currently.replace(
        '{scheme}',
        systemScheme === 'dark' ? t.theme.dark : t.theme.light,
      ),
      icon: 'phone-portrait-outline',
      value: null,
    },
    {
      key: 'light',
      title: t.theme.light,
      subtitle: t.theme.lightHint,
      icon: 'sunny-outline',
      value: SchemePreference.Light,
    },
    {
      key: 'dark',
      title: t.theme.dark,
      subtitle: t.theme.darkHint,
      icon: 'moon-outline',
      value: SchemePreference.Dark,
    },
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
            <Text variant="heading">{t.theme.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          {rows.map((row, index) => {
            const chosen = preference === row.value;
            return (
              <View key={row.key}>
                <ListRow
                  title={row.title}
                  subtitle={row.subtitle}
                  onPress={() => void setPreference(row.value)}
                  accessibilityLabel={`${row.title}${chosen ? ', selected' : ''}`}
                  leading={<Ionicons name={row.icon} size={iconSize.xl} color={theme.color.text} />}
                  trailing={
                    chosen ? (
                      <Ionicons name="checkmark" size={iconSize.lg} color={theme.color.brand} />
                    ) : null
                  }
                />
                {index < rows.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: theme.color.border }} />
                ) : null}
              </View>
            );
          })}
        </Card>

        <Text variant="micro" tone="muted" align="center">
          {t.theme.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
