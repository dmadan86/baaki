/**
 * The guest doorway — one screen between "continue as guest" and the app.
 *
 * ADR-006 keeps registration optional, so a guest is a real, usable session
 * from the first tap. This screen is not a gate in front of that; it is the one
 * beat that says what "guest" means here — start now, nothing is lost, set up
 * whenever — the way the reference greets a new account before it opens.
 *
 * It is public (no session yet): the guest is minted by the Continue button,
 * not before it. So there is no race with the auth gate — tapping Continue calls
 * `continueAsGuest`, a session appears, and the gate takes it from here into the
 * app. Backing out returns to the sign-up door with nothing created.
 *
 * A deliberately dark field with its own palette, not the app's theme: this is a
 * front-of-house screen, like the splash and the gateway, and it reads as one.
 *
 * The copy is translated (see `t.entry`); the title's app name is tinted
 * wherever the translation places it.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Button, Callout, directionalIcon, iconSize, Text, useTheme } from '@waves/ui';

import { LegalLine } from '@/components/LegalLine';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

/** The screen's own dark-green field and the light on it — a front-of-house
    palette, held apart from the app theme on purpose. */
const FIELD = '#14240D';
const SUN = '#EAF7DF';
const HILL_NEAR = '#2E5A1E';
const HILL_FAR = '#24451A';
const RAY = '#EAF7DF';

/** The placeholder in `entry.guestIntroTitle` where the app name is tinted. */
const APP_TOKEN = '{app}';

export default function GuestWelcomeScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { continueAsGuest } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The title with the app name split out, so it can be tinted wherever the
  // translation places it. `split` with a captured group keeps the token.
  const titleParts = t.entry.guestIntroTitle.split(/(\{app\})/);

  const onContinue = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // The guest is made here. The session appearing sends the auth gate to
      // the dashboard, so there is nothing to navigate by hand.
      await continueAsGuest();
    } catch (caught) {
      setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.guest'));
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: FIELD }}>
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <View
          style={{
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: theme.spacing.sm,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={12}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/sign-up'))}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons name={directionalIcon('chevron-back')} size={iconSize.lg} color="#FFFFFF" />
          </Pressable>
        </View>

        <View style={{ flex: 1, paddingHorizontal: theme.spacing.xxxl }}>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 36 }}>
            <SunriseArt />
            <View style={{ gap: theme.spacing.md }}>
              {/* The app name is highlighted in brand wherever it falls in the
                  translated title — split on the {app} placeholder so the accent
                  survives word-order differences across languages. */}
              <Text align="center" style={{ fontSize: 30, lineHeight: 38, fontWeight: '800' }}>
                {titleParts.map((part, index) =>
                  part === APP_TOKEN ? (
                    <Text
                      key={index}
                      style={{
                        color: theme.color.brand,
                        fontSize: 30,
                        lineHeight: 38,
                        fontWeight: '800',
                      }}
                    >
                      {t.common.appName}
                    </Text>
                  ) : (
                    <Text
                      key={index}
                      style={{ color: '#FFFFFF', fontSize: 30, lineHeight: 38, fontWeight: '800' }}
                    >
                      {part}
                    </Text>
                  ),
                )}
              </Text>
              <Text align="center" style={{ color: '#FFFFFFCC', fontSize: 16, lineHeight: 24 }}>
                {t.entry.guestIntroBody}
              </Text>
            </View>
          </View>

          {error ? <Callout tone="negative">{error}</Callout> : null}

          <View style={{ paddingBottom: theme.spacing.xl, gap: theme.spacing.md }}>
            <LegalLine textStyle={{ color: '#FFFFFF80', fontSize: 12, lineHeight: 18 }} />
            <Button
              label={t.entry.continueLabel}
              variant="brand"
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => void onContinue()}
            />
            {busy ? <ActivityIndicator color="#FFFFFF" /> : null}
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

/** A sun rising over layered hills — a small hand-drawn hero on the dark field,
    echoing the reference. Static: it is a picture, not a thing to watch. */
function SunriseArt() {
  const size = 220;
  const cx = size / 2;
  const horizon = 150;
  const rays = Array.from({ length: 9 }, (_, i) => {
    const angle = Math.PI - (Math.PI / 8) * i; // 180° → 0°, above the horizon
    const inner = 58;
    const outer = 82;
    return {
      x1: cx + inner * Math.cos(angle),
      y1: horizon + inner * Math.sin(angle) * -1,
      x2: cx + outer * Math.cos(angle),
      y2: horizon + outer * Math.sin(angle) * -1,
    };
  });

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {rays.map((ray, i) => (
        <Line
          key={i}
          x1={ray.x1}
          y1={ray.y1}
          x2={ray.x2}
          y2={ray.y2}
          stroke={RAY}
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.75}
        />
      ))}
      <Circle cx={cx} cy={horizon} r={40} fill={SUN} />
      {/* Far hill, then the near one over it and the sun's foot. */}
      <Path
        d={`M0 ${horizon + 6} Q70 ${horizon - 34} 150 ${horizon + 2} T${size} ${horizon - 2}
               L${size} ${size} L0 ${size} Z`}
        fill={HILL_FAR}
      />
      <Path
        d={`M0 ${horizon + 30} Q60 ${horizon - 4} 130 ${horizon + 26} T${size} ${horizon + 20}
               L${size} ${size} L0 ${size} Z`}
        fill={HILL_NEAR}
      />
    </Svg>
  );
}
