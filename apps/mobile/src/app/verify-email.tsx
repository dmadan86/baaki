/**
 * Verify your email — a six-digit code, the same shape as the phone screen.
 *
 * A fresh email sign-up gets a code (Supabase sends it when the confirmation
 * template carries `{{ .Token }}`); `withPassword` reports the case and the
 * form sends the person here with their address. They type the code, it is
 * checked with `verifyOtp`, and the session that appears bounces the whole tree
 * into the app via the auth gate — `verify-email` counts as an auth route for
 * exactly that reason, so there is nothing to navigate by hand.
 *
 * Resend is rate-limited the way the references do it: a 60-second countdown
 * before it lights up, and at most three requests before it stops offering —
 * a spam-and-cost guard, not a punishment, so the copy stays gentle.
 *
 * The copy is translated (see `t.entry`); only the `__DEV__` code hint stays
 * hardcoded, since it never reaches a release build.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Callout, directionalIcon, iconSize, Row, Screen, Text, useTheme } from '@waves/ui';

import { OtpInput, OTP_LEN } from '@/components/OtpInput';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

/** Seconds to wait before resend lights up, and how many times it may be used. */
const RESEND_SECONDS = 60;
const MAX_RESENDS = 3;

export default function VerifyEmailScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const { continueAsGuest } = useAuth();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = typeof params.email === 'string' ? params.email : '';

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(RESEND_SECONDS);
  const [resends, setResends] = useState(0);

  // DEV-ONLY: real email OTP is not wired yet, so a dev build accepts one fixed
  // code and stands in a guest session so the app is walkable. `__DEV__` is
  // false in every release build, so none of this ships.
  const DEV_OTP = '000000';
  const devStub = __DEV__;

  // One ticking countdown for the whole screen; it settles at zero and a resend
  // winds it back up. A single interval, not one per second.
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, []);

  const onBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/sign-up');
  };

  const onVerify = (): void =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        // Dev build: the fixed code takes a guest session so the app is walkable
        // until real email OTP is wired. Never in release.
        if (devStub && code === DEV_OTP) {
          await continueAsGuest();
          return;
        }
        const { error: verifyError } = await supabase.auth.verifyOtp({
          email,
          token: code,
          type: 'signup',
        });
        if (verifyError) throw verifyError;
        // The session the client now holds fires the auth listener; the gate
        // takes it from here into the app.
      } catch (caught) {
        setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.verifyEmail'));
      } finally {
        setBusy(false);
      }
    })();

  const canResend = seconds <= 0 && resends < MAX_RESENDS && !busy && Boolean(email);

  const onResend = (): void =>
    void (async () => {
      if (!canResend) return;
      setBusy(true);
      setError(null);
      try {
        const { error: resendError } = await supabase.auth.resend({ type: 'signup', email });
        if (resendError) throw resendError;
        setResends((r) => r + 1);
        setSeconds(RESEND_SECONDS);
      } catch (caught) {
        setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.verifyEmail'));
      } finally {
        setBusy(false);
      }
    })();

  return (
    <Screen edges={['top', 'bottom']}>
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: insets.bottom + theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={12}
            onPress={onBack}
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
        </Row>

        <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
          <View
            style={{
              width: 96,
              height: 96,
              borderRadius: 48,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.brandSoft,
            }}
          >
            <Ionicons name="mail-unread-outline" size={44} color={theme.color.brand} />
          </View>
          <Text
            align="center"
            style={{
              fontSize: 30,
              lineHeight: 38,
              fontWeight: '800',
              letterSpacing: -0.5,
              color: theme.color.text,
            }}
          >
            {t.entry.emailCodeTitle}
          </Text>
          <Text variant="body" tone="muted" align="center">
            {email
              ? t.entry.emailCodeBody.replace('{email}', email)
              : t.entry.checkInboxBodyNoEmail}
          </Text>
        </View>

        <OtpInput
          value={code}
          onChangeText={setCode}
          length={OTP_LEN}
          accessibilityLabel={t.contact.verificationCode}
          autoFocus
        />

        {/* Resend: a countdown, then a live link, then — after three — a note
            that the road runs out, gently. */}
        <View style={{ alignItems: 'center', minHeight: 24 }}>
          {seconds > 0 ? (
            <Text variant="caption" tone="muted">
              {t.entry.resendIn.replace('{seconds}', String(seconds))}
            </Text>
          ) : resends < MAX_RESENDS ? (
            <Pressable
              accessibilityRole="button"
              disabled={!canResend}
              hitSlop={8}
              onPress={onResend}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.xs,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Ionicons name="refresh" size={iconSize.md} color={theme.color.brand} />
              <Text style={{ fontWeight: '700', color: theme.color.brand }}>
                {t.entry.resendCode}
              </Text>
            </Pressable>
          ) : (
            <Text variant="caption" tone="muted" align="center">
              {t.entry.resendLimit}
            </Text>
          )}
          {devStub ? (
            <Text variant="micro" tone="muted" style={{ marginTop: theme.spacing.xs }}>
              Dev build — enter {DEV_OTP} to continue.
            </Text>
          ) : null}
        </View>

        {error ? <Callout tone="negative">{error}</Callout> : null}

        <View style={{ flex: 1 }} />

        <Button
          label={t.signIn.verify}
          size="lg"
          fullWidth
          disabled={busy || code.length !== OTP_LEN}
          onPress={onVerify}
        />
        {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
      </View>
    </Screen>
  );
}
