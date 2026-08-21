/**
 * The "by continuing you agree to our Terms and Privacy Policy" line, with only
 * Privacy Policy underlined and tappable.
 *
 * The sentence carries `{terms}` and `{privacy}` placeholders (see
 * `t.entry.agreeTerms`) so word order survives translation. Only `{privacy}`
 * opens the privacy screen — the one document that exists; `{terms}` is plain
 * words for now, since there is no separate terms page to point it at. Nested
 * `Text` with `onPress` keeps the link inline rather than wrapping the whole
 * line in one control.
 */

import { router } from 'expo-router';
import { Text, type TextStyle } from 'react-native';

import { useStrings } from '@/i18n';

export function LegalLine({ textStyle }: { textStyle?: TextStyle }) {
  const { t } = useStrings();
  const parts = t.entry.agreeTerms.split(/(\{terms\}|\{privacy\})/);

  return (
    <Text style={[{ textAlign: 'center' }, textStyle]}>
      {parts.map((part, index) => {
        if (part === '{privacy}') {
          return (
            <Text
              key={index}
              accessibilityRole="link"
              onPress={() => router.push('/settings/privacy')}
              style={{ textDecorationLine: 'underline', fontWeight: '700' }}
            >
              {t.entry.privacyWord}
            </Text>
          );
        }
        if (part === '{terms}') return t.entry.termsWord;
        return part;
      })}
    </Text>
  );
}
