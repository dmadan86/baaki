/**
 * The "by continuing you agree to our Terms and Privacy Policy" line, with only
 * the two named documents underlined and tappable.
 *
 * The sentence carries `{terms}` and `{privacy}` placeholders (see
 * `t.entry.agreeTerms`) so word order survives translation; those two are
 * rendered as underlined spans that open the privacy screen, and everything
 * else stays plain. Nested `Text` with `onPress` keeps the links inline rather
 * than wrapping the whole line in one control.
 */

import { router } from 'expo-router';
import { Text, type TextStyle } from 'react-native';

import { useStrings } from '@/i18n';

export function LegalLine({ textStyle }: { textStyle?: TextStyle }) {
  const { t } = useStrings();
  const parts = t.entry.agreeTerms.split(/(\{terms\}|\{privacy\})/);

  return (
    <Text style={[{ textAlign: 'center' }, textStyle]}>
      {parts.map((part, index) =>
        part === '{terms}' || part === '{privacy}' ? (
          <Text
            key={index}
            accessibilityRole="link"
            onPress={() => router.push('/settings/privacy')}
            style={{ textDecorationLine: 'underline', fontWeight: '700' }}
          >
            {part === '{terms}' ? t.entry.termsWord : t.entry.privacyWord}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}
