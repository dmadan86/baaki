/**
 * Preferred language — a standalone screen, reachable from the welcome gateway
 * before there is any account.
 *
 * The settings tab is the home for this once somebody is inside the app; this
 * is the same choice offered flat at the front door, for a person who opened
 * the app in a script they cannot read. It is a full screen rather than the
 * compact dropdown so the list of scripts is the whole surface: a colour is
 * what a lost reader scans for, so the chosen row wears the brand check.
 *
 * A public route (see `_layout`), so it works with no session. Choosing Arabic
 * changes the words at once and the direction only after the app is opened
 * again — `@/i18n/language` explains why — so the restart note stays until it
 * is true.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  Card,
  directionalIcon,
  iconSize,
  ListRow,
  Row,
  Screen,
  Text,
  useTheme,
} from '@waves/ui';

import { isRtlLanguage, LANGUAGE_NAMES, LANGUAGES, useStrings, type Language } from '@/i18n';
import { useLanguage } from '@/i18n/language';
import { canRestart, restartApp } from '@/lib/restart';

export default function LanguageScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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
          paddingBottom: insets.bottom + theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Back to the gateway, the chevron in the primary ink. */}
        <Row style={{ paddingTop: theme.spacing.md }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={12}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.buttonPrimary}
            />
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.language}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* Choosing Arabic mirrors the layout only after a restart, so the note
            sits above the list, where the eyes already are. */}
        {restartNeeded ? (
          <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.sm }}>
            <Row style={{ gap: theme.spacing.sm }}>
              <Ionicons name="refresh" size={iconSize.md} color={theme.color.brand} />
              <Text variant="subheading" tone="brand">
                {t.account.restartTitle}
              </Text>
            </Row>
            <Text variant="caption" tone="muted">
              {isRtlLanguage(language)
                ? t.account.restartBannerMirror
                : t.account.restartBannerUnmirror}
            </Text>
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
      </ScrollView>
    </Screen>
  );
}
