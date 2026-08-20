/**
 * The gateway — the first screen after the splash for a signed-out person.
 *
 * A single brand field with the wordmark, the legal line, and two big choices:
 * make an account or sign in. It sits in front of the two auth doors (`sign-up`
 * and `sign-in`), which carry the actual ways in (Google, phone, email). This
 * screen only asks which errand you are on, the way Tinder, Bumble and Hinge all
 * open — brand first, one decision, nothing to read past the terms.
 *
 * NOTE — the legal line and "Trouble signing in?" are hardcoded English; the
 * i18n pass comes with the wiring. "Trouble signing in?" points at the sign-in
 * door for now, not a dedicated recovery flow. Both are follow-ups.
 */

import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

export default function WelcomeScreen() {
  const theme = useTheme();
  const { t } = useStrings();

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient
        colors={[...theme.gradient.brand] as [string, string, ...string[]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={{ flex: 1 }}
      >
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
          {/* The wordmark sits in the centre of the empty field above the fold. */}
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text
              style={{
                fontSize: 52,
                fontWeight: '800',
                letterSpacing: -1,
                color: theme.color.onBrand,
              }}
            >
              {t.common.appName}
            </Text>
          </View>

          {/* The legal line and the two choices are anchored to the bottom. */}
          <View style={{ paddingHorizontal: theme.spacing.xl, gap: theme.spacing.md }}>
            <Text
              align="center"
              style={{
                color: theme.color.onBrand,
                opacity: 0.95,
                marginBottom: theme.spacing.sm,
                lineHeight: 20,
              }}
            >
              By tapping &lsquo;Create account&rsquo; or &lsquo;Sign in&rsquo; you agree to our{' '}
              <Text style={{ color: theme.color.onBrand, fontWeight: '800' }}>Terms</Text>. Learn
              how we process your data in our{' '}
              <Text style={{ color: theme.color.onBrand, fontWeight: '800' }}>Privacy Policy</Text>{' '}
              and{' '}
              <Text style={{ color: theme.color.onBrand, fontWeight: '800' }}>Cookies Policy</Text>.
            </Text>

            <GatewayButton label={t.signIn.createAccount} onPress={() => router.push('/sign-up')} />
            <GatewayButton
              label={t.signIn.signInAction}
              onPress={() => router.replace('/sign-in')}
            />

            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace('/sign-in')}
              hitSlop={8}
              style={({ pressed }) => ({
                alignSelf: 'center',
                paddingVertical: theme.spacing.md,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ color: theme.color.onBrand, fontWeight: '800' }}>
                Trouble signing in?
              </Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </LinearGradient>
    </View>
  );
}

/** A white pill with ink text — the choices on the brand field. */
function GatewayButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.color.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <Text variant="subheading" style={{ color: theme.color.text, fontWeight: '800' }}>
        {label}
      </Text>
    </Pressable>
  );
}
