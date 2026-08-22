/**
 * The language, and the restart that a mirrored layout costs.
 *
 * Four languages and "follow my phone", which is the default and stays first.
 * Each one is written in its own script, because somebody who has opened the
 * app in a language they cannot read is scanning for the *shape* of their own
 * writing — "Tamil" spelled in Latin letters is not that shape.
 *
 * Choosing Arabic changes the words at once and the direction only after the
 * app is opened again. React Native decides right-to-left natively, before any
 * JavaScript runs, and there is no reload to call. So the screen says so, in a
 * banner that stays until it is true.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';

import {
  Button,
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
} from '@waves/ui';

import { isRtlLanguage, LANGUAGE_NAMES, LANGUAGES, useStrings, type Language } from '@/i18n';
import { useLanguage } from '@/i18n/language';
import { canRestart, restartApp } from '@/lib/restart';

export default function LanguageSettingsScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { stored, language, phoneLanguage, setLanguage, restartNeeded } = useLanguage();

  const rows: { key: string; title: string; subtitle: string; value: Language | null }[] = [
    {
      key: 'phone',
      title: t.misc.followMyPhone,
      subtitle: t.misc.currentlyLanguage.replace('{language}', LANGUAGE_NAMES[phoneLanguage].own),
      value: null,
    },
    ...LANGUAGES.map((entry) => ({
      key: entry,
      title: LANGUAGE_NAMES[entry].own,
      subtitle: isRtlLanguage(entry)
        ? `${LANGUAGE_NAMES[entry].english} · ${t.misc.rightToLeft}`
        : LANGUAGE_NAMES[entry].english,
      value: entry as Language | null,
    })),
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
            <Text variant="heading">{t.language}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* Above the list, not below it: somebody who has just chosen Arabic and
            is looking at a screen that did not mirror needs the explanation
            where their eyes already are. */}
        {restartNeeded ? (
          <Card style={{ backgroundColor: theme.color.buttonPrimary, gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Ionicons name="refresh" size={iconSize.md} color={theme.color.onBrand} />
              <Text variant="subheading" tone="onBrand">
                {t.account.restartTitle}
              </Text>
            </Row>
            <Text variant="caption" tone="onBrand">
              {isRtlLanguage(language)
                ? t.account.restartBannerMirror
                : t.account.restartBannerUnmirror}
            </Text>
            {/* The alert at the moment of the choice can be dismissed, and this
                is where somebody comes back to when they change their mind. */}
            {canRestart() ? (
              <Button
                label={t.account.restartNow}
                size="sm"
                variant="secondary"
                onPress={() => void restartApp()}
              />
            ) : null}
          </Card>
        ) : null}

        <Card padded={false} style={{ paddingHorizontal: theme.spacing.lg }}>
          {rows.map((row, index) => {
            const chosen = stored === row.value;
            return (
              <View key={row.key}>
                <ListRow
                  title={row.title}
                  subtitle={row.subtitle}
                  onPress={() => void setLanguage(row.value)}
                  accessibilityLabel={`${row.title}${chosen ? ', selected' : ''}`}
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
          {t.account.languageFooterNote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
