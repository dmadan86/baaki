/**
 * The gateway — the first screen after the splash for a signed-out person.
 *
 * A single brand field with a back chevron, the wordmark sitting in the upper
 * third, the legal line, and the choices anchored to the bottom: make an
 * account or sign in. It sits in front of the two auth doors (`sign-up` and
 * `sign-in`), which carry the actual ways in (Google, phone, email). This
 * screen only asks which errand you are on, the way Tinder, Bumble and Hinge
 * all open — brand first, one decision, nothing to read past the terms.
 *
 * NOTE — the legal line and "Trouble signing in?" are hardcoded English; the
 * i18n pass comes with the wiring. "Trouble signing in?" points at the sign-in
 * door for now, not a dedicated recovery flow. Both are follow-ups.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { iconSize, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';

/** The gateway's green wash — a light stop into the base green (#65B63E) into a
    darker one, top to bottom, matching the splash. A local screen colour, not a
    brand token: the app's brand is purple; this entry field is deliberately its
    own green. */
const GATEWAY_GRADIENT = ['#7BC94E', '#65B63E', '#4F9A2E'] as const;

export default function WelcomeScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const canGoBack = router.canGoBack();

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient
        colors={GATEWAY_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={{ flex: 1 }}
      >
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
          {/* The header: a back chevron top-left (only when there is somewhere
              to go back to) and the language picker top-right, so a person who
              opened the app in a script they cannot read can switch it from the
              first frame, without leaving the gateway. */}
          <View
            style={{
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: theme.spacing.sm,
            }}
          >
            {canGoBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t.common.back}
                onPress={() => router.back()}
                hitSlop={12}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Ionicons name="chevron-back" size={iconSize.lg} color={theme.color.onBrand} />
              </Pressable>
            ) : (
              <View style={{ width: 44 }} />
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.language}
              onPress={() => router.push('/language')}
              hitSlop={12}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Ionicons name="globe-outline" size={iconSize.lg} color={theme.color.onBrand} />
            </Pressable>
          </View>

          {/* The wordmark sits in the upper third: a short spacer above, a
              longer one below, so it rides high on the empty field. */}
          <View style={{ flex: 0.7 }} />
          <View style={{ alignItems: 'center' }}>
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
          <View style={{ flex: 1.3 }} />

          {/* The legal line and the choices are anchored to the bottom, lifted
              off the safe-area edge so "Trouble signing in?" does not sit flush
              against the very bottom. */}
          <View
            style={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.xl,
              gap: theme.spacing.md,
            }}
          >
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

            <GatewayButton
              icon="person-add-outline"
              label={t.signIn.createAccount}
              onPress={() => router.push('/sign-up')}
            />
            <GatewayButton
              primary
              icon="log-in-outline"
              label={t.signIn.signInAction}
              onPress={() => router.push('/sign-in')}
            />

            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/sign-in')}
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

/** A pill with a leading icon and a centred label — the choices on the brand
    field. `primary` fills it with the near-black primary-button ink and white
    label; otherwise it is a white pill with ink text. The icon sits at the
    left, the label stays centred, the way the reference lays its buttons out. */
function GatewayButton({
  icon,
  label,
  onPress,
  primary = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const theme = useTheme();
  const bg = primary ? theme.color.buttonPrimary : theme.color.surface;
  const ink = primary ? theme.color.onButtonPrimary : theme.color.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 56,
        borderRadius: theme.radius.pill,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{ position: 'absolute', left: theme.spacing.xl }}>
        <Ionicons name={icon} size={iconSize.md} color={ink} />
      </View>
      <Text variant="subheading" style={{ color: ink, fontWeight: '800' }}>
        {label}
      </Text>
    </Pressable>
  );
}
