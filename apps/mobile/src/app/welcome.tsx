/**
 * The door — the first screen after the splash for a signed-out person.
 *
 * It used to be a gateway: a wordmark on the green, and two buttons that only
 * asked which errand you were on ("Create account" / "Sign in"), both of which
 * landed you on a form. That is one screen of nothing before anything can
 * happen. This is the Headway shape instead — a headline saying what the app
 * is, then the ways in themselves, right here: one primary provider button
 * (Apple on iOS, Google elsewhere), the rest as a row of tiles beneath it, and
 * a Skip pill in the header for the guest way in (ADR-006 — nobody registers
 * before they can split a bill; Skip is now where that lives).
 *
 * Tapping Google or Apple signs in from this screen. The sign-up form is not
 * gone, it has simply moved behind the email tile, which is where a form
 * belongs: one of several ways in, not the toll gate in front of all of them.
 *
 * The language globe still sits in the header whenever there is no back
 * chevron, so somebody who opened the app in a script they cannot read can
 * change it from the first frame.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Callout, directionalIcon, iconSize, Row, Text, useTheme } from '@waves/ui';

import { LegalLine } from '@/components/LegalLine';
import { ProviderButton, SocialTile } from '@/components/SocialTile';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

/** The door's green wash — a light stop into the base green (#65B63E) into a
    darker one, top to bottom, matching the splash. A local screen colour, not a
    brand token: the app's brand is purple; this entry field is deliberately its
    own green. */
const GATEWAY_GRADIENT = ['#7BC94E', '#65B63E', '#4F9A2E'] as const;

/** The Skip pill's face: white at 12% on the green, which reads as a control
    without becoming a third button competing with the provider below. */
const SKIP_FACE = 'rgba(255, 255, 255, 0.12)';

export default function WelcomeScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { withGoogle, withApple } = useAuth();
  const canGoBack = router.canGoBack();

  // The same busy/error pair the auth sheet keeps: one provider round-trip at a
  // time, and whatever comes back said in words rather than in the SDK's.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<unknown>): void => {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (caught) {
        setError(
          friendlyError(
            caught,
            t.signIn.couldNotSignIn,
            'auth.signIn',
            t.misc.connectionProblem,
            t.misc.tooManyTries,
          ),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  // Apple leads on iOS — its guidelines want it at least as prominent as the
  // alternatives, and App Store guideline 4.8 requires it beside Google there.
  // Google leads everywhere else, where Apple is only a browser fallback.
  const appleFirst = Platform.OS === 'ios';

  const googleTile = (
    <SocialTile
      key="google"
      testID="auth-google"
      provider="google"
      field="brand"
      accessibilityLabel={t.signIn.continueGoogle}
      caption={t.signIn.providerGoogle}
      disabled={busy}
      onPress={() => run(withGoogle)}
    />
  );
  const appleTile = (
    <SocialTile
      key="apple"
      testID="auth-apple"
      provider="apple"
      field="brand"
      accessibilityLabel={t.signIn.continueApple}
      caption={t.signIn.providerApple}
      disabled={busy}
      onPress={() => run(withApple)}
    />
  );

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient
        colors={GATEWAY_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={{ flex: 1 }}
      >
        {/* Slow, soft waves drifting on the field behind everything — depth, not
            decoration you look at. Under the content and untouchable. */}
        <GatewayBackdrop />
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
          {/* The header: back when there is somewhere to go back to, otherwise
              the language globe; and Skip, which is the guest way in. */}
          <Row
            style={{
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: theme.spacing.sm,
            }}
          >
            {canGoBack ? (
              <HeaderGlyph
                label={t.common.back}
                icon={directionalIcon('chevron-back')}
                onPress={() => router.back()}
              />
            ) : (
              <HeaderGlyph
                label={t.language}
                icon="globe-outline"
                onPress={() => router.push('/language')}
              />
            )}
            <Pressable
              testID="welcome-skip"
              accessibilityRole="button"
              accessibilityLabel={t.common.skip}
              onPress={() => router.push('/guest-welcome')}
              hitSlop={8}
              style={({ pressed }) => ({
                height: 44,
                paddingHorizontal: theme.spacing.lg,
                borderRadius: theme.radius.pill,
                backgroundColor: SKIP_FACE,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text variant="subheading" style={{ color: theme.color.onBrand, fontWeight: '700' }}>
                {t.common.skip}
              </Text>
            </Pressable>
          </Row>

          {/* The hero rides in the upper third: a small brand tag, the headline
              that says what the app is for, and one line under it. */}
          <View style={{ flex: 0.5 }} />
          <View style={{ paddingHorizontal: theme.spacing.xxl, gap: theme.spacing.sm }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: theme.color.onBrand }}>
              {t.common.appName}
            </Text>
            <Text
              style={{
                fontSize: 38,
                lineHeight: 44,
                fontWeight: '800',
                letterSpacing: -1,
                color: theme.color.onBrand,
              }}
            >
              {t.signIn.splitAnything}
            </Text>
            <Text variant="body" style={{ color: theme.color.onBrand, opacity: 0.85 }}>
              {t.signIn.welcomeBody}
            </Text>
          </View>
          <View style={{ flex: 1 }} />

          {/* The ways in, anchored to the bottom: the legal line, one primary
              provider, the rest as tiles, and the way back for a member. */}
          <View
            style={{
              paddingHorizontal: theme.spacing.xxl,
              paddingBottom: theme.spacing.xl,
              gap: theme.spacing.md,
            }}
          >
            {error ? <Callout tone="negative">{error}</Callout> : null}

            <LegalLine
              textStyle={{
                color: theme.color.onBrand,
                opacity: 0.95,
                lineHeight: 20,
                marginBottom: theme.spacing.xs,
              }}
            />

            <ProviderButton
              testID="welcome-provider"
              provider={appleFirst ? 'apple' : 'google'}
              label={appleFirst ? t.signIn.continueApple : t.signIn.continueGoogle}
              disabled={busy}
              onPress={() => run(appleFirst ? withApple : withGoogle)}
            />

            <Row
              style={{
                justifyContent: 'center',
                gap: theme.spacing.xxl,
                marginTop: theme.spacing.sm,
              }}
            >
              {appleFirst ? googleTile : appleTile}
              <SocialTile
                testID="auth-phone"
                provider="phone"
                field="brand"
                accessibilityLabel={t.signIn.continuePhone}
                caption={t.signIn.providerPhone}
                disabled={busy}
                onPress={() => router.push('/phone')}
              />
              <SocialTile
                testID="auth-email"
                provider="email"
                field="brand"
                accessibilityLabel={t.signIn.continueEmail}
                caption={t.signIn.providerEmail}
                disabled={busy}
                onPress={() => router.push('/sign-up')}
              />
            </Row>

            <Row
              style={{
                justifyContent: 'center',
                alignItems: 'center',
                gap: theme.spacing.xs,
                marginTop: theme.spacing.sm,
              }}
            >
              <Text variant="body" style={{ color: theme.color.onBrand, opacity: 0.85 }}>
                {t.signIn.haveAccountPrompt}
              </Text>
              <Pressable
                testID="welcome-sign-in"
                accessibilityRole="button"
                accessibilityLabel={t.signIn.signInAction}
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => router.push('/sign-in')}
                hitSlop={8}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <Text variant="body" style={{ color: theme.color.onBrand, fontWeight: '700' }}>
                  {t.signIn.signInAction}
                </Text>
              </Pressable>
            </Row>
          </View>
        </SafeAreaView>
      </LinearGradient>
    </View>
  );
}

/** A 44pt header glyph on the brand field — back, or the language globe. */
function HeaderGlyph({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={12}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.lg} color={theme.color.onBrand} />
    </Pressable>
  );
}

/**
 * The moving field behind the door: sine waves flowing across the lower
 * half of the green, stacked so they overlap into a gentle current. It is
 * depth rather than a thing to watch — low-contrast and slow.
 *
 * The trick that keeps it cheap: each wave's path is one full period drawn
 * twice across double the screen width, so sliding it left by exactly one
 * screen width lands on an identical crest. Only that one `translateX` animates
 * — never the SVG path, which would cost a redraw every frame — and it loops
 * seamlessly. Motion-gated: with animation off the waves are still drawn (the
 * flat wash gets its shape) but hold still.
 */
const WAVES = [
  { amplitude: 0.05, baseline: 0.62, color: '#FFFFFF14', seconds: 9 },
  { amplitude: 0.07, baseline: 0.72, color: '#4F9A2E4D', seconds: 13 },
  { amplitude: 0.06, baseline: 0.82, color: '#FFFFFF12', seconds: 17 },
] as const;

/**
 * One full sine period across `width`, drawn twice to span `2 * width`, then
 * closed down to `bottom` so it fills as a solid band. Sampled, not curved —
 * enough points that the straight segments read as a smooth wave.
 */
function wavePath(width: number, amplitude: number, midY: number, bottom: number): string {
  const total = width * 2;
  const steps = 48;
  let d = `M 0 ${midY.toFixed(1)}`;
  for (let i = 1; i <= steps; i++) {
    const x = (total / steps) * i;
    // Wavelength = width, so the crest at x = width matches the one at x = 0.
    const y = midY + amplitude * Math.sin((x / width) * 2 * Math.PI);
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${d} L ${total.toFixed(1)} ${bottom.toFixed(1)} L 0 ${bottom.toFixed(1)} Z`;
}

function GatewayBackdrop() {
  const { width, height } = useWindowDimensions();

  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {WAVES.map((wave, index) => (
        <Wave
          key={index}
          width={width}
          height={height}
          amplitude={wave.amplitude * height}
          baseline={wave.baseline * height}
          color={wave.color}
          durationMs={wave.seconds * 1000}
        />
      ))}
    </View>
  );
}

function Wave({
  width,
  height,
  amplitude,
  baseline,
  color,
  durationMs,
}: {
  width: number;
  height: number;
  amplitude: number;
  baseline: number;
  color: string;
  durationMs: number;
}) {
  // 0 → 1 mapped to a slide of one screen width. Linear and repeated, so the
  // seam where the path repeats passes without a pause.
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: durationMs, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [durationMs, progress]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: -width * progress.value }],
  }));

  const d = wavePath(width, amplitude, baseline, height);

  return (
    <Animated.View
      style={[{ position: 'absolute', left: 0, top: 0, width: width * 2, height }, style]}
    >
      <Svg width={width * 2} height={height}>
        <Path d={d} fill={color} />
      </Svg>
    </Animated.View>
  );
}
