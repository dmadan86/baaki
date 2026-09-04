/**
 * The language list, in the one form it has.
 *
 * There are two doors to this choice — the settings tab for somebody already
 * inside the app, and a public route reached from the globe on the welcome and
 * sign-in headers for somebody who opened the app in a script they cannot read.
 * They were two screens with two different lists: script badges, a soft brand
 * fill and a radio mark in settings; a plain divided list with a bare checkmark
 * at the front door. The front door is the one place the design mattered most
 * and the one place it was thinner, which is backwards. So the list lives here,
 * once, and both screens render it.
 *
 * Each language is written in its own script, because somebody scanning for
 * their own writing is looking for its *shape* — "Tamil" spelled in Latin
 * letters is not that shape. The same reasoning drives the coloured badge: a
 * round chip carrying the language's own script initial — "A", "அ", "अ", "ع" —
 * in a distinct brand tint, so a row is recognised by shape and colour before a
 * single word of a foreign UI is read. A national flag would be worse than
 * useless: two of the four languages (Tamil, Hindi) share one country, so a
 * flag names the state, not the tongue.
 *
 * Choosing Arabic changes the words at once and the direction only after the
 * app is opened again. React Native decides right-to-left natively, before any
 * JavaScript runs, and there is no reload to call. So the banner says so, and
 * stays until it is true.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, View } from 'react-native';

import { Button, Card, iconSize, Row, Text, useTheme, type TintName } from '@waves/ui';

import { isRtlLanguage, Language, LANGUAGE_NAMES, LANGUAGES, useStrings } from '@/i18n';
import { useLanguage } from '@/i18n/language';
import { canRestart, restartApp } from '@/lib/restart';

/**
 * The script-initial glyph and the brand tint each language wears.
 *
 * The glyphs are literals in this file, not translated strings: a badge shows
 * *that language's* own script regardless of the app's current locale, so it is
 * a fixed property of the language, not UI copy. Tints are hand-picked from the
 * app's pastel family (never new hex) so the four hues stay maximally distinct —
 * a cool blue, a warm coral, an amber, a violet — rather than colliding the way
 * a hash-based assignment eventually would across only four keys.
 */
const LANGUAGE_BADGE: Readonly<Record<Language, { glyph: string; tint: TintName }>> = {
  [Language.En]: { glyph: 'A', tint: 'sky' },
  [Language.Ta]: { glyph: 'அ', tint: 'coral' },
  [Language.Hi]: { glyph: 'अ', tint: 'peach' },
  [Language.Ar]: { glyph: 'ع', tint: 'lilac' },
};

/** The diameter of the leading badge — matched to the default Avatar size. */
const BADGE_SIZE = 44;

/**
 * A round, brand-tinted chip carrying either a language's script initial or the
 * "follow my phone" glyph. It reuses the theme's tint pairs (bg + AA-safe ink),
 * so the letter always clears contrast on its own colour.
 */
function LanguageBadge({
  glyph,
  tint,
  icon,
}: {
  glyph?: string;
  tint?: TintName;
  /** Used for "follow my phone", which stands for a setting, not a script. */
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const theme = useTheme();
  // The phone row wears the brand's own soft wash rather than a language tint —
  // it is the app's default, not a fifth language, and reads that way.
  const background = tint ? theme.tint[tint].bg : theme.color.brandSoft;
  const foreground = tint ? theme.tint[tint].ink : theme.color.brand;

  return (
    <View
      style={{
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        borderRadius: BADGE_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
      }}
    >
      {icon ? (
        <Ionicons name={icon} size={iconSize.xl} color={foreground} />
      ) : (
        <Text style={{ fontSize: 20, fontWeight: '700', color: foreground }}>{glyph}</Text>
      )}
    </View>
  );
}

/**
 * The restart banner, the radio list and the footnote — the whole body of both
 * language screens. Each screen keeps its own header and scroll container,
 * because the two differ in ways that are theirs: a tab-bar clearance on one, a
 * safe-area inset and a public back target on the other.
 */
export function LanguageChoiceList() {
  const theme = useTheme();
  const { t } = useStrings();
  const { stored, language, phoneLanguage, setLanguage, restartNeeded } = useLanguage();

  const rows: {
    key: string;
    title: string;
    subtitle: string;
    value: Language | null;
    badge: { glyph?: string; tint?: TintName; icon?: keyof typeof Ionicons.glyphMap };
  }[] = [
    {
      key: 'phone',
      title: t.misc.followMyPhone,
      subtitle: t.misc.currentlyLanguage.replace('{language}', LANGUAGE_NAMES[phoneLanguage].own),
      value: null,
      badge: { icon: 'phone-portrait-outline' },
    },
    ...LANGUAGES.map((entry) => ({
      key: entry,
      title: LANGUAGE_NAMES[entry].own,
      subtitle: isRtlLanguage(entry)
        ? `${LANGUAGE_NAMES[entry].english} · ${t.misc.rightToLeft}`
        : LANGUAGE_NAMES[entry].english,
      value: entry as Language | null,
      badge: LANGUAGE_BADGE[entry],
    })),
  ];

  return (
    <>
      {/* Above the list, not below it: somebody who has just chosen Arabic and
          is looking at a screen that did not mirror needs the explanation where
          their eyes already are. */}
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
          {/* The alert at the moment of the choice can be dismissed, and this is
              where somebody comes back to when they change their mind. */}
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

      {/* One tap-target per row. The list behaves as a radio group: the whole
          list is `radiogroup`, each row a `radio` carrying its selected state,
          so a screen reader announces "2 of 5, selected" rather than reading a
          loose checkmark glyph. */}
      <Card padded={false} style={{ padding: theme.spacing.xs }} accessibilityRole="radiogroup">
        {rows.map((row) => {
          const chosen = stored === row.value;
          return (
            <Pressable
              key={row.key}
              accessibilityRole="radio"
              // The chosen state rides on `accessibilityState`, which the OS
              // announces natively for a radio ("selected"); spelling it into
              // the label as well would say it twice.
              accessibilityState={{ selected: chosen }}
              accessibilityLabel={`${row.title}, ${row.subtitle}`}
              onPress={() => void setLanguage(row.value)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
                paddingHorizontal: theme.spacing.lg,
                borderRadius: theme.radius.md,
                // The chosen row lifts onto the brand's soft wash — a quiet fill
                // rather than a loud border, so the colour lives with the badges
                // and not against them.
                backgroundColor: chosen ? theme.color.brandSoft : 'transparent',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <LanguageBadge glyph={row.badge.glyph} tint={row.badge.tint} icon={row.badge.icon} />
              <View style={{ flex: 1 }}>
                <Text variant="subheading" numberOfLines={1}>
                  {row.title}
                </Text>
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {row.subtitle}
                </Text>
              </View>
              {/* The radio mark the refs use: a filled brand check-circle when
                  chosen, a hollow ring otherwise — present on every row so the
                  trailing column never jumps as the selection moves. */}
              <Ionicons
                name={chosen ? 'checkmark-circle' : 'ellipse-outline'}
                size={iconSize.jumbo}
                color={chosen ? theme.color.brand : theme.color.border}
              />
            </Pressable>
          );
        })}
      </Card>

      <Text variant="micro" tone="muted" align="center">
        {t.account.languageFooterNote}
      </Text>
    </>
  );
}
