/**
 * The language, offered before there is anywhere to put a setting.
 *
 * The settings row is the right home for this once somebody is inside the app.
 * It is the wrong home for somebody standing at the front door who cannot read
 * the door — they would have to sign in, find the account tab, find the third
 * face of it, and scroll, all in a language they opened by accident. So the
 * choice is also offered flat, on the way in.
 *
 * Four chips, each written in its own script and nothing else. No "follow my
 * phone" option here: following the phone is what the app is already doing, and
 * a row of five where one of them is a sentence in English is a row that has
 * stopped being scannable. Tapping a script is the whole interaction.
 *
 * Choosing Arabic changes the words at once and the *direction* only after the
 * app is opened again — `@/i18n/language` explains why at length. Here that
 * costs one line of small print, and only while it is true.
 */

import { View } from 'react-native';

import { Chip, Row, Text, useTheme } from '@baaki/ui';

import { isRtlLanguage, LANGUAGE_NAMES, LANGUAGES, useStrings } from '@/i18n';
import { useLanguage } from '@/i18n/language';

export function LanguagePicker({ align = 'center' }: { align?: 'center' | 'flex-start' }) {
  const theme = useTheme();
  const { t } = useStrings();
  const { language, setLanguage, restartNeeded } = useLanguage();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {/* Wrapping rather than scrolling. Four is few enough to show all four,
          and a language hidden off the edge of a rail is a language somebody
          who cannot read the screen will never find. */}
      <Row
        gap={theme.spacing.sm}
        style={{ justifyContent: align, flexWrap: 'wrap' }}
        accessibilityRole="radiogroup"
      >
        {LANGUAGES.map((entry) => (
          <Chip
            key={entry}
            // The endonym alone. Somebody hunting for their own language is
            // matching the shape of their script, not reading a label.
            label={LANGUAGE_NAMES[entry].own}
            selected={entry === language}
            onPress={() => void setLanguage(entry)}
          />
        ))}
      </Row>

      {restartNeeded ? (
        <Text variant="micro" tone="faint" align={align === 'center' ? 'center' : 'left'}>
          {isRtlLanguage(language) ? t.signIn.restartToMirror : t.signIn.restartToUnmirror}
        </Text>
      ) : null}
    </View>
  );
}
