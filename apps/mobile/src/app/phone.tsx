/**
 * Continue with phone — a screen of its own, not a face of the auth card.
 *
 * "Continue with phone" on either door used to swap the card underneath for a
 * number field. It is a page now, the way the reference onboardings do it: one
 * question per screen, a heading that says what this step is, the field, and the
 * action pinned to the foot. Enter the number, then the same screen turns to the
 * code it sent — a back chevron steps between the two, then out to the door.
 *
 * Public (see `_layout`): reachable signed-out, from both `sign-in` and
 * `sign-up`. It does not care which — `sendOtp`/`verifyOtp` are the same call
 * either way, and a session appearing bounces the whole tree into the app, so
 * there is nothing here to branch on the errand. A guest attaching a number
 * lands here too; the OTP path adds the number to the account they already have.
 *
 * The copy is translated (see `t.entry`); only the `__DEV__` OTP hint stays
 * hardcoded, since it never reaches a release build.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  Callout,
  Card,
  directionalIcon,
  iconSize,
  Row,
  Screen,
  Text,
  useTheme,
} from '@waves/ui';

import { dialingCodeForCountry } from '@waves/core';

import { CountryCodePicker } from '@/components/CountryCodePicker';
import { OtpInput, OTP_LEN } from '@/components/OtpInput';

/** Matches the email code screen, so the two waits feel like one product. */
const RESEND_SECONDS = 60;
/** Four codes a number a day is the server's rule; three from one sitting
    leaves the person a fourth after they have gone away and come back. */
const MAX_RESENDS = 3;
import { deviceCountry, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

export default function PhoneScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const { sendOtp, verifyOtp, continueAsGuest } = useAuth();

  // Same guess as the auth card: the handset's own country, India only when the
  // region is unknown or unstocked. The picker beside the field makes any wrong
  // guess a one-tap fix.
  const [country, setCountry] = useState<string>(() => {
    const guess = deviceCountry();
    return guess && dialingCodeForCountry(guess) ? guess : 'IN';
  });
  const dialCode = dialingCodeForCountry(country) ?? '+91';

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The wire form: dial code and local digits, no spaces or punctuation.
  const fullPhone = `${dialCode}${phone.replace(/\D/g, '')}`;

  // DEV-ONLY: real SMS is not wired yet, so a dev build skips the send and
  // accepts one fixed code, standing in a guest session so the app is walkable.
  // `__DEV__` is false in every release build, so none of this ships — a client
  // that accepted a magic code in production would be an auth bypass.
  const DEV_OTP = '000000';
  // A dev build stubs the send by default, because there is usually no Twilio
  // account behind it and a walkable app matters more than a real message.
  // Setting `EXPO_PUBLIC_DEV_REAL_OTP=true` takes the stub away and exercises
  // the actual WhatsApp path — the same code a release build runs.
  //
  // The guard stays anchored on `__DEV__`, so the flag cannot resurrect the
  // magic code in a release build however the environment is set: there,
  // `devStub` is false whatever this evaluates to, and a client that accepted
  // a fixed code in production would be an auth bypass.
  const devStub = __DEV__ && process.env.EXPO_PUBLIC_DEV_REAL_OTP !== 'true';

  // The same cool-down the email code screen uses. It is not decoration here:
  // the server allows four codes to a number a day, so a resend that can be
  // hammered spends the person's own daily allowance before they notice.
  const [seconds, setSeconds] = useState(RESEND_SECONDS);
  const [resends, setResends] = useState(0);

  // One interval for the screen, settling at zero; a resend winds it back up.
  useEffect(() => {
    if (stage !== 'code') return;
    const id = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [stage]);

  const canResend = seconds <= 0 && resends < MAX_RESENDS && !busy && !devStub;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.phone'));
    } finally {
      setBusy(false);
    }
  };

  // Back steps the code stage to the number first, then leaves the screen.
  const onBack = (): void => {
    if (stage === 'code') {
      setStage('phone');
      setCode('');
      setError(null);
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/welcome');
  };

  return (
    <Screen edges={['top', 'bottom']} style={{ backgroundColor: theme.color.brand }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: insets.bottom + theme.spacing.xl,
            gap: theme.spacing.xl,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Back on the left, in the primary ink — steps to the number from the
              code, then out to the door. */}
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
                color={theme.color.onBrand}
              />
            </Pressable>
          </Row>

          {stage === 'phone' ? (
            <>
              <View style={{ gap: theme.spacing.sm }}>
                <Text
                  style={{
                    fontSize: 30,
                    lineHeight: 38,
                    fontWeight: '800',
                    letterSpacing: -0.5,
                    color: theme.color.onBrand,
                  }}
                >
                  {t.entry.verifyPhoneTitle}
                </Text>
                <Text variant="body" tone="onBrand" style={{ opacity: 0.9 }}>
                  {t.entry.verifyPhoneBody}
                </Text>
              </View>

              {/* The field as a filled card — a label above the value, the way
                  the reference lays its inputs out. The country is a tapped
                  control, so the field beside it holds the local digits alone. */}
              <Card style={{ gap: theme.spacing.xs }}>
                <Text variant="caption" tone="muted">
                  {t.signIn.phoneNumber}
                </Text>
                <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                  <CountryCodePicker code={country} onChange={setCountry} />
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    autoFocus
                    accessibilityLabel={t.signIn.phoneNumber}
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      flex: 1,
                      fontSize: 22,
                      fontWeight: '600',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                </Row>
              </Card>
              {error ? <Callout tone="negative">{error}</Callout> : null}

              {/* The action pinned to the foot: a spacer eats the middle so it
                  sits at the bottom on a tall screen and scrolls up with the
                  keyboard on a short one. */}
              <View style={{ flex: 1 }} />
              <Button
                label={t.signIn.sendCode}
                size="lg"
                fullWidth
                disabled={busy || phone.replace(/\D/g, '').length < 6}
                onPress={() =>
                  void run(async () => {
                    // Dev build: no SMS to send — go straight to the code field,
                    // where 000000 stands in.
                    if (!devStub) await sendOtp(fullPhone);
                    setSeconds(RESEND_SECONDS);
                    setStage('code');
                  })
                }
              />
              {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
            </>
          ) : (
            <>
              {/* The heading says what to do; the number it went to is the
                  answer to "which number?" and belongs under it, not as the
                  title. A long number set as a 30pt heading wraps to three
                  lines and buries the instruction. */}
              <View style={{ gap: theme.spacing.sm }}>
                <Text
                  style={{
                    fontSize: 30,
                    lineHeight: 38,
                    fontWeight: '800',
                    letterSpacing: -0.5,
                    color: theme.color.onBrand,
                  }}
                >
                  {t.signIn.enterCodeTitle}
                </Text>
                <Text variant="body" tone="onBrand" style={{ opacity: 0.9 }}>
                  {t.signIn.codeSentTo.replace('{value}', `${dialCode} ${phone}`)}
                </Text>
                {/* Mistyping the number is the likeliest reason nothing came,
                    so the way back to it sits with the number itself rather
                    than behind the back chevron. */}
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={onBack}
                  style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}
                >
                  <Text
                    style={{
                      fontWeight: '700',
                      color: theme.color.onBrand,
                      textDecorationLine: 'underline',
                    }}
                  >
                    {t.signIn.differentNumber}
                  </Text>
                </Pressable>
                {devStub ? (
                  <Text variant="micro" tone="onBrand" style={{ opacity: 0.85 }}>
                    Dev build — enter {DEV_OTP} to continue.
                  </Text>
                ) : null}
              </View>

              <OtpInput
                value={code}
                onChangeText={setCode}
                length={OTP_LEN}
                accessibilityLabel={t.contact.verificationCode}
                autoFocus
              />

              {/* Countdown, then a live link, then the note that the road runs
                  out — the same three states as the email code screen. The
                  fixed height keeps the boxes still as it changes. */}
              <View style={{ alignItems: 'center', minHeight: 24 }}>
                {seconds > 0 ? (
                  <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
                    {t.signIn.resendIn.replace('{s}', String(seconds))}
                  </Text>
                ) : resends < MAX_RESENDS ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={!canResend}
                    hitSlop={8}
                    onPress={() =>
                      void run(async () => {
                        await sendOtp(fullPhone);
                        setResends((n) => n + 1);
                        setSeconds(RESEND_SECONDS);
                      })
                    }
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.xs,
                      opacity: pressed || !canResend ? 0.6 : 1,
                    })}
                  >
                    <Ionicons name="refresh" size={iconSize.md} color={theme.color.onBrand} />
                    <Text style={{ fontWeight: '700', color: theme.color.onBrand }}>
                      {t.entry.resendCode}
                    </Text>
                  </Pressable>
                ) : (
                  <Text variant="caption" tone="onBrand" style={{ opacity: 0.85 }}>
                    {t.entry.resendLimit}
                  </Text>
                )}
              </View>

              {error ? <Callout tone="negative">{error}</Callout> : null}

              <View style={{ flex: 1 }} />
              <Button
                label={t.signIn.verify}
                size="lg"
                fullWidth
                disabled={busy || code.length !== OTP_LEN}
                onPress={() =>
                  void run(async () => {
                    // Dev build: the fixed code takes a guest session so the app
                    // is walkable until real phone OTP is wired. Never in release.
                    if (devStub && code.trim() === DEV_OTP) {
                      await continueAsGuest();
                      return;
                    }
                    await verifyOtp(fullPhone, code.trim());
                  })
                }
              />
              {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
