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

import { Card, directionalIcon, IconButton, ListRow, Row, Screen, Text, useTheme } from '@baaki/ui';

import { isRtlLanguage, LANGUAGE_NAMES, LANGUAGES, useStrings, type Language } from '@/i18n';
import { useLanguage } from '@/i18n/language';

export default function LanguageSettingsScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { stored, language, phoneLanguage, setLanguage, restartNeeded } = useLanguage();

  const rows: { key: string; title: string; subtitle: string; value: Language | null }[] = [
    {
      key: 'phone',
      title: 'Follow my phone',
      subtitle: `Currently ${LANGUAGE_NAMES[phoneLanguage].english}`,
      value: null,
    },
    ...LANGUAGES.map((entry) => ({
      key: entry,
      title: LANGUAGE_NAMES[entry].own,
      subtitle: isRtlLanguage(entry)
        ? `${LANGUAGE_NAMES[entry].english} · right to left`
        : LANGUAGE_NAMES[entry].english,
      value: entry as Language | null,
    })),
  ];

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
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
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
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Ionicons name="refresh" size={18} color={theme.color.brand} />
              <Text variant="subheading" tone="brand">
                Close and open Baaki again
              </Text>
            </Row>
            <Text variant="caption" tone="muted">
              {isRtlLanguage(language)
                ? 'The words have changed already. Mirroring the layout — the arrows, the sides everything sits on — is something the phone decides when the app starts, so it takes effect next time you open it.'
                : 'The words have changed already. Turning the mirrored layout back the other way is something the phone decides when the app starts, so it takes effect next time you open it.'}
            </Text>
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
                      <Ionicons name="checkmark" size={20} color={theme.color.brand} />
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

        <Text variant="micro" tone="faint" align="center">
          Your phone&apos;s language is the default, and choosing one here only changes Baaki.
          Amounts and dates still follow where you are — reading the app in Hindi in Dubai does not
          move you to India.
        </Text>
      </ScrollView>
    </Screen>
  );
}
